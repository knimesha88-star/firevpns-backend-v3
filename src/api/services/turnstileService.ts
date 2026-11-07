import crypto from 'crypto';
import { Request } from 'express';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 8000;
const TOKEN_MAX_AGE_MS = 5 * 60 * 1000; // Cloudflare Turnstile tokens expire after 300 seconds (5 minutes)
const CONSUMED_TOKEN_TTL_MS = 10 * 60 * 1000; // Keep consumed token hashes for 10 minutes to prevent replay

// In-memory replay protection (stores SHA-256 hashes of tokens, never raw secrets)
const consumedTokenHashes = new Map<string, number>();
const inFlightTokenHashes = new Set<string>();

export interface TurnstileVerificationResult {
  valid: boolean;
  statusCode: number;
  error?: string;
  code?: string;
  errorCodes?: string[];
  hostname?: string;
  challengeTs?: string;
  action?: string;
}

export interface VerifyTurnstileOptions {
  secretKey?: string;
  allowedHostnames?: string[];
  siteverifyUrl?: string;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function cleanupExpiredTokenHashes(): void {
  const now = Date.now();
  if (consumedTokenHashes.size > 2000) {
    for (const [hash, expiresAt] of consumedTokenHashes.entries()) {
      if (expiresAt <= now) {
        consumedTokenHashes.delete(hash);
      }
    }
  }
}

export function getAllowedHostnames(overrideHostnames?: string[]): string[] {
  if (overrideHostnames && overrideHostnames.length > 0) {
    return overrideHostnames.map((h) => h.trim().toLowerCase()).filter(Boolean);
  }
  const raw = process.env.TURNSTILE_ALLOWED_HOSTNAME || 'firevpnsvip.qzz.io';
  const parsed = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : ['firevpnsvip.qzz.io'];
}

export function extractTurnstileToken(req: Request): string | null {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const candidates = [
    body.turnstileToken,
    body.captchaToken,
    body['cf-turnstile-response'],
    body.token,
    req.headers['cf-turnstile-response'],
    req.headers['x-turnstile-token'],
    req.headers['x-captcha-token'],
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

export function extractClientIp(req: Request): string | undefined {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) {
    return cfIp.trim();
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (typeof req.ip === 'string' && req.ip.trim()) {
    return req.ip.trim();
  }
  return undefined;
}

export async function verifyTurnstileToken(
  token: unknown,
  remoteIp?: string,
  options?: VerifyTurnstileOptions
): Promise<TurnstileVerificationResult> {
  // 1. Validate token presence and format
  if (typeof token !== 'string' || token.trim().length === 0) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Security verification (CAPTCHA) token is required. Please complete the challenge and try again.',
      code: 'TURNSTILE_TOKEN_MISSING',
    };
  }

  const trimmedToken = token.trim();
  if (trimmedToken.length > 4096) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Invalid security verification token format.',
      code: 'TURNSTILE_INVALID_TOKEN',
    };
  }

  cleanupExpiredTokenHashes();
  const tokenHash = hashToken(trimmedToken);
  const now = Date.now();

  // 2. Reject reused or concurrently re-submitted tokens immediately (never verify a token twice)
  const existingExpiry = consumedTokenHashes.get(tokenHash);
  if ((existingExpiry && existingExpiry > now) || inFlightTokenHashes.has(tokenHash)) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Security verification token has already been used or expired. Please complete the CAPTCHA again.',
      code: 'TURNSTILE_TOKEN_REUSED',
    };
  }

  // 3. Check secret key configuration (fail closed if missing)
  const secretKey = (options?.secretKey ?? process.env.TURNSTILE_SECRET_KEY ?? '').trim();
  if (!secretKey) {
    console.error('[Turnstile] Verification failed closed: TURNSTILE_SECRET_KEY is not configured on the server.');
    return {
      valid: false,
      statusCode: 503,
      error: 'Security verification service is unavailable. Please try again later.',
      code: 'TURNSTILE_UNAVAILABLE',
    };
  }

  inFlightTokenHashes.add(tokenHash);

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', trimmedToken);
    if (remoteIp) {
      formData.append('remoteip', remoteIp);
    }
    formData.append('idempotency_key', crypto.randomUUID());

    const verifyUrl = options?.siteverifyUrl || SITEVERIFY_URL;
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`[Turnstile] Cloudflare Siteverify returned HTTP ${response.status}`);
      return {
        valid: false,
        statusCode: 503,
        error: 'Security verification service is temporarily unavailable. Please try again.',
        code: 'TURNSTILE_VERIFICATION_UNAVAILABLE',
      };
    }

    const data: any = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      console.error('[Turnstile] Cloudflare Siteverify returned invalid JSON');
      return {
        valid: false,
        statusCode: 503,
        error: 'Security verification service returned an unexpected response. Please try again.',
        code: 'TURNSTILE_VERIFICATION_UNAVAILABLE',
      };
    }

    const errorCodes: string[] = Array.isArray(data['error-codes']) ? data['error-codes'] : [];

    if (data.success !== true) {
      // Mark token hash as consumed so invalid/expired tokens are never sent to Siteverify a second time
      consumedTokenHashes.set(tokenHash, Date.now() + CONSUMED_TOKEN_TTL_MS);

      if (errorCodes.includes('missing-input-secret') || errorCodes.includes('invalid-input-secret')) {
        console.error('[Turnstile] Cloudflare Siteverify reported secret configuration error.');
        return {
          valid: false,
          statusCode: 503,
          error: 'Security verification service is misconfigured. Please contact support.',
          code: 'TURNSTILE_CONFIGURATION_ERROR',
          errorCodes,
        };
      }

      if (errorCodes.includes('timeout-or-duplicate')) {
        return {
          valid: false,
          statusCode: 400,
          error: 'Security verification expired or was already used. Please complete the CAPTCHA again.',
          code: 'TURNSTILE_TOKEN_EXPIRED_OR_DUPLICATE',
          errorCodes,
        };
      }

      if (errorCodes.includes('invalid-input-response') || errorCodes.includes('missing-input-response')) {
        return {
          valid: false,
          statusCode: 400,
          error: 'Invalid security verification token. Please complete the CAPTCHA and try again.',
          code: 'TURNSTILE_INVALID_TOKEN',
          errorCodes,
        };
      }

      return {
        valid: false,
        statusCode: 400,
        error: 'Security verification failed. Please complete the CAPTCHA and try again.',
        code: 'TURNSTILE_VERIFICATION_FAILED',
        errorCodes,
      };
    }

    // Consume the token immediately upon Siteverify response so it can never be reused
    consumedTokenHashes.set(tokenHash, Date.now() + CONSUMED_TOKEN_TTL_MS);

    // 4. Verify hostname matches firevpnsvip.qzz.io (or configured TURNSTILE_ALLOWED_HOSTNAME)
    const allowedHostnames = getAllowedHostnames(options?.allowedHostnames);
    const verifiedHostname = String(data.hostname || '').trim().toLowerCase();

    if (!verifiedHostname || !allowedHostnames.includes(verifiedHostname)) {
      console.warn(
        `[Turnstile] Hostname mismatch: token hostname '${verifiedHostname || '(empty)'}' not in allowed list [${allowedHostnames.join(', ')}]`
      );
      return {
        valid: false,
        statusCode: 403,
        error: 'Security verification failed: unauthorized hostname.',
        code: 'TURNSTILE_HOSTNAME_MISMATCH',
        hostname: verifiedHostname,
      };
    }

    // 5. Verify challenge timestamp age (reject expired tokens > 5 minutes old)
    if (data.challenge_ts) {
      const challengeTimeMs = new Date(data.challenge_ts).getTime();
      if (!isNaN(challengeTimeMs) && Date.now() - challengeTimeMs > TOKEN_MAX_AGE_MS) {
        return {
          valid: false,
          statusCode: 400,
          error: 'Security verification token has expired. Please complete the CAPTCHA again.',
          code: 'TURNSTILE_TOKEN_EXPIRED',
          hostname: verifiedHostname,
          challengeTs: data.challenge_ts,
        };
      }
    }

    return {
      valid: true,
      statusCode: 200,
      hostname: verifiedHostname,
      challengeTs: data.challenge_ts,
      action: data.action,
    };
  } catch (err: any) {
    // Fail closed if Siteverify is unreachable or times out
    console.error('[Turnstile] Verification failed closed due to network/timeout error:', err?.message || err);
    return {
      valid: false,
      statusCode: 503,
      error: 'Security verification service is currently unreachable. Please try again.',
      code: 'TURNSTILE_VERIFICATION_UNAVAILABLE',
    };
  } finally {
    inFlightTokenHashes.delete(tokenHash);
  }
}
