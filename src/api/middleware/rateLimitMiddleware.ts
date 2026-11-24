import { Request, Response, NextFunction } from 'express';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, BucketEntry>();
let lastPruneAt = Date.now();

function getClientIp(req: Request): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) {
    return cfIp.trim();
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function pruneExpiredBuckets(now: number): void {
  if (now - lastPruneAt < 60_000 && buckets.size < 5000) return;
  lastPruneAt = now;
  for (const [key, entry] of buckets.entries()) {
    if (entry.resetAt <= now) {
      buckets.delete(key);
    }
  }
  // Safety cap against unbounded memory growth under DDoS
  if (buckets.size > 15_000) {
    buckets.clear();
  }
}

export function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, max, keyPrefix, message } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    pruneExpiredBuckets(now);

    const userId = (req as any).user?.uid;
    const identity = userId ? `uid:${userId}` : `ip:${getClientIp(req)}`;
    const bucketKey = `${keyPrefix}:${identity}`;

    let entry = buckets.get(bucketKey);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 1, resetAt: now + windowMs };
      buckets.set(bucketKey, entry);
    } else {
      entry.count += 1;
    }

    const remaining = Math.max(0, max - entry.count);
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(retryAfterSec));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        success: false,
        error:
          message ||
          `Too many requests. Please wait ${retryAfterSec} seconds before trying again.`,
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    next();
  };
}

export const generalApiRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyPrefix: 'api',
});

export const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyPrefix: 'auth',
  message: 'Too many authentication attempts. Please try again shortly.',
});

export const orderRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 15,
  keyPrefix: 'order',
  message: 'Too many order or renewal submissions. Please wait a few minutes.',
});

export const trialRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyPrefix: 'trial',
  message: 'Too many trial requests. Please wait before trying again.',
});

export const supportRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 25,
  keyPrefix: 'support',
  message: 'Too many support notification requests. Please slow down.',
});

export const webhookRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyPrefix: 'webhook',
});
