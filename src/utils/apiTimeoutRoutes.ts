export const BACKEND_EXTENDED_API_TIMEOUT_MS = 70000;
export const BACKEND_DEFAULT_API_TIMEOUT_MS = 25000;

const EXACT_EXTENDED_ADMIN_POST_PATHS = new Set<string>([
  '/admin/approve-order',
  '/admin/reject-order',
  '/admin/verify-payment',
  '/renew/orders',
  '/renew/request',
]);

const EXACT_EXTENDED_TELEGRAM_POST_PATHS = new Set<string>([
  '/telegram/webhook',
  '/telegram/callback',
]);

const EXACT_EXTENDED_ADMIN_POST_PATTERNS: RegExp[] = [
  /^\/admin\/orders\/[^/]+\/approve$/,
  /^\/admin\/orders\/[^/]+\/reject$/,
  /^\/admin\/orders\/[^/]+\/verify-payment$/,
  /^\/renew\/approve\/[^/]+$/,
  /^\/renew\/reject\/[^/]+$/,
];

const EXACT_CLAIM_TRIAL_POST_PATTERNS: RegExp[] = [
  /^\/vpn\/claim-trial$/,
  /^\/client\/claim-trial$/,
  /^\/trial\/claim-trial$/,
  /^\/claim-trial$/,
];

function normalizeApiRoutePath(rawPath: string): string {
  let clean = String(rawPath || '').split('?')[0].trim();
  if (!clean.startsWith('/')) {
    clean = `/${clean}`;
  }
  if (clean.toLowerCase().startsWith('/api/')) {
    clean = clean.slice(4);
  } else if (clean.toLowerCase() === '/api') {
    clean = '/';
  }
  return clean.replace(/\/+$/, '') || '/';
}

/**
 * Matches ONLY the exact supported long-running POST API endpoints (admin order approval/rejection,
 * payment verification, renewal approval/rejection, trial approval/rejection, order/renewal creation,
 * trial claim, and supported Telegram webhook/callback POST endpoints). Avoids broad substring or
 * prefix matching and never extends timeouts for GET or unsupported methods.
 */
export function isExtendedTimeoutBackendApiRequest(method: string, path: string): boolean {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (normalizedMethod !== 'POST') {
    return false;
  }

  const normalizedPath = normalizeApiRoutePath(path);

  if (EXACT_EXTENDED_ADMIN_POST_PATHS.has(normalizedPath)) {
    return true;
  }

  if (EXACT_EXTENDED_TELEGRAM_POST_PATHS.has(normalizedPath)) {
    return true;
  }

  if (EXACT_EXTENDED_ADMIN_POST_PATTERNS.some((pattern) => pattern.test(normalizedPath))) {
    return true;
  }

  if (EXACT_CLAIM_TRIAL_POST_PATTERNS.some((pattern) => pattern.test(normalizedPath))) {
    return true;
  }

  return false;
}

export function getBackendApiTimeoutMs(method: string, path: string): number {
  return isExtendedTimeoutBackendApiRequest(method, path)
    ? BACKEND_EXTENDED_API_TIMEOUT_MS
    : BACKEND_DEFAULT_API_TIMEOUT_MS;
}
