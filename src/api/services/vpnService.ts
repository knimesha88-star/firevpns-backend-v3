import { supabase, supabaseAdmin, getSupabaseClient } from '../../lib/supabase.js';
import {
  getCachedInbounds,
  getLiveInbound,
  getInbounds,
  getInboundsSnapshotTimestamp,
  resetClientTraffic,
  parseInboundSettingsClientsStrict,
  verifyAndMarkClientDeletedIfConfirmed,
  isSafeToRestoreActiveStatus,
  getCurrentPanelIdentity,
  getClientTrafficMutationState,
  getTrafficMutationEpochSnapshot,
  notifyClientTrafficInvalidated,
  registerClientTrafficCacheInvalidator,
  unregisterClientTrafficCacheInvalidator,
  invalidateInboundCache,
  ClientTrafficMutationState,
  GetInboundsOptions,
  ResetClientTrafficOptions,
} from './xuiService.js';
import { createCustomerNotification } from './notificationService.js';
import crypto from 'crypto';

export const CLIENT_TRAFFIC_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes TTL (never extended on read)
export const CLIENT_TRAFFIC_CACHE_MAX_ENTRIES = 2000;
export const CUSTOMER_MY_CONFIGS_TOTAL_BUDGET_MS = 8500; // 8.5s total budget (leaves 6.5s margin below 15s frontend timeout)
export const CUSTOMER_MAX_COLD_START_WAIT_MS = 4500;
export const CUSTOMER_MAX_LIVE_INBOUND_WAIT_MS = 4000;

export interface CachedClientTrafficEntry {
  cacheKey: string;
  panelIdentity: string;
  userUid: string;
  clientUuid: string;
  up: number;
  down: number;
  total: number;
  expiryTime: number;
  lastOnline: number;
  updatedAtMs: number;
  mutationSeq: number;
}

const lastKnownClientTrafficByScope = new Map<string, CachedClientTrafficEntry>();

export const buildCustomerTrafficCacheKey = (params: {
  panelIdentity?: string | null;
  userUid?: string | null;
  clientUuid?: string | null;
  hasVerifiedOwnership?: boolean;
  recordPanelIdentity?: string | null;
}): string | null => {
  const panelId = String(params.panelIdentity || '').trim();
  const uid = String(params.userUid || '').trim();
  const uuid = String(params.clientUuid || '').trim().toLowerCase();
  if (!panelId || !uid || !uuid) return null;
  if (params.hasVerifiedOwnership === false) return null;
  const recPanel = String(params.recordPanelIdentity || '').trim();
  if (recPanel && recPanel !== panelId) {
    return null;
  }
  return `${panelId}::${uid}::${uuid}`;
};

const evictExpiredOrOverflowTrafficCacheEntries = (nowMs: number, maxEntries: number = CLIENT_TRAFFIC_CACHE_MAX_ENTRIES): void => {
  if (lastKnownClientTrafficByScope.size >= maxEntries) {
    for (const [k, entry] of Array.from(lastKnownClientTrafficByScope.entries())) {
      if (nowMs - entry.updatedAtMs > CLIENT_TRAFFIC_CACHE_TTL_MS) {
        lastKnownClientTrafficByScope.delete(k);
      }
    }
  }
  while (lastKnownClientTrafficByScope.size > maxEntries) {
    const oldestKey = lastKnownClientTrafficByScope.keys().next().value;
    if (oldestKey === undefined) break;
    lastKnownClientTrafficByScope.delete(oldestKey);
  }
};

const setScopedClientTrafficCacheEntry = (
  entry: CachedClientTrafficEntry,
  nowMs: number,
  maxEntries: number = CLIENT_TRAFFIC_CACHE_MAX_ENTRIES
): void => {
  if (lastKnownClientTrafficByScope.has(entry.cacheKey)) {
    lastKnownClientTrafficByScope.delete(entry.cacheKey);
  }
  lastKnownClientTrafficByScope.set(entry.cacheKey, entry);
  evictExpiredOrOverflowTrafficCacheEntries(nowMs, maxEntries);
};

const getScopedClientTrafficCacheEntry = (
  cacheKey: string | null,
  nowMs: number,
  expectedMutationSeq?: number,
  maxEvictedEpoch: number = 0,
  mutationStatePresent: boolean = false
): CachedClientTrafficEntry | undefined => {
  if (!cacheKey) return undefined;
  const entry = lastKnownClientTrafficByScope.get(cacheKey);
  if (!entry) return undefined;
  // Enforce strict TTL without extending updatedAtMs or refreshing insertion order on read
  if (nowMs - entry.updatedAtMs > CLIENT_TRAFFIC_CACHE_TTL_MS) {
    lastKnownClientTrafficByScope.delete(cacheKey);
    return undefined;
  }
  if (expectedMutationSeq !== undefined && entry.mutationSeq !== expectedMutationSeq) {
    return undefined;
  }
  // If mutation history was evicted and this entry's mutationSeq is at or below the eviction watermark,
  // do not trust stale cached traffic.
  if (!mutationStatePresent && maxEvictedEpoch > 0 && entry.mutationSeq <= maxEvictedEpoch) {
    lastKnownClientTrafficByScope.delete(cacheKey);
    return undefined;
  }
  return entry;
};

const purgeClientTrafficCacheByUuid = (clientUuid: string): void => {
  const normUuid = String(clientUuid || '').trim().toLowerCase();
  if (!normUuid) return;
  for (const [k, entry] of Array.from(lastKnownClientTrafficByScope.entries())) {
    if (entry.clientUuid === normUuid) {
      lastKnownClientTrafficByScope.delete(k);
    }
  }
};

registerClientTrafficCacheInvalidator((clientUuid, reason, state) => {
  if (reason === 'clear') {
    lastKnownClientTrafficByScope.clear();
    return;
  }
  const normUuid = String(clientUuid || '').trim().toLowerCase();
  if (!normUuid) return;
  if (reason === 'deleted') {
    purgeClientTrafficCacheByUuid(normUuid);
    return;
  }
  if (reason === 'reset') {
    for (const [k, entry] of Array.from(lastKnownClientTrafficByScope.entries())) {
      if (entry.clientUuid === normUuid) {
        lastKnownClientTrafficByScope.set(k, {
          ...entry,
          up: 0,
          down: 0,
          updatedAtMs: state.lastResetAtMs || Date.now(),
          mutationSeq: state.seq,
        });
      }
    }
  }
});

export const getLastKnownClientTrafficCacheStatsForTests = (): {
  size: number;
  keys: string[];
  entries: CachedClientTrafficEntry[];
} => ({
  size: lastKnownClientTrafficByScope.size,
  keys: Array.from(lastKnownClientTrafficByScope.keys()),
  entries: Array.from(lastKnownClientTrafficByScope.values()).map((e) => ({ ...e })),
});

export const resetLastKnownClientTrafficCacheForTests = (): void => {
  lastKnownClientTrafficByScope.clear();
};

const raceWithTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(null);
    }, Math.max(50, timeoutMs));
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export interface LegacyReconciliationRecord {
  uuid: string;
  orderId: string;
  missingFields: string[];
  source: 'vpn_accounts' | 'orders';
}

export const TRAFFIC_RESET_UNLIMITED_ONLY_MESSAGE =
  'Traffic reset is only available for eligible unlimited VPN packages.';

export type QuotaClassification = 'unlimited' | 'finite' | 'unknown' | 'invalid';

const FINITE_QUOTA_UNIT_REGEX =
  /(?:^|\b)(\d+(?:\.\d+)?)\s*(?:kb|mb|gb|tb|gib|mib|tib|bytes?)\b/i;
const FINITE_PACKAGE_SHORTHAND_REGEX =
  /\b(?:sim|router)[_\s-]?(?:100|200|500|1000|1tb|50|20|10|5|1)\b|\b(?:100|200|500)\s*g\b/i;
const NEGATIVE_NUMBER_TOKEN_REGEX = /(?:^|[\s:(])-\d/;

export const parsePaymentMethodJsonSafe = (raw: any): Record<string, any> => {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return {};
      }
    }
  }
  return {};
};

export const classifyQuotaText = (raw: any): QuotaClassification => {
  if (raw === null || raw === undefined) return 'unknown';
  if (typeof raw === 'boolean') return 'invalid';
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return 'invalid';
    if (raw > 0) return 'finite';
    return 'unknown';
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return 'unknown';
  const lower = trimmed.toLowerCase();

  if (
    lower === 'null' ||
    lower === 'undefined' ||
    lower === 'nan' ||
    lower === 'none' ||
    lower === 'n/a' ||
    lower === '-' ||
    lower.startsWith('-') ||
    NEGATIVE_NUMBER_TOKEN_REGEX.test(lower)
  ) {
    return 'invalid';
  }

  const unitMatch = FINITE_QUOTA_UNIT_REGEX.exec(lower);
  if (unitMatch) {
    const numericVal = parseFloat(unitMatch[1]);
    if (!Number.isFinite(numericVal) || numericVal <= 0) {
      return 'invalid';
    }
    return 'finite';
  }

  if (FINITE_PACKAGE_SHORTHAND_REGEX.test(lower)) {
    return 'finite';
  }

  if (/^-?\d+(?:\.\d+)?$/.test(lower)) {
    const num = Number(lower);
    if (!Number.isFinite(num) || num <= 0) {
      return 'invalid';
    }
    return 'finite';
  }

  if (/\bunlimited\b/i.test(lower)) {
    return 'unlimited';
  }

  return 'unknown';
};

export const classifyNumericQuotaBytes = (
  raw: any,
  options?: { allowZeroAsUnlimited?: boolean }
): QuotaClassification => {
  if (raw === null || raw === undefined || raw === '') return 'unknown';
  if (typeof raw === 'boolean') return 'invalid';

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return 'invalid';
    if (raw > 0) return 'finite';
    return options?.allowZeroAsUnlimited ? 'unlimited' : 'unknown';
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return 'unknown';
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) return 'invalid';
      if (num > 0) return 'finite';
      return options?.allowZeroAsUnlimited ? 'unlimited' : 'unknown';
    }
    return classifyQuotaText(trimmed);
  }

  return 'invalid';
};

const parseTimestampToMsSafe = (raw: any): number | null => {
  if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') {
    return null;
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw === 0) return null;
    if (raw < 0) return raw;
    return raw < 10000000000 ? raw * 1000 : raw;
  }
  if (raw instanceof Date) {
    const ts = raw.getTime();
    return Number.isNaN(ts) ? null : ts;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '0') return null;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num === 0) return null;
      if (num < 0) return num;
      return num < 10000000000 ? num * 1000 : num;
    }
    const parsed = new Date(trimmed).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const getEntitlementRecordTimestampMs = (rec: any): number => {
  if (!rec || typeof rec !== 'object') return 0;
  const candidates = [rec.verified_at, rec.activated_at, rec.updated_at, rec.created_at];
  for (const c of candidates) {
    const ts = parseTimestampToMsSafe(c);
    if (ts !== null && ts > 0) return ts;
  }
  return 0;
};

const isTrialEntitlementRecord = (rec: any, pmJson?: Record<string, any>): boolean => {
  if (!rec || typeof rec !== 'object') return false;
  const pm = pmJson || parsePaymentMethodJsonSafe(rec.payment_method);
  const orderIdStr = String(rec.order_id || rec.orderId || '').trim().toUpperCase();
  const pkgType = String(rec.package_type || rec.packageType || pm.package_type || pm.packageType || '').toLowerCase();
  const pkgName = String(rec.package_name || rec.packageName || pm.package_name || pm.packageName || '').toLowerCase();
  const payMethodName = String(pm.paymentMethod || pm.payment_method || '').toLowerCase();

  return Boolean(
    rec.is_trial === true ||
      rec.isTrial === true ||
      pm.is_trial === true ||
      pm.isTrial === true ||
      payMethodName.includes('trial') ||
      orderIdStr.startsWith('TRIAL-') ||
      pkgType.includes('trial') ||
      /\bfree\s*trial\b/.test(pkgName)
  );
};

export interface EvaluateCustomerTrafficResetEligibilityInput {
  vpnAccount?: any | null;
  vpnConfig?: any | null;
  orders?: any[];
  grants?: any[];
  ownershipSource?: 'vpn_accounts' | 'orders' | 'vpn_configs' | '3xui' | null;
  panelReachable: boolean;
  liveInbound?: any | null;
  liveClient?: any | null;
  liveStat?: any | null;
  nowMs?: number;
}

export interface CustomerTrafficResetEligibilityResult {
  eligible: boolean;
  isUnlimitedPlan: boolean;
  reasonCode: string;
  customerMessage: string;
  httpStatus: number;
  liveUpBytes: number;
  liveDownBytes: number;
  liveTotalLimitBytes: number | null;
}

/**
 * Authoritative, fail-closed eligibility evaluator for customer self-service traffic reset.
 * Enforces:
 * - Verified Supabase DB record (never pure 3X-UI fallback)
 * - Unconditional free-trial block (ignoring policy.allowTrialReset)
 * - Active, enabled, unexpired, non-deleted, non-rejected, non-revoked, non-unresolved-renewal state
 * - Live 3X-UI verification with strict numeric totalGB === 0 and stat.total === 0
 * - Current effective entitlement agreement (distinguishing newer verified grants from superseded historical records)
 * - Never treats missing, null, empty, negative, NaN, default-0-only, or package-name-only signals as unlimited.
 */
export const evaluateCustomerTrafficResetEligibility = (
  input: EvaluateCustomerTrafficResetEligibilityInput
): CustomerTrafficResetEligibilityResult => {
  const nowMs = input.nowMs ?? Date.now();
  const vpnAccount = input.vpnAccount && typeof input.vpnAccount === 'object' ? input.vpnAccount : null;
  const vpnConfig = input.vpnConfig && typeof input.vpnConfig === 'object' ? input.vpnConfig : null;
  const orders = Array.isArray(input.orders) ? input.orders.filter(Boolean) : [];
  const grants = Array.isArray(input.grants) ? input.grants.filter(Boolean) : [];

  const liveUpBytes = Math.max(
    0,
    Number(input.liveStat?.up ?? input.liveClient?.up ?? 0) || 0
  );
  const liveDownBytes = Math.max(
    0,
    Number(input.liveStat?.down ?? input.liveClient?.down ?? 0) || 0
  );

  const rawLiveLimit =
    input.liveStat?.total !== undefined && input.liveStat?.total !== null && Number(input.liveStat.total) > 0
      ? Number(input.liveStat.total)
      : input.liveClient?.totalGB !== undefined && input.liveClient?.totalGB !== null && input.liveClient?.totalGB !== ''
        ? Number(input.liveClient.totalGB)
        : null;
  const liveTotalLimitBytes =
    rawLiveLimit !== null && Number.isFinite(rawLiveLimit) && rawLiveLimit >= 0 ? rawLiveLimit : null;

  const deny = (
    reasonCode: string,
    httpStatus: number = 403,
    customerMessage: string = TRAFFIC_RESET_UNLIMITED_ONLY_MESSAGE,
    isUnlimitedPlan: boolean = false
  ): CustomerTrafficResetEligibilityResult => ({
    eligible: false,
    isUnlimitedPlan,
    reasonCode,
    customerMessage,
    httpStatus,
    liveUpBytes,
    liveDownBytes,
    liveTotalLimitBytes,
  });

  // 1. Must be backed by an authoritative Supabase DB record (never pure 3X-UI fallback)
  if (
    input.ownershipSource === '3xui' ||
    (!vpnAccount && !vpnConfig && orders.length === 0 && grants.length === 0)
  ) {
    return deny('unverified_db_record');
  }

  // 2. Analyze entitlement grants (distinguishing current effective grant from historical/superseded grants)
  let hasRejectedNewOrderGrant = false;
  let hasUnresolvedNewOrderGrant = false;
  let hasUnresolvedRenewalGrant = false;
  const effectiveGrants: any[] = [];

  for (const g of grants) {
    const gType = String(g.grant_type || 'new_order').toLowerCase().trim();
    const gStatus = String(g.status || '').toLowerCase().trim();

    if (gType === 'new_order') {
      if (
        gStatus === 'revoked' ||
        gStatus === 'revoke_failed' ||
        gStatus === 'rejected' ||
        gStatus === 'cancelled' ||
        gStatus === 'deleted'
      ) {
        hasRejectedNewOrderGrant = true;
      } else if (gStatus === 'provisioning' || gStatus === 'uncertain') {
        hasUnresolvedNewOrderGrant = true;
      } else if (gStatus === 'verified' || gStatus === 'confirmed' || gStatus === 'provisional') {
        effectiveGrants.push(g);
      }
    } else if (gType === 'renewal') {
      if (
        gStatus === 'provisioning' ||
        gStatus === 'provisional' ||
        gStatus === 'uncertain' ||
        gStatus === 'revoke_failed'
      ) {
        hasUnresolvedRenewalGrant = true;
      } else if (gStatus === 'verified' || gStatus === 'confirmed') {
        effectiveGrants.push(g);
      }
      // Note: a revoked/rejected renewal grant restores the pre-renewal state and does NOT invalidate the parent VPN.
    }
  }

  effectiveGrants.sort((a, b) => {
    const diff = getEntitlementRecordTimestampMs(b) - getEntitlementRecordTimestampMs(a);
    if (diff !== 0) return diff;
    const aIsRenewal = String(a.grant_type || '').toLowerCase() === 'renewal' ? 1 : 0;
    const bIsRenewal = String(b.grant_type || '').toLowerCase() === 'renewal' ? 1 : 0;
    return bIsRenewal - aIsRenewal;
  });

  const currentGrant = effectiveGrants[0] || null;
  const currentGrantTs = currentGrant ? getEntitlementRecordTimestampMs(currentGrant) : 0;
  const currentGrantIsVerifiedRenewal = Boolean(
    currentGrant && String(currentGrant.grant_type || '').toLowerCase().trim() === 'renewal'
  );

  // 3. Analyze orders (distinguishing base order rejections and newer/superseded orders)
  let hasRejectedBaseOrder = false;
  const nonRejectedOrders: any[] = [];
  const preferredOrderIds = new Set<string>(
    [
      currentGrant?.order_id,
      vpnAccount?.order_id,
      vpnConfig?.order_id,
    ]
      .filter(Boolean)
      .map((v) => String(v).trim())
  );

  for (const ord of orders) {
    const pm = parsePaymentMethodJsonSafe(ord.payment_method);
    const isRenewalOrder = Boolean(pm.is_renewal || pm.isRenewal || pm.extend_uuid);
    const ordStatus = String(ord.status || '').toLowerCase().trim();
    const ordPayStatus = String(ord.payment_status || '').toLowerCase().trim();
    const ordProvStatus = String(ord.provisioning_status || '').toLowerCase().trim();

    if (isOrderRejectedOrRevoked(ord)) {
      if (!isRenewalOrder) {
        hasRejectedBaseOrder = true;
      }
      continue;
    }

    if (
      ordStatus === 'deleted' ||
      ordStatus === 'cancelled' ||
      ordStatus === 'pending' ||
      ordStatus === 'provisioning' ||
      ordPayStatus === 'cancelled' ||
      ordProvStatus === 'provisioning' ||
      ordProvStatus === 'uncertain'
    ) {
      if (!isRenewalOrder && (ordStatus === 'deleted' || ordStatus === 'cancelled')) {
        hasRejectedBaseOrder = true;
      }
      continue;
    }

    nonRejectedOrders.push(ord);
  }

  nonRejectedOrders.sort((a, b) => {
    const diff = getEntitlementRecordTimestampMs(b) - getEntitlementRecordTimestampMs(a);
    if (diff !== 0) return diff;
    const aPreferred = preferredOrderIds.has(String(a.id || '').trim()) || preferredOrderIds.has(String(a.order_id || '').trim()) ? 1 : 0;
    const bPreferred = preferredOrderIds.has(String(b.id || '').trim()) || preferredOrderIds.has(String(b.order_id || '').trim()) ? 1 : 0;
    return bPreferred - aPreferred;
  });

  const currentOrder = nonRejectedOrders[0] || null;
  const currentOrderTs = currentOrder ? getEntitlementRecordTimestampMs(currentOrder) : 0;
  const isOrderSupersededByCurrentGrant = Boolean(
    currentGrantIsVerifiedRenewal &&
      currentOrder &&
      currentGrantTs >= currentOrderTs
  );

  // 4. Unconditional free trial block (ignores policy.allowTrialReset)
  if (
    isTrialEntitlementRecord(vpnAccount) ||
    isTrialEntitlementRecord(vpnConfig) ||
    isTrialEntitlementRecord(currentOrder) ||
    isTrialEntitlementRecord(currentGrant)
  ) {
    return deny('free_trial_blocked');
  }

  // 5. Block deleted, rejected, revoked, unresolved provisioning/renewal, disabled, or expired DB states
  if (hasRejectedNewOrderGrant || hasRejectedBaseOrder) {
    return deny('rejected_or_revoked');
  }
  if (hasUnresolvedRenewalGrant || hasUnresolvedNewOrderGrant) {
    return deny(
      'unresolved_entitlement_grant',
      409,
      'A renewal or provisioning update is currently pending for this VPN configuration. Please try again shortly.'
    );
  }

  const checkDbRowState = (row: any, rowName: string): CustomerTrafficResetEligibilityResult | null => {
    if (!row) return null;
    if (row.deleted_from_panel_at) {
      return deny(`${rowName}_deleted`);
    }
    const st = String(row.status || '').toLowerCase().trim();
    if (
      st === 'deleted' ||
      st === 'rejected' ||
      st === 'revoked' ||
      st === 'cancelled' ||
      st === 'disabled' ||
      st === 'expired' ||
      st === 'pending' ||
      st === 'provisioning'
    ) {
      return deny(`${rowName}_status_${st}`);
    }
    if (row.enable === false || row.enabled === false) {
      return deny(`${rowName}_disabled`);
    }
    const expCandidates = [row.expiry_time, row.expiry_date, row.expires_at, row.expiryDate];
    for (const expRaw of expCandidates) {
      const expMs = parseTimestampToMsSafe(expRaw);
      if (expMs !== null && (expMs < 0 || expMs <= nowMs)) {
        return deny(`${rowName}_expired`);
      }
    }
    return null;
  };

  const accStateBlock = checkDbRowState(vpnAccount, 'vpn_account');
  if (accStateBlock) return accStateBlock;

  const cfgStateBlock = checkDbRowState(vpnConfig, 'vpn_config');
  if (cfgStateBlock) return cfgStateBlock;

  // 6. Fresh Live 3X-UI Verification & Strict Live Quota Verification
  if (!input.panelReachable || !input.liveInbound || !input.liveClient) {
    return deny('panel_unverified');
  }

  if (
    input.liveInbound.enable === false ||
    input.liveClient.enable === false ||
    input.liveStat?.enable === false
  ) {
    return deny('panel_disabled');
  }

  const liveClientExpMs = parseTimestampToMsSafe(input.liveClient.expiryTime);
  const liveStatExpMs = parseTimestampToMsSafe(input.liveStat?.expiryTime);
  if (
    (liveClientExpMs !== null && (liveClientExpMs < 0 || liveClientExpMs <= nowMs)) ||
    (liveStatExpMs !== null && (liveStatExpMs < 0 || liveStatExpMs <= nowMs))
  ) {
    return deny('panel_expired');
  }

  // Strict live 3X-UI quota check: client.totalGB MUST be explicitly present and strictly 0.
  // Missing, null, empty, negative, NaN, or positive values MUST fail closed.
  const liveTotalGbCls = classifyNumericQuotaBytes(input.liveClient.totalGB, {
    allowZeroAsUnlimited: true,
  });
  if (liveTotalGbCls !== 'unlimited') {
    return deny(`panel_totalgb_${liveTotalGbCls}`);
  }

  if (
    input.liveClient.totalBytes !== undefined &&
    input.liveClient.totalBytes !== null &&
    input.liveClient.totalBytes !== ''
  ) {
    const cls = classifyNumericQuotaBytes(input.liveClient.totalBytes, {
      allowZeroAsUnlimited: true,
    });
    if (cls !== 'unlimited') {
      return deny(`panel_totalbytes_${cls}`);
    }
  }

  if (
    input.liveClient.total !== undefined &&
    input.liveClient.total !== null &&
    input.liveClient.total !== ''
  ) {
    const cls = classifyNumericQuotaBytes(input.liveClient.total, {
      allowZeroAsUnlimited: true,
    });
    if (cls !== 'unlimited') {
      return deny(`panel_client_total_${cls}`);
    }
  }

  if (
    input.liveStat &&
    input.liveStat.total !== undefined &&
    input.liveStat.total !== null &&
    input.liveStat.total !== ''
  ) {
    const cls = classifyNumericQuotaBytes(input.liveStat.total, {
      allowZeroAsUnlimited: true,
    });
    if (cls !== 'unlimited') {
      return deny(`panel_stat_total_${cls}`);
    }
  }

  // 7. Authoritative DB Entitlement Quota Agreement
  // Never rely on package names alone, and never treat default numeric 0 (e.g., total_bytes = 0)
  // without an explicit unlimited quota confirmation as unlimited.
  const positiveUnlimitedSources: string[] = [];
  const conflictReasons: string[] = [];

  // Source A: Current effective entitlement grant
  if (currentGrant) {
    let grantHasConflict = false;
    if (currentGrant.granted_unlimited === false) {
      conflictReasons.push('grant_not_unlimited');
      grantHasConflict = true;
    }

    if (
      currentGrant.granted_total_bytes !== undefined &&
      currentGrant.granted_total_bytes !== null &&
      currentGrant.granted_total_bytes !== ''
    ) {
      const cls = classifyNumericQuotaBytes(currentGrant.granted_total_bytes, {
        allowZeroAsUnlimited: true,
      });
      if (cls !== 'unlimited') {
        conflictReasons.push(`grant_total_bytes_${cls}`);
        grantHasConflict = true;
      }
    }

    if (
      currentGrant.added_quota_bytes !== undefined &&
      currentGrant.added_quota_bytes !== null &&
      currentGrant.added_quota_bytes !== ''
    ) {
      const cls = classifyNumericQuotaBytes(currentGrant.added_quota_bytes, {
        allowZeroAsUnlimited: true,
      });
      if (cls !== 'unlimited') {
        conflictReasons.push(`grant_added_quota_${cls}`);
        grantHasConflict = true;
      }
    }

    if (currentGrant.package_name && classifyQuotaText(currentGrant.package_name) === 'finite') {
      conflictReasons.push('grant_package_finite');
      grantHasConflict = true;
    }

    if (currentGrant.granted_unlimited === true && !grantHasConflict) {
      positiveUnlimitedSources.push('current_grant');
    }
  }

  // Source B: vpn_accounts row
  if (vpnAccount) {
    if (
      vpnAccount.total_bytes !== undefined &&
      vpnAccount.total_bytes !== null &&
      vpnAccount.total_bytes !== ''
    ) {
      // allowZeroAsUnlimited: false -> default 0 alone is NEVER standalone proof of unlimited
      const cls = classifyNumericQuotaBytes(vpnAccount.total_bytes, {
        allowZeroAsUnlimited: false,
      });
      if (cls === 'finite' || cls === 'invalid') {
        conflictReasons.push(`vpn_account_total_bytes_${cls}`);
      }
    }

    if (
      vpnAccount.data_limit !== undefined &&
      vpnAccount.data_limit !== null &&
      String(vpnAccount.data_limit).trim() !== ''
    ) {
      const cls = classifyQuotaText(vpnAccount.data_limit);
      if (cls === 'finite' || cls === 'invalid') {
        conflictReasons.push(`vpn_account_data_limit_${cls}`);
      } else if (cls === 'unlimited') {
        positiveUnlimitedSources.push('vpn_accounts.data_limit');
      }
    }

    if (vpnAccount.package_name && classifyQuotaText(vpnAccount.package_name) === 'finite') {
      conflictReasons.push('vpn_account_package_finite');
    }
  }

  // Source C: vpn_configs row (skip superseded initial quota/name only if strictly older than a newer verified renewal grant)
  if (vpnConfig) {
    const cfgTs = getEntitlementRecordTimestampMs(vpnConfig);
    const isVpnConfigSupersededByRenewalGrant = Boolean(
      currentGrantIsVerifiedRenewal &&
        currentGrant?.granted_unlimited === true &&
        cfgTs > 0 &&
        currentGrantTs > cfgTs
    );

    if (!isVpnConfigSupersededByRenewalGrant) {
      const cfgQuotaFields = [
        { name: 'data_limit', val: vpnConfig.data_limit },
        { name: 'traffic_limit', val: vpnConfig.traffic_limit },
      ];
      for (const f of cfgQuotaFields) {
        if (f.val === undefined || f.val === null || String(f.val).trim() === '') continue;
        const cls =
          typeof f.val === 'number'
            ? classifyNumericQuotaBytes(f.val, { allowZeroAsUnlimited: false })
            : classifyQuotaText(f.val);
        if (cls === 'finite' || cls === 'invalid') {
          conflictReasons.push(`vpn_config_${f.name}_${cls}`);
        } else if (cls === 'unlimited') {
          positiveUnlimitedSources.push(`vpn_configs.${f.name}`);
        }
      }

      const cfgPkgFields = [vpnConfig.package_name, vpnConfig.package_type];
      for (const pkg of cfgPkgFields) {
        if (pkg && classifyQuotaText(pkg) === 'finite') {
          conflictReasons.push('vpn_config_package_finite');
        }
      }
    }
  }

  // Source D: Current effective order (skipped if superseded by a newer verified renewal grant)
  if (currentOrder && !isOrderSupersededByCurrentGrant) {
    const pm = parsePaymentMethodJsonSafe(currentOrder.payment_method);

    const boolFlags = [
      currentOrder.is_unlimited,
      pm.is_unlimited,
      pm.isUnlimited,
      pm.unlimited,
    ];
    for (const flag of boolFlags) {
      if (flag === false) {
        conflictReasons.push('order_unlimited_flag_false');
      } else if (flag === true) {
        positiveUnlimitedSources.push('current_order.unlimited_flag');
      }
    }

    const numericOrderFields = [
      currentOrder.total_bytes,
      pm.total_bytes,
      pm.quota_bytes,
      pm.limit_gb,
      pm.limitGB,
      pm.data_gb,
      pm.dataGB,
    ];
    for (const val of numericOrderFields) {
      if (val === undefined || val === null || val === '') continue;
      const cls = classifyNumericQuotaBytes(val, { allowZeroAsUnlimited: false });
      if (cls === 'finite' || cls === 'invalid') {
        conflictReasons.push(`order_numeric_quota_${cls}`);
      }
    }

    const textOrderQuotaFields = [
      currentOrder.data_limit,
      currentOrder.traffic_limit,
      pm.data_limit,
      pm.dataLimit,
      pm.traffic_limit,
      pm.trafficLimit,
      pm.quota,
    ];
    for (const val of textOrderQuotaFields) {
      if (val === undefined || val === null || String(val).trim() === '') continue;
      const cls = classifyQuotaText(val);
      if (cls === 'finite' || cls === 'invalid') {
        conflictReasons.push(`order_text_quota_${cls}`);
      } else if (cls === 'unlimited') {
        positiveUnlimitedSources.push('current_order.quota_meta');
      }
    }

    // Package names are checked ONLY as finite-conflict detectors; NEVER as standalone unlimited proof
    const orderPkgFields = [
      currentOrder.package_name,
      currentOrder.plan,
      pm.package_name,
      pm.packageName,
      pm.package_type,
      pm.packageType,
      pm.plan,
    ];
    for (const pkg of orderPkgFields) {
      if (pkg && classifyQuotaText(pkg) === 'finite') {
        conflictReasons.push('order_package_finite');
      }
    }
  }

  if (conflictReasons.length > 0) {
    return deny(conflictReasons[0]);
  }

  if (positiveUnlimitedSources.length === 0) {
    return deny('missing_authoritative_unlimited_confirmation');
  }

  return {
    eligible: true,
    isUnlimitedPlan: true,
    reasonCode: 'eligible_unlimited',
    customerMessage: '',
    httpStatus: 200,
    liveUpBytes,
    liveDownBytes,
    liveTotalLimitBytes: 0,
  };
};

export type VpnObservedStatus =
  | 'Active'
  | 'Disabled'
  | 'Expired'
  | 'Data Limit Reached'
  | 'Status Unavailable';

export interface EvaluateVpnClientStatusInput {
  panelReachable: boolean;
  inboundFound: boolean;
  inboundEnable?: boolean | null;
  clientFound: boolean;
  clientEnable?: boolean | null;
  statEnable?: boolean | null;
  upBytes?: number;
  downBytes?: number;
  totalLimitBytes?: number;
  expiryTimeMs?: number | null;
  nowMs?: number;
}

export interface EvaluateVpnClientStatusResult {
  status: VpnObservedStatus;
  panelStatusVerified: boolean;
  effectiveEnable: boolean | null;
  enableStatus: boolean;
  isExpiredByTime: boolean;
  isDataLimitReached: boolean;
  isManuallyDisabled: boolean;
  isInboundDisabled: boolean;
  isUnlimited: boolean;
  statusReason: string;
}

/**
 * Pure deterministic evaluator for observed 3X-UI VPN client status.
 * Never lets stale clientStats.enable=true override settings.clients[].enable=false
 * or a disabled inbound, and never reports unverified/unreachable state as Active.
 */
export const evaluateVpnClientStatus = (
  input: EvaluateVpnClientStatusInput
): EvaluateVpnClientStatusResult => {
  const nowMs = input.nowMs ?? Date.now();
  const up = Math.max(0, Number(input.upBytes || 0) || 0);
  const down = Math.max(0, Number(input.downBytes || 0) || 0);
  const totalUsed = up + down;
  const totalLimit = Math.max(0, Number(input.totalLimitBytes || 0) || 0);
  const isUnlimited = totalLimit <= 0;
  const isDataLimitReached = !isUnlimited && totalUsed >= totalLimit;
  const expMs = input.expiryTimeMs ?? 0;
  const isExpiredByTime = (expMs > 0 && expMs <= nowMs) || expMs < 0;

  if (!input.panelReachable || !input.inboundFound || !input.clientFound) {
    return {
      status: 'Status Unavailable',
      panelStatusVerified: false,
      effectiveEnable: null,
      enableStatus: false,
      isExpiredByTime,
      isDataLimitReached,
      isManuallyDisabled: false,
      isInboundDisabled: false,
      isUnlimited,
      statusReason: !input.panelReachable
        ? 'panel_unreachable'
        : !input.inboundFound
          ? 'inbound_unavailable'
          : 'client_unverified',
    };
  }

  const isInboundDisabled = input.inboundEnable === false;
  const isClientSettingDisabled = input.clientEnable === false;
  const isStatDisabled = input.statEnable === false;
  const effectiveEnable = !isInboundDisabled && !isClientSettingDisabled && !isStatDisabled;
  const isManuallyDisabled = isInboundDisabled || isClientSettingDisabled || isStatDisabled;

  let status: VpnObservedStatus = 'Active';
  let statusReason = 'active';

  if (isExpiredByTime) {
    status = 'Expired';
    statusReason = 'expired';
  } else if (isDataLimitReached) {
    status = 'Data Limit Reached';
    statusReason = 'data_limit_reached';
  } else if (!effectiveEnable) {
    status = 'Disabled';
    statusReason = isInboundDisabled
      ? 'inbound_disabled'
      : isClientSettingDisabled
        ? 'client_disabled'
        : 'traffic_disabled';
  }

  return {
    status,
    panelStatusVerified: true,
    effectiveEnable,
    enableStatus: status === 'Active',
    isExpiredByTime,
    isDataLimitReached,
    isManuallyDisabled,
    isInboundDisabled,
    isUnlimited,
    statusReason,
  };
};

export const REJECTED_VPN_CUSTOMER_MESSAGE =
  'Your VPN has been disabled because your payment was rejected. Please contact support for assistance.';

export const sanitizeRejectionReasonForCustomer = (raw?: any): string | null => {
  if (raw === null || raw === undefined) return null;
  let cleaned = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  // Suppress internal technical/stack/credential leakage from customer-facing rejection text
  const unsafePattern =
    /(vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\/|hysteria|https?:\/\/|bearer\s+[a-z0-9._-]+|select\s+.+\s+from|insert\s+into|update\s+.+\s+set|delete\s+from|postgres|supabase|3x-?ui|econnrefused|etimedout|stack\s*trace|error:\s*at\s|password\s*[:=]|secret\s*[:=]|token\s*[:=]|api_?key\s*[:=]|service_role|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  if (unsafePattern.test(cleaned)) {
    return null;
  }

  if (cleaned.length > 240) {
    cleaned = `${cleaned.slice(0, 237).trimEnd()}...`;
  }
  return cleaned;
};

export const isOrderRejectedOrRevoked = (ord: any, grantStatus?: string | null): boolean => {
  if (!ord || typeof ord !== 'object') return false;
  const rawStatus = String(ord.status || '').toLowerCase().trim();
  const rawPayStatus = String(ord.payment_status || '').toLowerCase().trim();
  const provStatus = String(ord.provisioning_status || '').toLowerCase().trim();
  const gStatus = String(grantStatus || '').toLowerCase().trim();

  return (
    rawStatus === 'rejected' ||
    rawPayStatus === 'rejected' ||
    provStatus === 'revoked' ||
    provStatus === 'revoke_failed' ||
    provStatus === 'rejected' ||
    gStatus === 'revoked' ||
    gStatus === 'revoke_failed' ||
    gStatus === 'rejected'
  );
};

/**
 * Builds a strictly redacted display-only VPN configuration card for a rejected/revoked order.
 * Never exposes usable VPN credentials (UUID, VLESS URI, subscription URL, host/port, passwords, or Hysteria auth)
 * and always enforces Disabled status regardless of 3X-UI state.
 */
export const buildRejectedVpnDisplayConfig = (ord: any, grant?: any): Record<string, any> => {
  let pmJson: any = {};
  try {
    pmJson =
      typeof ord.payment_method === 'string'
        ? JSON.parse(ord.payment_method)
        : (ord.payment_method || {});
  } catch (_e) {}

  const orderDocId = String(ord.id || '').trim();
  const displayOrderId = String(ord.order_id || ord.id || '').trim();
  const packageName = String(
    ord.package_name || ord.plan || pmJson.packageName || pmJson.plan || 'FIREVPN Package'
  ).trim();
  const serverNode = String(ord.server || pmJson.server || 'Singapore').trim();
  const isTrialOrd = Boolean(
    pmJson.is_trial ||
      pmJson.isTrial ||
      pmJson.paymentMethod === 'Free Trial' ||
      displayOrderId.startsWith('TRIAL-')
  );
  const rawProv = String(ord.provisioning_status || grant?.status || 'revoked').toLowerCase().trim() || 'revoked';
  const safeReason = sanitizeRejectionReasonForCustomer(
    ord.reject_reason || ord.rejection_reason || grant?.revoke_reason || null
  );
  const expiryDate = ord.expiry_date || ord.expiryDate || '';

  const rawTrafficLimitText = isTrialOrd
    ? '1GB'
    : ord.traffic_limit && String(ord.traffic_limit).trim() !== ''
      ? String(ord.traffic_limit).trim()
      : 'Unavailable';
  const rejectedQuotaVerified = rawTrafficLimitText !== 'Unavailable';

  return {
    id: `rejected-${orderDocId || displayOrderId}`,
    orderId: displayOrderId,
    orderDocId: orderDocId || null,
    packageName,
    subscriptionName: packageName,
    name: packageName,
    // Strictly redact all usable VPN credentials
    uuid: '',
    configUrl: '',
    vlessUrl: null,
    subscriptionUrl: null,
    inboundId: null,
    trafficLimit: rawTrafficLimitText,
    usedGB: 0,
    remainingGB: 'Disabled',
    upBytes: 0,
    downBytes: 0,
    upload: 0,
    download: 0,
    liveUsageFound: false,
    trafficVerified: false,
    trafficSource: 'unknown' as VpnTrafficSource,
    quotaVerified: rejectedQuotaVerified,
    usedTrafficKnown: false,
    remainingTrafficKnown: false,
    panelStatusVerified: true,
    statusReason: 'payment_rejected',
    totalTrafficBytes: 0,
    remainingTrafficBytes: 0,
    expiryDate,
    expiryTime: expiryDate,
    status: 'Disabled',
    enable: false,
    enableStatus: false,
    onlineStatus: false,
    lastOnline: 0,
    serverNode,
    port: null,
    protocol: '',
    network: '',
    security: '',
    serverAddress: '',
    isTrial: isTrialOrd,
    templateId: null,
    isRejected: true,
    actionsDisabled: true,
    paymentStatus: 'Rejected',
    provisioningStatus: rawProv,
    rejectionMessage: REJECTED_VPN_CUSTOMER_MESSAGE,
    rejectionReason: safeReason,
    trafficResetEligible: false,
    isUnlimitedPlan: false,
  };
};

export type VpnTrafficSource =
  | 'live'
  | 'cached_scoped'
  | 'cached_inbound'
  | 'stored_db'
  | 'reset_confirmed'
  | 'unknown';

export interface GetMyConfigsOptions {
  dbClient?: any;
  adminDbClient?: any;
  getCachedInboundsFn?: (panelIdentity?: string) => Promise<any[]>;
  getLiveInboundFn?: (
    id: number,
    options?: boolean | { forceRefresh?: boolean; timeoutMs?: number }
  ) => Promise<any | null>;
  getInboundsFn?: (forceRefresh?: boolean, options?: GetInboundsOptions) => Promise<any[]>;
  verifyDeletedFn?: typeof verifyAndMarkClientDeletedIfConfirmed;
  currentPanelIdentity?: string;
  totalRequestBudgetMs?: number;
  coldStartTimeoutMs?: number;
  liveInboundTimeoutMs?: number;
  maxTrafficCacheEntries?: number;
  nowMs?: number;
}

export const getMyConfigs = async (
  uid: string,
  email?: string,
  _token?: string,
  options?: GetMyConfigsOptions
): Promise<{
  configs: any[];
  deletedUuids: string[];
  legacyReconciliationRecords: LegacyReconciliationRecord[];
  dbTime: number;
}> => {
  const dbStart = Date.now();
  const userEmail = email ? email.toLowerCase().trim() : '';
  const userUid = uid ? uid.trim() : '';
  const db = options?.dbClient || getSupabaseClient(_token);
  const adminDb = options?.adminDbClient || supabaseAdmin;
  const nowMs = options?.nowMs ?? Date.now();

  if (!userUid && !userEmail) {
    return { configs: [], deletedUuids: [], legacyReconciliationRecords: [], dbTime: 0 };
  }

  // Shared bounded customer HTTP request deadline across initial Supabase queries, panel identity resolution,
  // cold-start retrieval, live inbound reads, post-eviction authoritative rechecks, and optional status restoration.
  const totalRequestBudgetMs =
    options?.totalRequestBudgetMs && Number.isFinite(options.totalRequestBudgetMs) && options.totalRequestBudgetMs > 0
      ? Math.max(50, Math.min(Math.floor(options.totalRequestBudgetMs), 12000))
      : CUSTOMER_MY_CONFIGS_TOTAL_BUDGET_MS;
  const customerRequestDeadlineMs = dbStart + totalRequestBudgetMs;
  const getRemainingCustomerBudgetMs = (): number => Math.max(0, customerRequestDeadlineMs - Date.now());
  let customerRequestTimedOut = false;

  const createCustomerDeadlineError = (stage: string): Error => {
    customerRequestTimedOut = true;
    const err: any = new Error(
      `Customer configuration lookup timed out during ${stage} (exceeded ${totalRequestBudgetMs}ms request budget).`
    );
    err.status = 504;
    err.statusCode = 504;
    err.code = 'CUSTOMER_REQUEST_DEADLINE_EXCEEDED';
    err.retryable = true;
    return err;
  };

  const createCustomerQueryFailureError = (stage: string, cause?: any): Error => {
    if (cause?.code === 'CUSTOMER_REQUEST_DEADLINE_EXCEEDED' || cause?.code === 'AUTHORITATIVE_MUTATION_RECHECK_FAILED') {
      return cause;
    }
    const msg = cause?.message || String(cause || 'database query failed');
    const err: any = new Error(`Customer configuration query failed during ${stage}: ${msg}`);
    err.status = 503;
    err.statusCode = 503;
    err.code = 'CUSTOMER_CONFIG_QUERY_FAILED';
    err.retryable = true;
    return err;
  };

  const runRequiredCustomerStage = async <T>(
    stage: string,
    fn: () => Promise<T>,
    minRequiredMs = 15
  ): Promise<T> => {
    const remainingMs = getRemainingCustomerBudgetMs();
    if (remainingMs < minRequiredMs) {
      throw createCustomerDeadlineError(stage);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(createCustomerDeadlineError(stage));
      }, Math.max(15, remainingMs));
    });
    try {
      return await Promise.race([fn(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const inboundMap = new Map<string, number>();
  const recordedInboundByUuid = new Map<string, number>();
  const conflictingInboundUuids = new Set<string>();
  const recordedOwnerUidByUuid = new Map<string, string>();
  const recordedPanelByUuid = new Map<string, string>();
  const conflictingOwnershipUuids = new Set<string>();

  const recordInboundForUuidAndOrder = (normUuid: string, orderId: string, rawIbId: any) => {
    const ibId = Number(rawIbId);
    if (Number.isNaN(ibId) || ibId <= 0) return;
    if (normUuid) {
      const existingIb = recordedInboundByUuid.get(normUuid);
      if (existingIb !== undefined && existingIb !== ibId) {
        conflictingInboundUuids.add(normUuid);
      } else {
        recordedInboundByUuid.set(normUuid, ibId);
      }
      if (!inboundMap.has(normUuid)) {
        inboundMap.set(normUuid, ibId);
      }
    }
    if (orderId) {
      const existingOrdIb = inboundMap.get(orderId);
      if (existingOrdIb !== undefined && existingOrdIb !== ibId && normUuid) {
        conflictingInboundUuids.add(normUuid);
      } else if (existingOrdIb === undefined) {
        inboundMap.set(orderId, ibId);
      }
    }
  };

  const recordOwnershipMetadata = (normUuid: string, candidateUids: Array<string | null | undefined>, rawPanelIdentity?: any) => {
    if (!normUuid) return;
    const nonEmptyUids = Array.from(
      new Set(
        candidateUids
          .map((u) => String(u || '').trim())
          .filter(Boolean)
      )
    );
    if (nonEmptyUids.length > 1) {
      conflictingOwnershipUuids.add(normUuid);
    }
    for (const u of nonEmptyUids) {
      if (userUid && u !== userUid) {
        conflictingOwnershipUuids.add(normUuid);
      }
      const prevUid = recordedOwnerUidByUuid.get(normUuid);
      if (prevUid && prevUid !== u) {
        conflictingOwnershipUuids.add(normUuid);
      } else if (!prevUid) {
        recordedOwnerUidByUuid.set(normUuid, u);
      }
    }
    const panelId = String(rawPanelIdentity || '').trim();
    if (panelId) {
      const prevPanel = recordedPanelByUuid.get(normUuid);
      if (prevPanel && prevPanel !== panelId) {
        conflictingOwnershipUuids.add(normUuid);
      } else if (!prevPanel) {
        recordedPanelByUuid.set(normUuid, panelId);
      }
    }
  };

  // Query vpn_configs scoped strictly to this customer by customer_uid and user_id (no full-table scan)
  const vpnConfigsMap = new Map<string, any>();
  if (userUid) {
    try {
      const [byCustomerUidRes, byUserIdRes] = await runRequiredCustomerStage('vpn_configs_query', () =>
        Promise.all([
          db.from('vpn_configs').select('*').eq('customer_uid', userUid),
          db.from('vpn_configs').select('*').eq('user_id', userUid),
        ])
      );
      if (byCustomerUidRes?.error) {
        throw createCustomerQueryFailureError('vpn_configs_customer_uid', byCustomerUidRes.error);
      }
      if (byUserIdRes?.error) {
        throw createCustomerQueryFailureError('vpn_configs_user_id', byUserIdRes.error);
      }
      const combinedCfgs = [
        ...(Array.isArray(byCustomerUidRes?.data) ? byCustomerUidRes.data : []),
        ...(Array.isArray(byUserIdRes?.data) ? byUserIdRes.data : []),
      ];
      combinedCfgs.forEach((cfg: any) => {
        const key = String(cfg.id || cfg.uuid || cfg.order_id || Math.random());
        vpnConfigsMap.set(key, cfg);
      });
    } catch (e: any) {
      throw createCustomerQueryFailureError('vpn_configs_query', e);
    }
  }
  const vpnConfigsData = Array.from(vpnConfigsMap.values());
  const confirmedDeletedUuids = new Set<string>();
  const blockedNonActiveUuids = new Set<string>();
  const vpnConfigOrderIds = new Set<string>();
  const vpnConfigByUuid = new Map<string, any>();

  vpnConfigsData.forEach(cfg => {
    const normUuid = cfg.uuid ? String(cfg.uuid).trim().toLowerCase() : '';
    const ordIdStr = cfg.order_id ? String(cfg.order_id).trim() : '';
    if (normUuid) {
      if (vpnConfigByUuid.has(normUuid)) {
        const prevCfg = vpnConfigByUuid.get(normUuid);
        if (prevCfg && prevCfg.id !== cfg.id) {
          recordInboundForUuidAndOrder(normUuid, ordIdStr, prevCfg.inbound_id);
          recordOwnershipMetadata(normUuid, [prevCfg.user_id, prevCfg.customer_uid], prevCfg.panel_identity);
        }
      }
      vpnConfigByUuid.set(normUuid, cfg);
    }
    if (ordIdStr) {
      vpnConfigOrderIds.add(ordIdStr);
    }
    recordOwnershipMetadata(normUuid, [cfg.user_id, cfg.customer_uid], cfg.panel_identity);
    const cfgStatus = String(cfg.status || '').toLowerCase().trim();
    const isDeleted = cfgStatus === 'deleted' || Boolean(cfg.deleted_from_panel_at);
    if (isDeleted && normUuid) {
      confirmedDeletedUuids.add(normUuid);
      blockedNonActiveUuids.add(normUuid);
    }
    // IMPORTANT: Keep 'disabled' and 'expired' configs visible so disabled clients show red Disabled
    // status and expired/exhausted clients keep their renewal options. Only exclude deleted/rejected/pending/revoked.
    if (
      cfgStatus === 'deleted' ||
      cfgStatus === 'rejected' ||
      cfgStatus === 'cancelled' ||
      cfgStatus === 'pending' ||
      cfgStatus === 'revoked'
    ) {
      if (normUuid) blockedNonActiveUuids.add(normUuid);
    }
    recordInboundForUuidAndOrder(normUuid, ordIdStr, cfg.inbound_id);
  });

  // Query orders table scoped strictly to this customer (by customer_id and legacy email fallback)
  const ordersById = new Map<string, any>();
  if (userUid) {
    try {
      const ordersByUidRes: any = await runRequiredCustomerStage('orders_by_uid_query', () =>
        db.from('orders').select('*').eq('customer_id', userUid)
      );
      if (ordersByUidRes?.error) {
        throw createCustomerQueryFailureError('orders_by_uid_query', ordersByUidRes.error);
      }
      const ordersByUid = ordersByUidRes?.data;
      if (Array.isArray(ordersByUid)) {
        ordersByUid.forEach((ord: any) => {
          const key = String(ord.id || ord.order_id || Math.random());
          ordersById.set(key, ord);
        });
      }
    } catch (e: any) {
      throw createCustomerQueryFailureError('orders_by_uid_query', e);
    }
  }
  if (userEmail) {
    try {
      const ordersByEmailRes: any = await runRequiredCustomerStage('orders_by_email_query', () =>
        db.from('orders').select('*').ilike('email', userEmail)
      );
      if (ordersByEmailRes?.error) {
        throw createCustomerQueryFailureError('orders_by_email_query', ordersByEmailRes.error);
      }
      const ordersByEmail = ordersByEmailRes?.data;
      if (Array.isArray(ordersByEmail)) {
        ordersByEmail.forEach((ord: any) => {
          const docUid = String(ord.customer_id || ord.customerUid || ord.customerId || ord.uid || ord.userId || '').trim();
          const cUuid = String(ord.client_uuid || ord.vpn_credentials?.password || ord.uuid || '').trim().toLowerCase();
          if (userUid && docUid && docUid !== userUid) {
            if (cUuid) conflictingOwnershipUuids.add(cUuid);
            return;
          }
          // Only include email-matched rows when they belong to this UID or have no UID recorded
          if (!userUid || !docUid || docUid === userUid) {
            const key = String(ord.id || ord.order_id || Math.random());
            ordersById.set(key, ord);
          }
        });
      }
    } catch (e: any) {
      throw createCustomerQueryFailureError('orders_by_email_query', e);
    }
  }
  const allOrders: any[] = Array.from(ordersById.values());

  const isOrderProvisionallyActive = (ord: any): boolean => {
    const rawStatus = String(ord.status || '').toLowerCase().trim();
    const rawPayStatus = String(ord.payment_status || '').toLowerCase().trim();
    if (
      rawStatus === 'rejected' ||
      rawStatus === 'cancelled' ||
      rawStatus === 'deleted' ||
      rawPayStatus === 'cancelled' ||
      rawPayStatus === 'rejected'
    ) {
      return false;
    }
    const provStatus = String(ord.provisioning_status || '').toLowerCase().trim();
    if (provStatus === 'revoked' || provStatus === 'revoke_failed' || provStatus === 'rejected') {
      return false;
    }
    const cUuid = String(ord.client_uuid || '').trim().toLowerCase();
    if (cUuid && (confirmedDeletedUuids.has(cUuid) || blockedNonActiveUuids.has(cUuid))) {
      return false;
    }
    return (
      provStatus === 'provisional' &&
      Boolean(ord.vless_url) &&
      Boolean(ord.client_uuid)
    );
  };

  const nonApprovedOrderIds = new Set<string>();
  const nonApprovedOrderUuids = new Set<string>();
  const grantByOrderId = new Map<string, any>();
  const grantsByUuid = new Map<string, any[]>();
  const grantsByOrderIdList = new Map<string, any[]>();

  const registerGrantRow = (g: any) => {
    if (!g || typeof g !== 'object') return;
    const gType = String(g.grant_type || 'new_order').toLowerCase().trim();
    const gStatus = String(g.status || '').toLowerCase().trim();
    const gUuid = String(g.client_uuid || '').trim().toLowerCase();
    const gOrderId = String(g.order_id || '').trim();
    recordInboundForUuidAndOrder(gUuid, gOrderId, g.inbound_id);
    recordOwnershipMetadata(gUuid, [g.user_id, g.customer_id], g.panel_identity);
    if (gUuid) {
      const existing = grantsByUuid.get(gUuid) || [];
      if (!existing.some((x) => (x.id && g.id ? x.id === g.id : x === g))) {
        existing.push(g);
        grantsByUuid.set(gUuid, existing);
      }
    }
    if (gOrderId) {
      const existingOrd = grantsByOrderIdList.get(gOrderId) || [];
      if (!existingOrd.some((x) => (x.id && g.id ? x.id === g.id : x === g))) {
        existingOrd.push(g);
        grantsByOrderIdList.set(gOrderId, existingOrd);
      }
    }
    // CRITICAL: Only a 'new_order' entitlement grant represents the order's own base VPN creation.
    // A rejected/revoked 'renewal' grant restores the existing paid VPN to its pre-renewal state
    // and must NEVER mark the parent order or client_uuid as non-approved, deleted, or rejected!
    if (gType === 'new_order') {
      if (gOrderId) grantByOrderId.set(gOrderId, g);
      if (
        gStatus === 'revoked' ||
        gStatus === 'revoke_failed' ||
        gStatus === 'rejected' ||
        gStatus === 'cancelled' ||
        gStatus === 'deleted'
      ) {
        if (gOrderId) nonApprovedOrderIds.add(gOrderId);
        if (gUuid) {
          nonApprovedOrderUuids.add(gUuid);
          blockedNonActiveUuids.add(gUuid);
        }
      }
    }
  };

  // Defense-in-depth: also inspect vpn_entitlement_grants for this customer's orders
  // so revoked / revoke_failed grants are strictly excluded from active configs and
  // authoritative inbound_id / revoke_reason / quota metadata are available.
  const customerOrderRowIds = allOrders
    .map(ord => (ord?.id ? String(ord.id).trim() : ''))
    .filter(Boolean);
  if (customerOrderRowIds.length > 0 && adminDb) {
    try {
      const grantsRes: any = await runRequiredCustomerStage('vpn_entitlement_grants_by_order_query', () =>
        adminDb
          .from('vpn_entitlement_grants')
          .select('*')
          .in('order_id', customerOrderRowIds)
      );
      const grants = grantsRes?.data;
      if (Array.isArray(grants)) {
        grants.forEach(registerGrantRow);
      }
    } catch (grantErr: any) {
      if (grantErr?.code === 'CUSTOMER_REQUEST_DEADLINE_EXCEEDED') {
        throw grantErr;
      }
      // Non-blocking if table or rows are absent
    }
  }

  allOrders.forEach(ord => {
    const rawStatus = String(ord.status || '').toLowerCase().trim();
    const ordUid = String(ord.customer_id || ord.customerUid || ord.customerId || ord.uid || ord.userId || '').trim();
    const cUuid = String(ord.client_uuid || ord.vpn_credentials?.password || ord.uuid || '').trim().toLowerCase();
    const ordIdStr = String(ord.id || ord.order_id || '').trim();
    recordOwnershipMetadata(cUuid, [ordUid], ord.panel_identity);
    recordInboundForUuidAndOrder(cUuid, ordIdStr, ord.inbound_id);

    if (isOrderProvisionallyActive(ord)) {
      return;
    }
    const provStatus = String(ord.provisioning_status || '').toLowerCase().trim();
    // Do NOT block 'expired' orders here — expired VPN clients must remain visible with renewal options!
    if (
      rawStatus === 'pending' ||
      rawStatus === 'rejected' ||
      rawStatus === 'cancelled' ||
      rawStatus === 'deleted' ||
      rawStatus === 'provisioning' ||
      provStatus === 'revoked' ||
      provStatus === 'revoke_failed' ||
      provStatus === 'rejected'
    ) {
      if (ord.id) nonApprovedOrderIds.add(String(ord.id).trim());
      if (ord.order_id) nonApprovedOrderIds.add(String(ord.order_id).trim());
      if (cUuid) nonApprovedOrderUuids.add(cUuid);
    }
  });

  const configs: any[] = [];
  const vpnAccountByUuid = new Map<string, any>();

  // 1. Query vpn_accounts table using authenticated UID first
  try {
    let vpnAccs: any[] = [];
    if (userUid) {
      const byUidRes: any = await runRequiredCustomerStage('vpn_accounts_by_uid_query', () =>
        db.from('vpn_accounts').select('*').eq('user_id', userUid).order('created_at', { ascending: false })
      );
      if (byUidRes?.error) {
        throw createCustomerQueryFailureError('vpn_accounts_by_uid_query', byUidRes.error);
      }
      if (Array.isArray(byUidRes?.data)) vpnAccs = byUidRes.data;
    }
    if (vpnAccs.length === 0 && userEmail) {
      const byEmailRes: any = await runRequiredCustomerStage('vpn_accounts_by_email_query', () =>
        db.from('vpn_accounts').select('*').eq('email', userEmail).order('created_at', { ascending: false })
      );
      if (byEmailRes?.error) {
        throw createCustomerQueryFailureError('vpn_accounts_by_email_query', byEmailRes.error);
      }
      const byEmail = byEmailRes?.data;
      if (Array.isArray(byEmail)) {
        // Only accept records that either match userUid or have no conflicting user_id
        vpnAccs = byEmail.filter(acc => {
          const docUserId = String(acc.user_id || '').trim();
          const accUuid = String(acc.uuid || '').trim().toLowerCase();
          if (userUid && docUserId && docUserId !== userUid) {
            if (accUuid) conflictingOwnershipUuids.add(accUuid);
            return false;
          }
          return !userUid || !docUserId || docUserId === userUid;
        });
      }
    }

    if (vpnAccs && Array.isArray(vpnAccs)) {
      vpnAccs.forEach(acc => {
        const docUserId = String(acc.user_id || '').trim();
        const docEmail = String(acc.email || '').toLowerCase().trim();
        const configUuid = String(acc.uuid || '').trim();
        const normUuid = configUuid.toLowerCase();
        recordOwnershipMetadata(normUuid, [docUserId], acc.panel_identity);
        const orderId = String(acc.order_id || acc.id || '').trim();
        recordInboundForUuidAndOrder(normUuid, orderId, acc.inbound_id);

        const matchesUser = userUid
          ? (docUserId === userUid || (!docUserId && userEmail && docEmail === userEmail))
          : (userEmail && docEmail === userEmail);

        if (!matchesUser) return;

        const accStatus = String(acc.status || 'active').toLowerCase().trim();

        if (normUuid) {
          vpnAccountByUuid.set(normUuid, acc);
        }

        // Confirmed deleted accounts are ALWAYS excluded and never resurrected
        if (accStatus === 'deleted' || Boolean(acc.deleted_from_panel_at)) {
          if (normUuid) {
            confirmedDeletedUuids.add(normUuid);
            blockedNonActiveUuids.add(normUuid);
          }
          return;
        }

        // Keep active, disabled, and expired VPN accounts visible (disabled shows red Disabled; expired stays renewable)
        const isDisplayableStatus =
          accStatus === 'active' ||
          accStatus === 'enabled' ||
          accStatus === 'approved' ||
          accStatus === 'disabled' ||
          accStatus === 'expired';

        const isBlockedByOrder =
          (orderId && nonApprovedOrderIds.has(orderId)) ||
          (normUuid && nonApprovedOrderUuids.has(normUuid)) ||
          (normUuid && blockedNonActiveUuids.has(normUuid));

        if (isDisplayableStatus && !isBlockedByOrder && configUuid && acc.vless_url) {
          const isTrialAcc = !!(acc.is_trial || orderId.startsWith('TRIAL-'));
          const cfgRow = vpnConfigByUuid.get(normUuid);
          const accPanelId = String(acc.panel_identity || '').trim();
          const cfgPanelId = String(cfgRow?.panel_identity || '').trim();
          if (accPanelId && cfgPanelId && accPanelId !== cfgPanelId) {
            conflictingOwnershipUuids.add(normUuid);
          }
          const hasConflictIb = conflictingInboundUuids.has(normUuid);
          const inboundId = hasConflictIb ? null : (inboundMap.get(orderId) || inboundMap.get(normUuid) || null);

          configs.push({
            orderId: acc.order_id || acc.id,
            packageName: acc.remark || 'FIREVPN Package',
            configUrl: acc.vless_url,
            uuid: configUuid,
            expiryDate: acc.expiry_date || (acc.expiry_time ? new Date(acc.expiry_time).toISOString() : ''),
            inboundId,
            trafficLimit: isTrialAcc ? '1GB' : (acc.total_bytes > 0 ? `${acc.total_bytes / (1024 * 1024 * 1024)}GB` : 'Unlimited'),
            serverNode: acc.server_name || 'Singapore',
            _rawLimit: isTrialAcc ? 1 * 1024 * 1024 * 1024 : (acc.total_bytes || 0),
            isTrial: isTrialAcc,
            templateId: acc.template_id || null,
            _dbAccountId: acc.id || null,
            _dbConfigId: cfgRow?.id || null,
            _dbStatus: accStatus,
            _recordPanelIdentity: acc.panel_identity || cfgRow?.panel_identity || null,
            _recordServerId: acc.server_id || cfgRow?.server_id || null,
            _persistedInboundId: inboundId,
            _persistedHasUserId: Boolean(docUserId) && !conflictingOwnershipUuids.has(normUuid),
            _hasConflictingInboundId: hasConflictIb,
            _hasConflictingOwnership: conflictingOwnershipUuids.has(normUuid),
            _legacySource: 'vpn_accounts' as const,
            _storedUpBytes: Math.max(0, Number(acc.up_bytes ?? 0) || 0),
            _storedDownBytes: Math.max(0, Number(acc.down_bytes ?? 0) || 0),
            _storedUsedBytes: Math.max(0, Number(acc.used_bytes ?? 0) || 0),
            _hasExplicitStoredCounters: Boolean(
              (acc.up_bytes !== null && acc.up_bytes !== undefined) ||
                (acc.down_bytes !== null && acc.down_bytes !== undefined) ||
                (acc.used_bytes !== null && acc.used_bytes !== undefined)
            ),
            _initialStoredUpBytes: Math.max(0, Number(acc.up_bytes ?? 0) || 0),
            _initialStoredDownBytes: Math.max(0, Number(acc.down_bytes ?? 0) || 0),
            _initialStoredUsedBytes: Math.max(0, Number(acc.used_bytes ?? 0) || 0),
            _initialLastResetAtMs:
              parseTimestampToMsSafe(acc.last_traffic_reset_at || acc.traffic_reset_at) || 0,
            _createdAt: acc.created_at || cfgRow?.created_at || null,
            _ownerUid: docUserId || userUid || null,
            _ownerEmail: docEmail || userEmail || null,
          });
        }
      });
    }
  } catch (err: any) {
    throw createCustomerQueryFailureError('vpn_accounts_query', err);
  }

  // 2. Match approved, provisionally active, or expired-but-non-deleted orders for this authenticated user
  const matchedDocs = allOrders.filter(doc => {
    const data = doc;
    const docUid = String(data.customer_id || data.customerUid || data.customerId || data.uid || data.userId || '').trim();
    const docEmail = String(data.email || data.customerEmail || data.userEmail || '').toLowerCase().trim();
    const orderStatus = String(data.status || '').toLowerCase().trim();

    const matchesUser = userUid
      ? (docUid === userUid || (!docUid && userEmail && docEmail === userEmail))
      : (userEmail && docEmail === userEmail);

    const isApproved =
      orderStatus === 'approved' ||
      orderStatus === 'completed' ||
      orderStatus === 'active' ||
      orderStatus === 'expired' ||
      isOrderProvisionallyActive(data);

    return matchesUser && isApproved;
  });

  matchedDocs.forEach(data => {
    const vlessUrl = String(data.vless_url || data.vpn_credentials?.configLink || data.vpn_credentials?.qrcodeData || data.configUrl || '').trim();
    const clientUuid = String(data.client_uuid || data.vpn_credentials?.password || data.uuid || '').trim();
    const normUuid = clientUuid.toLowerCase();

    if (
      vlessUrl &&
      clientUuid &&
      !confirmedDeletedUuids.has(normUuid) &&
      !blockedNonActiveUuids.has(normUuid) &&
      !nonApprovedOrderUuids.has(normUuid)
    ) {
      let pmJson: any = {};
      try {
        pmJson = typeof data.payment_method === 'string' ? JSON.parse(data.payment_method) : (data.payment_method || {});
      } catch(e) {}

      const isProvisionalOrd = isOrderProvisionallyActive(data);
      const existingIdx = configs.findIndex(c => c.uuid && c.uuid.toLowerCase() === normUuid);
      if (existingIdx >= 0) {
        if ((!configs[existingIdx].serverNode || configs[existingIdx].serverNode === 'Singapore') && (data.server || pmJson.server)) {
          configs[existingIdx].serverNode = data.server || pmJson.server;
        }
        configs[existingIdx].paymentStatus = data.payment_status || (isProvisionalOrd ? 'Pending Verification' : 'Paid');
        configs[existingIdx].provisioningStatus = data.provisioning_status || pmJson.provisioning_status || (isProvisionalOrd ? 'provisional' : 'completed');
      } else {
        const isTrialOrd = !!(pmJson.is_trial || pmJson.isTrial || pmJson.paymentMethod === 'Free Trial' || String(data.order_id || data.id || '').startsWith('TRIAL-'));
        const tplId = data.template_id || pmJson.template_id || pmJson.templateId || null;
        const orderId = data.id || data.order_id;
        const hasConflictIb = conflictingInboundUuids.has(normUuid);
        const inboundId = hasConflictIb ? null : (inboundMap.get(String(orderId)) || inboundMap.get(normUuid) || data.inbound_id || null);
        const cfgRow = vpnConfigByUuid.get(normUuid);
        const accRow = vpnAccountByUuid.get(normUuid);

        configs.push({
          orderId,
          packageName: data.package_name || data.plan || 'FIREVPN Package',
          configUrl: vlessUrl,
          uuid: clientUuid,
          expiryDate: data.expiry_date || data.expiryDate || '',
          inboundId,
          trafficLimit: isTrialOrd ? '1GB' : (data.traffic_limit || 'Unlimited'),
          serverNode: data.server || pmJson.server || 'Singapore',
          _rawLimit: isTrialOrd ? 1 * 1024 * 1024 * 1024 : (data.traffic_limit && String(data.traffic_limit).toLowerCase() !== 'unlimited' ? ((parseFloat(String(data.traffic_limit)) || 0) * 1024 * 1024 * 1024) : 0),
          isTrial: isTrialOrd,
          templateId: tplId,
          paymentStatus: data.payment_status || (isProvisionalOrd ? 'Pending Verification' : 'Paid'),
          provisioningStatus: data.provisioning_status || pmJson.provisioning_status || (isProvisionalOrd ? 'provisional' : 'completed'),
          _dbAccountId: accRow?.id || null,
          _dbConfigId: cfgRow?.id || null,
          _dbStatus: String(accRow?.status || cfgRow?.status || 'active').toLowerCase().trim(),
          _recordPanelIdentity: accRow?.panel_identity || cfgRow?.panel_identity || null,
          _recordServerId: accRow?.server_id || cfgRow?.server_id || null,
          _persistedInboundId: inboundId,
          _persistedHasUserId:
            Boolean(String(accRow?.user_id || cfgRow?.user_id || data.customer_id || '').trim()) &&
            !conflictingOwnershipUuids.has(normUuid),
          _hasConflictingInboundId: hasConflictIb,
          _hasConflictingOwnership: conflictingOwnershipUuids.has(normUuid),
          _legacySource: 'orders' as const,
          _storedUpBytes: Math.max(0, Number(accRow?.up_bytes ?? 0) || 0),
          _storedDownBytes: Math.max(0, Number(accRow?.down_bytes ?? 0) || 0),
          _storedUsedBytes: Math.max(0, Number(accRow?.used_bytes ?? 0) || 0),
          _hasExplicitStoredCounters: Boolean(
            accRow &&
              ((accRow.up_bytes !== null && accRow.up_bytes !== undefined) ||
                (accRow.down_bytes !== null && accRow.down_bytes !== undefined) ||
                (accRow.used_bytes !== null && accRow.used_bytes !== undefined))
          ),
          _initialStoredUpBytes: Math.max(0, Number(accRow?.up_bytes ?? 0) || 0),
          _initialStoredDownBytes: Math.max(0, Number(accRow?.down_bytes ?? 0) || 0),
          _initialStoredUsedBytes: Math.max(0, Number(accRow?.used_bytes ?? 0) || 0),
          _initialLastResetAtMs:
            parseTimestampToMsSafe(accRow?.last_traffic_reset_at || accRow?.traffic_reset_at) || 0,
          _createdAt: accRow?.created_at || cfgRow?.created_at || data.created_at || null,
          _ownerUid: String(data.customer_id || userUid || '').trim() || null,
          _ownerEmail: String(data.email || userEmail || '').trim().toLowerCase() || null,
        });
      }
    }
  });

  // Also batch-fetch any renewal/client grants by client_uuid (e.g. renewal grants whose order_id is null)
  const customerConfigUuids = Array.from(
    new Set(
      configs
        .map((c) => String(c.uuid || '').trim().toLowerCase())
        .filter(Boolean)
    )
  );
  if (customerConfigUuids.length > 0 && adminDb) {
    try {
      const uuidGrantsRes: any = await runRequiredCustomerStage('vpn_entitlement_grants_by_uuid_query', () =>
        adminDb
          .from('vpn_entitlement_grants')
          .select('*')
          .in('client_uuid', customerConfigUuids)
      );
      const uuidGrants = uuidGrantsRes?.data;
      if (Array.isArray(uuidGrants)) {
        uuidGrants.forEach(registerGrantRow);
      }
    } catch (uuidGrantErr: any) {
      if (uuidGrantErr?.code === 'CUSTOMER_REQUEST_DEADLINE_EXCEEDED') {
        throw uuidGrantErr;
      }
      // Non-blocking
    }
  }

  // Re-sync conflict flags on configs after grant inspection
  configs.forEach((c) => {
    const normUuid = String(c.uuid || '').trim().toLowerCase();
    if (!normUuid) return;
    if (conflictingInboundUuids.has(normUuid)) {
      c._hasConflictingInboundId = true;
      c._persistedInboundId = null;
      c.inboundId = null;
    }
    if (conflictingOwnershipUuids.has(normUuid)) {
      c._hasConflictingOwnership = true;
      c._persistedHasUserId = false;
    }
  });

  // Index already-fetched customer orders by UUID and order ID for zero-extra-query eligibility checks
  const ordersByUuidMap = new Map<string, any[]>();
  const ordersByAnyIdMap = new Map<string, any[]>();
  allOrders.forEach((ord) => {
    const cUuid = String(ord.client_uuid || ord.vpn_credentials?.password || ord.uuid || '').trim().toLowerCase();
    if (cUuid) {
      const list = ordersByUuidMap.get(cUuid) || [];
      list.push(ord);
      ordersByUuidMap.set(cUuid, list);
    }
    const pm = parsePaymentMethodJsonSafe(ord.payment_method);
    const extUuid = String(pm.extend_uuid || '').trim().toLowerCase();
    if (extUuid && extUuid !== cUuid) {
      const list = ordersByUuidMap.get(extUuid) || [];
      list.push(ord);
      ordersByUuidMap.set(extUuid, list);
    }
    const rowId = String(ord.id || '').trim();
    const pubId = String(ord.order_id || '').trim();
    if (rowId) {
      const list = ordersByAnyIdMap.get(rowId) || [];
      list.push(ord);
      ordersByAnyIdMap.set(rowId, list);
    }
    if (pubId && pubId !== rowId) {
      const list = ordersByAnyIdMap.get(pubId) || [];
      list.push(ord);
      ordersByAnyIdMap.set(pubId, list);
    }
  });

  confirmedDeletedUuids.forEach((delUuid) => {
    purgeClientTrafficCacheByUuid(delUuid);
  });

  // Snapshot global traffic mutation epoch watermark AND per-UUID traffic mutation state BEFORE panel fetches start
  // so an older in-flight getMyConfigs response cannot overwrite a concurrent traffic reset or recreate a deleted
  // client even if clientTrafficMutationStateByUuid evicts entries while panel requests are in-flight.
  const initialTrafficEpochSnap = getTrafficMutationEpochSnapshot();
  const initialMutationStateByUuid = new Map<string, ClientTrafficMutationState>();
  const inFlightObservedResetByUuid = new Set<string>();
  const inFlightObservedDeletedByUuid = new Set<string>();
  configs.forEach((c) => {
    const normUuid = String(c.uuid || '').trim().toLowerCase();
    if (normUuid) {
      const st = getClientTrafficMutationState(normUuid);
      initialMutationStateByUuid.set(normUuid, st);
      if (st.deletedAtMs > 0) {
        confirmedDeletedUuids.add(normUuid);
        blockedNonActiveUuids.add(normUuid);
        purgeClientTrafficCacheByUuid(normUuid);
      }
    }
  });

  const inFlightMutationListener = (
    mutatedUuid: string,
    reason: 'deleted' | 'reset' | 'clear',
    _state: ClientTrafficMutationState
  ) => {
    const normMutated = String(mutatedUuid || '').trim().toLowerCase();
    if (!normMutated || !initialMutationStateByUuid.has(normMutated)) return;
    if (reason === 'deleted') {
      inFlightObservedDeletedByUuid.add(normMutated);
      inFlightObservedResetByUuid.delete(normMutated);
    } else if (reason === 'reset' && !inFlightObservedDeletedByUuid.has(normMutated)) {
      inFlightObservedResetByUuid.add(normMutated);
    }
  };
  registerClientTrafficCacheInvalidator(inFlightMutationListener);

  try {
  // Use cached inbounds metadata ONLY to resolve missing inboundIds in memory (never to claim Active status or deletion when 3X-UI is unreachable).
  const fetchCachedInbounds = options?.getCachedInboundsFn || getCachedInbounds;
  const fetchLiveInbound = options?.getLiveInboundFn || getLiveInbound;
  const fetchInboundsList = options?.getInboundsFn || getInbounds;

  let resolvedPanelIdentity = String(options?.currentPanelIdentity || '').trim();
  if (
    !resolvedPanelIdentity &&
    options?.currentPanelIdentity === undefined &&
    !options?.getCachedInboundsFn &&
    !options?.getLiveInboundFn &&
    !options?.getInboundsFn
  ) {
    const remainingForPanelIdMs = getRemainingCustomerBudgetMs();
    if (remainingForPanelIdMs >= 100) {
      try {
        const panelIdRes = await raceWithTimeout(
          getCurrentPanelIdentity(),
          Math.min(1500, remainingForPanelIdMs),
          () => {
            console.warn('[Live Traffic Engine] getCurrentPanelIdentity exceeded deadline budget; continuing without shared panel identity.');
          }
        );
        resolvedPanelIdentity = String(panelIdRes || '').trim();
      } catch {
        resolvedPanelIdentity = '';
      }
    }
  }

  let cachedFallbackInbounds: any[] = [];
  const remainingForCachedInboundsMs = getRemainingCustomerBudgetMs();
  if (remainingForCachedInboundsMs >= 20) {
    try {
      const cached = await raceWithTimeout(
        fetchCachedInbounds(resolvedPanelIdentity || undefined),
        remainingForCachedInboundsMs,
        () => {
          console.warn('[Live Traffic Engine] fetchCachedInbounds exceeded customer deadline budget.');
        }
      );
      cachedFallbackInbounds = Array.isArray(cached) ? cached : [];
    } catch {
      cachedFallbackInbounds = [];
    }
  }

  const resolveMissingInboundIds = (inboundList: any[]) => {
    if (!Array.isArray(inboundList) || inboundList.length === 0) return;
    // Pre-scan for duplicate UUIDs across inbounds in this snapshot so ambiguous UUIDs are never auto-mapped
    const inboundIdsByUuid = new Map<string, Set<number>>();
    for (const ib of inboundList) {
      const parsed = parseInboundSettingsClientsStrict(ib);
      if (!parsed.ok) continue;
      for (const cUuid of parsed.clientUuidSet) {
        const set = inboundIdsByUuid.get(cUuid) || new Set<number>();
        set.add(parsed.inboundId);
        inboundIdsByUuid.set(cUuid, set);
      }
    }
    configs.forEach(config => {
      if (config._hasConflictingInboundId || config._hasConflictingOwnership) return;
      if (config.uuid && (config.inboundId === null || config.inboundId === undefined || Number(config.inboundId) <= 0)) {
        const normUuid = String(config.uuid).trim().toLowerCase();
        const candidateInboundIds = inboundIdsByUuid.get(normUuid);
        if (!candidateInboundIds || candidateInboundIds.size !== 1) {
          return;
        }
        const resolvedIbId = Array.from(candidateInboundIds)[0];
        config.inboundId = resolvedIbId;
        console.log(`[Live Traffic Engine] Resolved inboundId ${resolvedIbId} in memory for UUID ${config.uuid}.`);
      }
    });
  };
  resolveMissingInboundIds(cachedFallbackInbounds);

  // Track ONLY live-verified inbounds fetched from 3X-UI
  const liveInboundsMap = new Map<number, any>();
  const cleanlyParsedLiveInboundIds = new Set<number>();
  let liveFullListFetched = false;
  let liveFullListCleanlyParsed = false;

  const hasMissingInboundId = configs.some(
    c =>
      c.uuid &&
      !c._hasConflictingInboundId &&
      !c._hasConflictingOwnership &&
      (c.inboundId === null || c.inboundId === undefined || Number(c.inboundId) <= 0)
  );
  const hasKnownInboundId = configs.some(
    c => c.uuid && c.inboundId !== null && c.inboundId !== undefined && Number(c.inboundId) > 0
  );

  // Cold-start recovery: if any config lacks inboundId, use single-flight getInbounds(false, { panelIdentity })
  // within the shared customer request deadline without cancelling the shared background request if one caller stops waiting early.
  if (hasMissingInboundId && configs.length > 0) {
    const remainingForColdStartMs = getRemainingCustomerBudgetMs();
    const requestedColdStartMs =
      options?.coldStartTimeoutMs && Number.isFinite(options.coldStartTimeoutMs) && options.coldStartTimeoutMs > 0
        ? Math.floor(options.coldStartTimeoutMs)
        : CUSTOMER_MAX_COLD_START_WAIT_MS;
    // When customer also has configs with known inboundId, reserve up to 1200ms of remaining budget
    // for the per-inbound live check unless an explicit coldStartTimeoutMs was provided.
    const coldStartBudgetCapMs =
      options?.coldStartTimeoutMs !== undefined
        ? remainingForColdStartMs
        : hasKnownInboundId
          ? Math.max(0, remainingForColdStartMs - Math.min(1200, Math.floor(remainingForColdStartMs * 0.35)))
          : remainingForColdStartMs;
    const coldStartWaitMs = Math.min(requestedColdStartMs, coldStartBudgetCapMs);

    if (coldStartWaitMs >= 20) {
      const cacheTsBefore = getInboundsSnapshotTimestamp();
      try {
        const freshList = await raceWithTimeout(
          fetchInboundsList(false, resolvedPanelIdentity ? { panelIdentity: resolvedPanelIdentity } : undefined),
          coldStartWaitMs,
          () => {
            console.warn(`[Live Traffic Engine] Cold-start full inbound list wait exceeded ${coldStartWaitMs}ms; continuing with shared warm-up.`);
          }
        );
        if (Array.isArray(freshList) && freshList.length > 0) {
          cachedFallbackInbounds = freshList;
          resolveMissingInboundIds(freshList);

          const cacheTsAfter = getInboundsSnapshotTimestamp();
          const isFreshLiveFetch =
            Boolean(options?.getInboundsFn) ||
            cacheTsAfter > cacheTsBefore ||
            (cacheTsAfter > 0 && Date.now() - cacheTsAfter < 10000);

          if (isFreshLiveFetch) {
            liveFullListFetched = true;
            let allClean = true;
            freshList.forEach(ib => {
              const parsed = parseInboundSettingsClientsStrict(ib);
              if (parsed.ok) {
                liveInboundsMap.set(parsed.inboundId, ib);
                cleanlyParsedLiveInboundIds.add(parsed.inboundId);
              } else {
                allClean = false;
              }
            });
            liveFullListCleanlyParsed = allClean;
          }
        }
      } catch (err: any) {
        console.warn('[Live Traffic Engine] Cold-start inbound lookup failed:', err?.message || err);
      }
    } else {
      console.warn(
        `[Live Traffic Engine] Skipping cold-start wait: customer request deadline budget exhausted (${remainingForColdStartMs}ms remaining).`
      );
    }
  }

  const userInboundIds = Array.from(new Set(
    configs
      .filter(c => !c._hasConflictingInboundId && !c._hasConflictingOwnership)
      .map(c => c.inboundId)
      .filter(id => id !== null && id !== undefined && Number(id) > 0)
      .map(id => Number(id))
  )).filter(id => !liveInboundsMap.has(id));

  if (userInboundIds.length > 0) {
    const remainingForLiveInboundMs = getRemainingCustomerBudgetMs();
    const requestedLiveInboundMs =
      options?.liveInboundTimeoutMs && Number.isFinite(options.liveInboundTimeoutMs) && options.liveInboundTimeoutMs > 0
        ? Math.floor(options.liveInboundTimeoutMs)
        : CUSTOMER_MAX_LIVE_INBOUND_WAIT_MS;
    const liveInboundWaitMs = Math.min(requestedLiveInboundMs, remainingForLiveInboundMs);

    if (liveInboundWaitMs >= 20) {
      try {
        console.log(`[Live Traffic Engine] Fetching ${userInboundIds.length} customer inbounds from 3X-UI (budget ${liveInboundWaitMs}ms)...`);
        const liveResults =
          (await raceWithTimeout(
            Promise.all(userInboundIds.map(id => fetchLiveInbound(id))),
            liveInboundWaitMs,
            () => {
              console.warn(`[Live Traffic Engine] Live inbound fetch timed out after ${liveInboundWaitMs}ms; panel status unverified.`);
            }
          )) || [];
        liveResults.forEach(ib => {
          if (ib && ib.id) {
            const parsed = parseInboundSettingsClientsStrict(ib);
            if (parsed.ok) {
              liveInboundsMap.set(parsed.inboundId, ib);
              cleanlyParsedLiveInboundIds.add(parsed.inboundId);
            }
          }
        });
      } catch (err: any) {
        console.warn(`[Live Traffic Engine] Error fetching live customer inbounds:`, err.message || err);
      }
    } else {
      console.warn(
        `[Live Traffic Engine] Skipping live inbound fetch: customer request deadline budget exhausted (${remainingForLiveInboundMs}ms remaining); returning safe Status Unavailable fallback.`
      );
    }
  }

  const liveInbounds = Array.from(liveInboundsMap.values());

  // Build strict live UUID map from cleanly parsed settings.clients[] ONLY (NEVER clientStats)
  // Reject duplicate UUIDs across inbounds so ambiguous UUID mappings are never trusted.
  const liveClientByUuid = new Map<string, { inbound: any; client: any }>();
  const duplicateLiveUuids = new Set<string>();
  for (const ib of liveInbounds) {
    const parsed = parseInboundSettingsClientsStrict(ib);
    if (!parsed.ok) continue;
    for (const c of parsed.clients) {
      const cUuid = String(c?.id || '').trim().toLowerCase();
      if (!cUuid) continue;
      if (duplicateLiveUuids.has(cUuid)) {
        continue;
      }
      if (liveClientByUuid.has(cUuid)) {
        liveClientByUuid.delete(cUuid);
        duplicateLiveUuids.add(cUuid);
        continue;
      }
      liveClientByUuid.set(cUuid, { inbound: ib, client: c });
    }
  }

  // Build read-only fallback client map from cached inbounds strictly for preserving numeric
  // traffic usage when the panel is temporarily unreachable (never for Active/Disabled/Deleted claims).
  // Reject duplicate UUIDs across cached inbounds.
  const cachedTrafficByUuid = new Map<string, { inbound: any; client: any }>();
  const duplicateCachedUuids = new Set<string>();
  for (const ib of cachedFallbackInbounds) {
    const parsed = parseInboundSettingsClientsStrict(ib);
    if (!parsed.ok) continue;
    for (const c of parsed.clients) {
      const cUuid = String(c?.id || '').trim().toLowerCase();
      if (!cUuid) continue;
      if (duplicateCachedUuids.has(cUuid)) {
        continue;
      }
      if (cachedTrafficByUuid.has(cUuid)) {
        cachedTrafficByUuid.delete(cUuid);
        duplicateCachedUuids.add(cUuid);
        continue;
      }
      cachedTrafficByUuid.set(cUuid, { inbound: ib, client: c });
    }
  }

  const verifyClientOwnershipAndInboundMatch = (params: {
    inbound: any;
    client: any;
    config: any;
    requireSharedFallbackVerification: boolean;
  }): boolean => {
    const { inbound, client, config, requireSharedFallbackVerification } = params;
    if (!inbound || !client || !config) return false;
    if (config._hasConflictingOwnership || config._hasConflictingInboundId) {
      return false;
    }
    const recPanel = String(config._recordPanelIdentity || '').trim();
    if (recPanel && resolvedPanelIdentity && recPanel !== resolvedPanelIdentity) {
      return false;
    }
    const persistedIbId =
      config._persistedInboundId !== null &&
      config._persistedInboundId !== undefined &&
      Number(config._persistedInboundId) > 0
        ? Number(config._persistedInboundId)
        : null;
    const candidateIbId = Number(inbound.id);
    if (persistedIbId !== null && candidateIbId !== persistedIbId) {
      return false;
    }

    const cliEmail = String(client.email || '').trim().toLowerCase();
    const ownerEmail = String(config._ownerEmail || userEmail || '').trim().toLowerCase();
    const expectedRemark = String(config.packageName || '').trim().toLowerCase();
    const expectedOrderId = String(config.orderId || '').trim().toLowerCase();

    if (requireSharedFallbackVerification) {
      // Shared cachedFallbackInbounds requires explicit record panel identity match and verified client identity match
      if (!resolvedPanelIdentity || !recPanel || recPanel !== resolvedPanelIdentity) {
        return false;
      }
      if (!cliEmail) {
        return false;
      }
      if (cliEmail.includes('@') && ownerEmail && cliEmail !== ownerEmail) {
        return false;
      }
      const matchesEmail = Boolean(ownerEmail && cliEmail === ownerEmail);
      const matchesRemark = Boolean(expectedRemark && cliEmail === expectedRemark);
      const matchesOrderId = Boolean(expectedOrderId && cliEmail.includes(expectedOrderId));
      const matchesEmailLocalPart = Boolean(
        ownerEmail &&
          !cliEmail.includes('@') &&
          ownerEmail.includes('@') &&
          cliEmail.startsWith(ownerEmail.split('@')[0])
      );
      if (!matchesEmail && !matchesRemark && !matchesOrderId && !matchesEmailLocalPart) {
        return false;
      }
    }

    return true;
  };

  // Collect legacy records requiring separate offline reconciliation (NEVER auto-backfilled on customer reads)
  const legacyReconciliationRecords: LegacyReconciliationRecord[] = [];
  for (const config of configs) {
    const missingFields: string[] = [];
    if (!config._persistedInboundId) missingFields.push('inbound_id');
    if (!config._recordPanelIdentity && !config._recordServerId) missingFields.push('panel_identity');
    if (!config._persistedHasUserId) missingFields.push('user_id');
    if (missingFields.length > 0 && config.uuid) {
      legacyReconciliationRecords.push({
        uuid: String(config.uuid).trim(),
        orderId: String(config.orderId || '').trim(),
        missingFields,
        source: config._legacySource || 'vpn_accounts',
      });
    }
  }
  if (legacyReconciliationRecords.length > 0) {
    console.warn(
      `[Legacy Reconciliation] ${legacyReconciliationRecords.length} customer record(s) require separate metadata reconciliation: ${legacyReconciliationRecords
        .map((r) => `${r.uuid}(missing:${r.missingFields.join(',')})`)
        .join(', ')}`
    );
  }

  // Note: Deletion verification is intentionally decoupled from customer HTTP reads and executed
  // exclusively by the background panel-wide 2-minute synchronizer so customer requests stay fast
  // and never contend on durable deletion locks or judge deletion from single-inbound fetches.
  const finalConfigs: any[] = [];
  const maxCacheEntries = options?.maxTrafficCacheEntries ?? CLIENT_TRAFFIC_CACHE_MAX_ENTRIES;
  const afterTrafficEpochSnap = getTrafficMutationEpochSnapshot();

  for (const config of configs) {
    let up = 0;
    let down = 0;
    let total = config._rawLimit || 0;
    let expiryTime = 0;
    let lastOnline = 0;
    let inboundId = config.inboundId ? Number(config.inboundId) : null;
    const normUuid = String(config.uuid || '').trim().toLowerCase();
    let clientEmail = userEmail;
    let matchedInbound: any = null;
    let stat: any = null;
    let foundClient: any = null;
    let trafficSource: VpnTrafficSource = 'unknown';
    let trafficVerified = false;
    let usedTrafficKnown = false;
    let postEvictionConfirmedResetInDb = false;
    let postEvictionFreshLiveVerified = false;
    let postEvictionFreshLiveInbound: any = null;
    let postEvictionFreshLiveClient: any = null;

    const currentMutationState = normUuid
      ? getClientTrafficMutationState(normUuid)
      : { seq: 0, lastResetAtMs: 0, deletedAtMs: 0, epoch: 0, present: false };
    const initialMutationState = normUuid ? initialMutationStateByUuid.get(normUuid) : undefined;
    const startedMutationSeq = initialMutationState?.seq ?? 0;

    // Detect if this UUID's mutation state was evicted or became uncertain during this in-flight getMyConfigs read
    const mutationStateEvictedMidFlight = Boolean(
      normUuid &&
        !currentMutationState.present &&
        (initialMutationState?.present ||
          afterTrafficEpochSnap.maxEvictedEpoch > initialTrafficEpochSnap.currentEpoch ||
          afterTrafficEpochSnap.maxEvictedEpoch > initialTrafficEpochSnap.maxEvictedEpoch)
    );
    const mutationOccurredMidFlight =
      currentMutationState.seq !== startedMutationSeq || mutationStateEvictedMidFlight;

    if (mutationStateEvictedMidFlight && normUuid) {
      // Never trust or retain cached traffic when mutation history for this UUID was evicted during an in-flight read
      purgeClientTrafficCacheByUuid(normUuid);

      // Authoritative customer-scoped DB recheck for deletion and post-reset evidence (fail-closed on DB failure/timeout)
      const [freshAccRes, freshCfgRes]: any = await runRequiredCustomerStage(
        'authoritative_post_eviction_recheck',
        async () => {
          const accPromise = db.from('vpn_accounts').select('*').eq('uuid', config.uuid);
          const cfgPromise = db.from('vpn_configs').select('*').eq('uuid', config.uuid);
          return Promise.all([accPromise, cfgPromise]);
        }
      ).catch((recheckErr: any) => {
        if (recheckErr?.code === 'CUSTOMER_REQUEST_DEADLINE_EXCEEDED') {
          throw recheckErr;
        }
        const failClosedErr: any = new Error(
          `Authoritative database recheck after traffic mutation eviction failed for UUID ${config.uuid}: ${recheckErr?.message || recheckErr}`
        );
        failClosedErr.status = 503;
        failClosedErr.statusCode = 503;
        failClosedErr.code = 'AUTHORITATIVE_MUTATION_RECHECK_FAILED';
        failClosedErr.retryable = true;
        throw failClosedErr;
      });

      if (freshAccRes?.error || freshCfgRes?.error) {
        const dbErr = freshAccRes?.error || freshCfgRes?.error;
        const failClosedErr: any = new Error(
          `Authoritative database recheck returned error for UUID ${config.uuid}: ${dbErr?.message || dbErr}`
        );
        failClosedErr.status = 503;
        failClosedErr.statusCode = 503;
        failClosedErr.code = 'AUTHORITATIVE_MUTATION_RECHECK_FAILED';
        failClosedErr.retryable = true;
        throw failClosedErr;
      }

      const freshAccRows: any[] = Array.isArray(freshAccRes?.data) ? freshAccRes.data : [];
      const freshCfgRows: any[] = Array.isArray(freshCfgRes?.data) ? freshCfgRes.data : [];

      const customerFreshAccs = freshAccRows.filter((acc) => {
        const docUserId = String(acc.user_id || '').trim();
        const docEmail = String(acc.email || '').toLowerCase().trim();
        return userUid
          ? (docUserId === userUid || (!docUserId && userEmail && docEmail === userEmail))
          : (userEmail && docEmail === userEmail);
      });
      const customerFreshCfgs = freshCfgRows.filter((cfg) => {
        const docUserId = String(cfg.user_id || cfg.customer_uid || '').trim();
        return !userUid || !docUserId || docUserId === userUid;
      });

      const isRecheckDeleted =
        customerFreshAccs.some(
          (acc) =>
            String(acc.status || '').toLowerCase().trim() === 'deleted' ||
            Boolean(acc.deleted_from_panel_at)
        ) ||
        customerFreshCfgs.some((cfg) => {
          const st = String(cfg.status || '').toLowerCase().trim();
          return (
            st === 'deleted' ||
            st === 'rejected' ||
            st === 'cancelled' ||
            st === 'revoked' ||
            Boolean(cfg.deleted_from_panel_at)
          );
        }) ||
        (config._legacySource === 'vpn_accounts' && customerFreshAccs.length === 0);

      if (isRecheckDeleted) {
        confirmedDeletedUuids.add(normUuid);
        blockedNonActiveUuids.add(normUuid);
        purgeClientTrafficCacheByUuid(normUuid);
        continue;
      }

      if (customerFreshAccs.length > 0) {
        const latestAcc = customerFreshAccs[0];
        config._storedUpBytes = Math.max(0, Number(latestAcc.up_bytes ?? 0) || 0);
        config._storedDownBytes = Math.max(0, Number(latestAcc.down_bytes ?? 0) || 0);
        config._storedUsedBytes = Math.max(0, Number(latestAcc.used_bytes ?? 0) || 0);
        config._dbStatus = String(latestAcc.status || config._dbStatus || 'active').toLowerCase().trim();

        const latestResetAtMs =
          parseTimestampToMsSafe(latestAcc.last_traffic_reset_at || latestAcc.traffic_reset_at) || 0;
        postEvictionConfirmedResetInDb = Boolean(
          inFlightObservedResetByUuid.has(normUuid) ||
            (latestResetAtMs > 0 &&
              (latestResetAtMs >= dbStart || latestResetAtMs > (config._initialLastResetAtMs || 0)))
        );
      } else if (inFlightObservedResetByUuid.has(normUuid)) {
        postEvictionConfirmedResetInDb = true;
      }

      if (customerFreshCfgs.length > 0 && (!customerFreshAccs.length || config._dbStatus === 'active')) {
        const latestCfgSt = String(customerFreshCfgs[0].status || '').toLowerCase().trim();
        if (latestCfgSt === 'disabled' || latestCfgSt === 'expired') {
          config._dbStatus = latestCfgSt;
        }
      }

      // If no confirmed traffic reset was recorded in DB during this request, perform a bounded fresh post-eviction
      // live panel read (explicitly bypassing stale inbound caches) within the remaining customer deadline
      // rather than trusting missing/null/default-0 or stale DB counters.
      if (
        !postEvictionConfirmedResetInDb &&
        inboundId &&
        Number(inboundId) > 0 &&
        !config._hasConflictingInboundId &&
        !config._hasConflictingOwnership
      ) {
        const remainingForPostEvictLiveMs = getRemainingCustomerBudgetMs();
        const requestedLiveMs =
          options?.liveInboundTimeoutMs &&
          Number.isFinite(options.liveInboundTimeoutMs) &&
          options.liveInboundTimeoutMs > 0
            ? Math.floor(options.liveInboundTimeoutMs)
            : CUSTOMER_MAX_LIVE_INBOUND_WAIT_MS;
        const postEvictLiveWaitMs = Math.min(requestedLiveMs, remainingForPostEvictLiveMs);
        if (postEvictLiveWaitMs >= 20) {
          const epochBeforeRefetch = getTrafficMutationEpochSnapshot();
          const mutStateBeforeRefetch = getClientTrafficMutationState(normUuid);
          try {
            invalidateInboundCache(Number(inboundId));
            const freshIb = await raceWithTimeout(
              fetchLiveInbound(Number(inboundId), {
                forceRefresh: true,
                timeoutMs: postEvictLiveWaitMs,
              }),
              postEvictLiveWaitMs,
              () => {
                console.warn(
                  `[Live Traffic Engine] Post-eviction fresh live inbound read timed out after ${postEvictLiveWaitMs}ms for UUID ${normUuid}.`
                );
              }
            );
            if (freshIb && freshIb.id) {
              const parsedFresh = parseInboundSettingsClientsStrict(freshIb);
              const epochAfterRefetch = getTrafficMutationEpochSnapshot();
              const mutStateAfterRefetch = getClientTrafficMutationState(normUuid);
              const noMutationDuringRefetch =
                mutStateAfterRefetch.deletedAtMs === 0 &&
                mutStateAfterRefetch.seq === mutStateBeforeRefetch.seq &&
                epochAfterRefetch.maxEvictedEpoch === epochBeforeRefetch.maxEvictedEpoch;
              if (parsedFresh.ok && noMutationDuringRefetch) {
                const matchingClients = parsedFresh.clients.filter(
                  (c: any) => String(c?.id || '').trim().toLowerCase() === normUuid
                );
                if (
                  matchingClients.length === 1 &&
                  verifyClientOwnershipAndInboundMatch({
                    inbound: freshIb,
                    client: matchingClients[0],
                    config,
                    requireSharedFallbackVerification: false,
                  })
                ) {
                  postEvictionFreshLiveInbound = freshIb;
                  postEvictionFreshLiveClient = matchingClients[0];
                  postEvictionFreshLiveVerified = true;
                  liveInboundsMap.set(parsedFresh.inboundId, freshIb);
                  cleanlyParsedLiveInboundIds.add(parsedFresh.inboundId);
                }
              }
            }
          } catch {
            // Fall through to safe unknown traffic fallback
          }
        }
      }
    }

    // If background deletion sync confirmed permanent deletion before or while this getMyConfigs read was in-flight,
    // immediately purge cached traffic, record in confirmedDeletedUuids, and never expose or re-cache the deleted config.
    if (
      normUuid &&
      (currentMutationState.deletedAtMs > 0 ||
        inFlightObservedDeletedByUuid.has(normUuid) ||
        confirmedDeletedUuids.has(normUuid) ||
        blockedNonActiveUuids.has(normUuid) ||
        nonApprovedOrderUuids.has(normUuid))
    ) {
      purgeClientTrafficCacheByUuid(normUuid);
      if (currentMutationState.deletedAtMs > 0 || inFlightObservedDeletedByUuid.has(normUuid)) {
        confirmedDeletedUuids.add(normUuid);
      }
      continue;
    }

    const hasVerifiedUidOwnership = Boolean(
      userUid &&
        config._persistedHasUserId &&
        !config._hasConflictingOwnership &&
        !config._hasConflictingInboundId &&
        config._ownerUid &&
        String(config._ownerUid).trim() === userUid
    );
    const scopedTrafficCacheKey = buildCustomerTrafficCacheKey({
      panelIdentity: resolvedPanelIdentity,
      userUid,
      clientUuid: normUuid,
      hasVerifiedOwnership: hasVerifiedUidOwnership,
      recordPanelIdentity: config._recordPanelIdentity,
    });

    if (postEvictionFreshLiveVerified && postEvictionFreshLiveInbound && postEvictionFreshLiveClient) {
      matchedInbound = postEvictionFreshLiveInbound;
      foundClient = postEvictionFreshLiveClient;
    } else if (normUuid && !duplicateLiveUuids.has(normUuid) && liveClientByUuid.has(normUuid)) {
      const hit = liveClientByUuid.get(normUuid)!;
      if (
        verifyClientOwnershipAndInboundMatch({
          inbound: hit.inbound,
          client: hit.client,
          config,
          requireSharedFallbackVerification: false,
        })
      ) {
        matchedInbound = hit.inbound;
        foundClient = hit.client;
      }
    }

    if (matchedInbound && foundClient) {
      if (!inboundId) {
        inboundId = Number(matchedInbound.id);
      }
      clientEmail = foundClient.email || userEmail;
      expiryTime = foundClient.expiryTime || 0;

      if (foundClient.totalGB !== undefined && Number(foundClient.totalGB) >= 0) {
        total = Number(foundClient.totalGB) || 0;
      } else if (foundClient.totalBytes !== undefined) {
        total = Number(foundClient.totalBytes) || 0;
      } else if (foundClient.total !== undefined) {
        total = Number(foundClient.total) || 0;
      }

      const clientStats = matchedInbound.clientStats || [];
      if (config.uuid) {
        stat = clientStats.find((s: any) => String(s.id || '').toLowerCase() === normUuid) ||
               clientStats.find((s: any) => String(s.email || '').toLowerCase() === String(clientEmail).toLowerCase());
      }

      const extractTraffic = (obj: any, type: 'up' | 'down') => {
        if (!obj) return 0;
        const val = obj[type] || obj[`${type}load`] || 0;
        return typeof val === 'number' ? val : (parseFloat(val) || 0);
      };

      const clientUp = extractTraffic(foundClient, 'up');
      const clientDown = extractTraffic(foundClient, 'down');

      if (stat) {
        const statUp = extractTraffic(stat, 'up');
        const statDown = extractTraffic(stat, 'down');

        up = Math.max(statUp, clientUp, up);
        down = Math.max(statDown, clientDown, down);

        if (stat.total !== undefined && Number(stat.total) > 0) {
          total = Number(stat.total);
        }
        if (stat.expiryTime !== undefined && Number(stat.expiryTime) > 0) {
          expiryTime = Number(stat.expiryTime);
        }
        lastOnline = stat.lastOnline || stat.online || stat.time || 0;
      } else {
        up = Math.max(clientUp, up);
        down = Math.max(clientDown, down);
        lastOnline = foundClient.lastOnline || foundClient.online || foundClient.time || 0;
      }

      // If a concurrent traffic reset completed while this getMyConfigs read was in-flight,
      // or if mutation state was evicted mid-flight, only report confirmed reset zero when authoritative
      // reset evidence exists; otherwise require a fresh post-eviction live read or fall back to unknown traffic.
      if (mutationStateEvictedMidFlight) {
        if (postEvictionConfirmedResetInDb) {
          up = 0;
          down = 0;
          trafficSource = 'reset_confirmed';
          trafficVerified = true;
          usedTrafficKnown = true;
        } else if (postEvictionFreshLiveVerified) {
          trafficSource = 'live';
          trafficVerified = true;
          usedTrafficKnown = true;
        } else {
          up = 0;
          down = 0;
          trafficSource = 'unknown';
          trafficVerified = false;
          usedTrafficKnown = false;
        }
      } else if (mutationOccurredMidFlight && currentMutationState.lastResetAtMs > 0) {
        up = 0;
        down = 0;
        trafficSource = 'reset_confirmed';
        trafficVerified = true;
        usedTrafficKnown = true;
      } else {
        trafficSource = 'live';
        trafficVerified = true;
        usedTrafficKnown = true;
        if (
          scopedTrafficCacheKey &&
          !mutationOccurredMidFlight &&
          currentMutationState.deletedAtMs === 0
        ) {
          setScopedClientTrafficCacheEntry(
            {
              cacheKey: scopedTrafficCacheKey,
              panelIdentity: resolvedPanelIdentity,
              userUid,
              clientUuid: normUuid,
              up,
              down,
              total,
              expiryTime,
              lastOnline,
              updatedAtMs: nowMs,
              mutationSeq: currentMutationState.seq,
            },
            nowMs,
            maxCacheEntries
          );
        }
      }
    } else {
      console.log(`[Provisioning Audit] No live 3X-UI state verified for UUID: ${config.uuid}.`);
      const lastKnown = mutationStateEvictedMidFlight
        ? undefined
        : getScopedClientTrafficCacheEntry(
            scopedTrafficCacheKey,
            nowMs,
            currentMutationState.seq,
            afterTrafficEpochSnap.maxEvictedEpoch,
            Boolean(currentMutationState.present)
          );
      if (lastKnown) {
        up = lastKnown.up;
        down = lastKnown.down;
        if (lastKnown.total > 0) total = lastKnown.total;
        if (lastKnown.expiryTime > 0) expiryTime = lastKnown.expiryTime;
        lastOnline = lastKnown.lastOnline;
        trafficSource = 'cached_scoped';
        trafficVerified = true;
        usedTrafficKnown = true;
      } else if (
        (!mutationStateEvictedMidFlight && currentMutationState.lastResetAtMs > 0) ||
        (mutationStateEvictedMidFlight && postEvictionConfirmedResetInDb)
      ) {
        // A confirmed traffic reset occurred and no post-reset live read has populated newer usage yet
        up = 0;
        down = 0;
        trafficSource = 'reset_confirmed';
        trafficVerified = true;
        usedTrafficKnown = true;
      } else {
        // Only consult shared cachedTrafficByUuid when panel identity, customer UID ownership, inbound identity,
        // and client email/ownership are all verified and mutation state was not evicted mid-flight.
        const rawCachedHit =
          !mutationStateEvictedMidFlight &&
          scopedTrafficCacheKey &&
          normUuid &&
          !duplicateCachedUuids.has(normUuid)
            ? cachedTrafficByUuid.get(normUuid)
            : undefined;
        const cachedHit =
          rawCachedHit &&
          verifyClientOwnershipAndInboundMatch({
            inbound: rawCachedHit.inbound,
            client: rawCachedHit.client,
            config,
            requireSharedFallbackVerification: true,
          })
            ? rawCachedHit
            : undefined;
        const extractTraffic = (obj: any, type: 'up' | 'down') => {
          if (!obj) return 0;
          const val = obj[type] || obj[`${type}load`] || 0;
          return typeof val === 'number' ? val : (parseFloat(val) || 0);
        };
        if (cachedHit) {
          const cachedIb = cachedHit.inbound;
          const cachedCli = cachedHit.client;
          const cachedEmail = String(cachedCli.email || userEmail || '').trim().toLowerCase();
          const cachedStats = Array.isArray(cachedIb?.clientStats) ? cachedIb.clientStats : [];
          const cachedStat =
            cachedStats.find((s: any) => String(s?.id || '').toLowerCase() === normUuid) ||
            cachedStats.find((s: any) => String(s?.email || '').toLowerCase() === cachedEmail);
          up = Math.max(extractTraffic(cachedStat, 'up'), extractTraffic(cachedCli, 'up'));
          down = Math.max(extractTraffic(cachedStat, 'down'), extractTraffic(cachedCli, 'down'));
          if (cachedStat?.total !== undefined && Number(cachedStat.total) > 0) {
            total = Number(cachedStat.total);
          } else if (cachedCli.totalGB !== undefined && Number(cachedCli.totalGB) > 0) {
            total = Number(cachedCli.totalGB);
          }
          expiryTime = Number(cachedStat?.expiryTime || cachedCli?.expiryTime || 0) || 0;
          lastOnline = cachedStat?.lastOnline || cachedStat?.online || cachedCli?.lastOnline || 0;
          trafficSource = 'cached_inbound';
          trafficVerified = true;
          usedTrafficKnown = true;
        } else if (!mutationStateEvictedMidFlight) {
          const storedUp = Math.max(0, Number(config._storedUpBytes || 0));
          const storedDown = Math.max(0, Number(config._storedDownBytes || 0));
          const storedUsed = Math.max(0, Number(config._storedUsedBytes || 0));
          const hasConfirmedResetZeroInDb = Boolean(
            (config._initialLastResetAtMs || 0) > 0 &&
              config._hasExplicitStoredCounters &&
              storedUp === 0 &&
              storedDown === 0 &&
              storedUsed === 0
          );
          if (storedUp + storedDown > 0) {
            up = storedUp;
            down = storedDown;
            trafficSource = 'stored_db';
            trafficVerified = true;
            usedTrafficKnown = true;
          } else if (storedUsed > 0) {
            up = 0;
            down = storedUsed;
            trafficSource = 'stored_db';
            trafficVerified = true;
            usedTrafficKnown = true;
          } else if (hasConfirmedResetZeroInDb) {
            up = 0;
            down = 0;
            trafficSource = 'reset_confirmed';
            trafficVerified = true;
            usedTrafficKnown = true;
          } else {
            up = 0;
            down = 0;
            trafficSource = 'unknown';
            trafficVerified = false;
            usedTrafficKnown = false;
          }
        } else {
          up = 0;
          down = 0;
          trafficSource = 'unknown';
          trafficVerified = false;
          usedTrafficKnown = false;
        }
      }
    }

    let lastOnlineMs = lastOnline;
    if (lastOnlineMs > 0 && lastOnlineMs < 10000000000) {
      lastOnlineMs = lastOnlineMs * 1000;
    }

    // Compute authoritative traffic reset eligibility using already-fetched DB + live 3X-UI state (zero extra panel calls)
    const accForReset = normUuid ? vpnAccountByUuid.get(normUuid) || null : null;
    const cfgForReset = normUuid ? vpnConfigByUuid.get(normUuid) || null : null;
    const orderIdKey = String(config.orderId || '').trim();
    const relatedOrdersSet = new Set<any>([
      ...(normUuid ? ordersByUuidMap.get(normUuid) || [] : []),
      ...(orderIdKey ? ordersByAnyIdMap.get(orderIdKey) || [] : []),
    ]);
    const relatedGrantsSet = new Set<any>([
      ...(normUuid ? grantsByUuid.get(normUuid) || [] : []),
      ...(orderIdKey ? grantsByOrderIdList.get(orderIdKey) || [] : []),
    ]);
    const resetEligibility = evaluateCustomerTrafficResetEligibility({
      vpnAccount: accForReset,
      vpnConfig: cfgForReset,
      orders: Array.from(relatedOrdersSet),
      grants: Array.from(relatedGrantsSet),
      ownershipSource: accForReset ? 'vpn_accounts' : cfgForReset ? 'vpn_configs' : 'orders',
      panelReachable: Boolean(matchedInbound && foundClient),
      liveInbound: matchedInbound,
      liveClient: foundClient,
      liveStat: stat,
      nowMs,
    });

    // Establish whether total === 0 represents a verified Unlimited entitlement vs an unverified/unknown quota
    let hasFiniteQuotaConflict = Boolean(config.isTrial);
    let hasExplicitUnlimitedEvidence = Boolean(resetEligibility.isUnlimitedPlan);

    if (accForReset) {
      if (
        accForReset.total_bytes !== undefined &&
        accForReset.total_bytes !== null &&
        accForReset.total_bytes !== ''
      ) {
        const cls = classifyNumericQuotaBytes(accForReset.total_bytes, { allowZeroAsUnlimited: false });
        if (cls === 'finite' || cls === 'invalid') hasFiniteQuotaConflict = true;
      }
      if (
        accForReset.data_limit !== undefined &&
        accForReset.data_limit !== null &&
        String(accForReset.data_limit).trim() !== ''
      ) {
        const cls = classifyQuotaText(accForReset.data_limit);
        if (cls === 'finite' || cls === 'invalid') hasFiniteQuotaConflict = true;
        else if (cls === 'unlimited') hasExplicitUnlimitedEvidence = true;
      }
      if (accForReset.package_name && classifyQuotaText(accForReset.package_name) === 'finite') {
        hasFiniteQuotaConflict = true;
      }
    }

    if (cfgForReset) {
      for (const val of [cfgForReset.data_limit, cfgForReset.traffic_limit]) {
        if (val === undefined || val === null || String(val).trim() === '') continue;
        const cls =
          typeof val === 'number'
            ? classifyNumericQuotaBytes(val, { allowZeroAsUnlimited: false })
            : classifyQuotaText(val);
        if (cls === 'finite' || cls === 'invalid') hasFiniteQuotaConflict = true;
        else if (cls === 'unlimited') hasExplicitUnlimitedEvidence = true;
      }
    }

    for (const g of relatedGrantsSet) {
      if (!g || typeof g !== 'object') continue;
      const gStatus = String(g.status || 'active').toLowerCase().trim();
      if (gStatus === 'revoked' || gStatus === 'rejected' || gStatus === 'cancelled' || gStatus === 'deleted') {
        continue;
      }
      if (g.granted_unlimited === false) hasFiniteQuotaConflict = true;
      if (
        g.granted_total_bytes !== undefined &&
        g.granted_total_bytes !== null &&
        g.granted_total_bytes !== '' &&
        Number(g.granted_total_bytes) > 0
      ) {
        hasFiniteQuotaConflict = true;
      }
      if (g.granted_unlimited === true) hasExplicitUnlimitedEvidence = true;
    }

    for (const ord of relatedOrdersSet) {
      if (!ord || typeof ord !== 'object') continue;
      if (isOrderRejectedOrRevoked(ord)) continue;
      const pm = parsePaymentMethodJsonSafe(ord.payment_method);
      if (
        ord.is_unlimited === false ||
        pm.is_unlimited === false ||
        pm.isUnlimited === false ||
        pm.unlimited === false
      ) {
        hasFiniteQuotaConflict = true;
      }
      if (
        ord.is_unlimited === true ||
        pm.is_unlimited === true ||
        pm.isUnlimited === true ||
        pm.unlimited === true
      ) {
        hasExplicitUnlimitedEvidence = true;
      }
      for (const val of [
        ord.data_limit,
        ord.traffic_limit,
        pm.data_limit,
        pm.dataLimit,
        pm.traffic_limit,
        pm.trafficLimit,
        pm.quota,
      ]) {
        if (val === undefined || val === null || String(val).trim() === '') continue;
        const cls = classifyQuotaText(val);
        if (cls === 'finite' || cls === 'invalid') hasFiniteQuotaConflict = true;
        else if (cls === 'unlimited') hasExplicitUnlimitedEvidence = true;
      }
    }

    const hasExplicitLiveUnlimitedTotal = Boolean(
      matchedInbound &&
        foundClient &&
        foundClient.totalGB !== undefined &&
        foundClient.totalGB !== null &&
        foundClient.totalGB !== '' &&
        Number(foundClient.totalGB) === 0 &&
        (!stat || stat.total === undefined || stat.total === null || Number(stat.total) === 0)
    );
    if (hasExplicitLiveUnlimitedTotal) {
      hasExplicitUnlimitedEvidence = true;
    }

    const isConfirmedUnlimitedQuota = Boolean(
      total <= 0 && !hasFiniteQuotaConflict && hasExplicitUnlimitedEvidence
    );
    const quotaVerified = total > 0 || isConfirmedUnlimitedQuota;

    const totalUsed = usedTrafficKnown ? up + down : 0;
    const remainingTraffic =
      total > 0 && usedTrafficKnown ? Math.max(total - totalUsed, 0) : 0;
    const remainingTrafficKnown =
      (total > 0 && usedTrafficKnown) || isConfirmedUnlimitedQuota;

    const usedGB = usedTrafficKnown
      ? parseFloat((totalUsed / (1024 * 1024 * 1024)).toFixed(2))
      : 0;
    const remainingGB: number | string =
      total > 0
        ? usedTrafficKnown
          ? parseFloat((remainingTraffic / (1024 * 1024 * 1024)).toFixed(2))
          : 'Unavailable'
        : isConfirmedUnlimitedQuota
          ? 'Unlimited'
          : 'Unavailable';
    const resolvedTrafficLimit =
      total > 0
        ? `${parseFloat((total / (1024 * 1024 * 1024)).toFixed(2))}GB`
        : isConfirmedUnlimitedQuota
          ? 'Unlimited'
          : 'Unavailable';

    let expTimeMs = expiryTime;
    if (expTimeMs > 0 && expTimeMs < 10000000000) {
      expTimeMs = expTimeMs * 1000;
    }
    if ((!expTimeMs || expTimeMs <= 0) && config.expiryDate) {
      const parsed = new Date(config.expiryDate).getTime();
      if (!isNaN(parsed)) expTimeMs = parsed;
    }

    const expectedInboundCleanlyFetched = Boolean(
      !config._hasConflictingInboundId &&
      !config._hasConflictingOwnership &&
      !duplicateLiveUuids.has(normUuid) &&
      ((inboundId && cleanlyParsedLiveInboundIds.has(Number(inboundId))) ||
        (liveFullListFetched && liveFullListCleanlyParsed))
    );

    // Deletion verification runs asynchronously in the dedicated background panel-wide synchronizer
    // (syncDeleted3XUiClients), never synchronously during customer HTTP reads.
    // Already-confirmed deleted rows in Supabase are filtered above and returned in confirmedDeletedUuids.

    const evaluated = evaluateVpnClientStatus({
      panelReachable: expectedInboundCleanlyFetched || Boolean(matchedInbound),
      inboundFound: Boolean(matchedInbound),
      inboundEnable: matchedInbound ? matchedInbound.enable : null,
      clientFound: Boolean(foundClient),
      clientEnable: foundClient ? foundClient.enable : null,
      statEnable: stat ? stat.enable : undefined,
      upBytes: up,
      downBytes: down,
      totalLimitBytes: total,
      expiryTimeMs: expTimeMs,
      nowMs,
    });

    // Customer configuration retrieval (getMyConfigs) is strictly read-only and never performs
    // automatic database status restoration UPDATE writes on vpn_accounts or vpn_configs.
    // Verify in-memory order/grant state so a DB-disabled record with an unresolved/failed revocation
    // never displays as Active even if a panel client is manually re-enabled.
    const hasInMemoryRevocationBlock =
      Array.from(relatedOrdersSet).some((ord) => isOrderRejectedOrRevoked(ord)) ||
      Array.from(relatedGrantsSet).some((g) => {
        const st = String(g?.status || '').toLowerCase().trim();
        return st === 'revoke_failed' || st === 'uncertain';
      });
    const effectiveDisplayStatus =
      config._dbStatus === 'disabled' && evaluated.status === 'Active' && hasInMemoryRevocationBlock
        ? ('Disabled' as const)
        : evaluated.status;
    const effectiveDisplayEnable =
      effectiveDisplayStatus === 'Disabled' ? false : evaluated.effectiveEnable;
    const effectiveDisplayEnableStatus =
      effectiveDisplayStatus === 'Disabled' ? false : evaluated.enableStatus;

    let currentExpiryDate = config.expiryDate;
    if (expTimeMs > 0) {
      currentExpiryDate = new Date(expTimeMs).toISOString();
    }

    let port = 443;
    let protocol = 'vless';
    let network = 'tcp';
    let security = 'none';
    let serverAddress = 'singapore.firevpn.com';

    if (config.configUrl) {
      try {
        const urlStr = config.configUrl.startsWith('vless://') ? config.configUrl.replace('vless://', 'http://') : config.configUrl;
        const urlObj = new URL(urlStr);
        if (urlObj.port) port = Number(urlObj.port);
        if (urlObj.hostname) serverAddress = urlObj.hostname;
        const typeParam = urlObj.searchParams.get('type');
        if (typeParam) network = typeParam;
        const secParam = urlObj.searchParams.get('security');
        if (secParam) security = secParam;
      } catch(e) {}
    }

    finalConfigs.push({
      orderId: config.orderId,
      packageName: config.packageName,
      uuid: config.uuid,
      configUrl: config.configUrl,
      inboundId,
      trafficLimit: resolvedTrafficLimit,
      usedGB,
      remainingGB,
      upBytes: usedTrafficKnown ? up : 0,
      downBytes: usedTrafficKnown ? down : 0,
      upload: usedTrafficKnown ? up : 0,
      download: usedTrafficKnown ? down : 0,
      liveUsageFound: !!matchedInbound && !!foundClient && trafficSource === 'live',
      trafficVerified,
      trafficSource,
      quotaVerified,
      usedTrafficKnown,
      remainingTrafficKnown,
      panelStatusVerified: evaluated.panelStatusVerified,
      statusReason: evaluated.statusReason,
      totalTrafficBytes: total,
      remainingTrafficBytes: remainingTraffic,
      expiryDate: currentExpiryDate,
      expiryTime: currentExpiryDate,
      status: effectiveDisplayStatus,
      enable: effectiveDisplayEnable,
      enableStatus: effectiveDisplayEnableStatus,
      onlineStatus:
        effectiveDisplayStatus === 'Active' &&
        (lastOnline > 0 || (usedTrafficKnown && (up > 0 || down > 0))),
      lastOnline: lastOnlineMs,
      serverNode: config.serverNode,
      port,
      protocol,
      network,
      security,
      serverAddress,
      subscriptionName: config.packageName,
      name: config.packageName,
      isTrial: !!config.isTrial,
      templateId: config.templateId || null,
      paymentStatus: config.paymentStatus || null,
      provisioningStatus: config.provisioningStatus || null,
      trafficResetEligible: resetEligibility.eligible,
      isUnlimitedPlan: resetEligibility.isUnlimitedPlan,
    });
  }

  const dbTime = Date.now() - dbStart;

  // 3. Append strictly owner-scoped, redacted display-only cards for rejected/revoked orders
  // that previously had a provisioned VPN client. These never expose usable credentials and
  // always remain Disabled even if a 3X-UI client is manually re-enabled.
  const seenRejectedOrderKeys = new Set<string>();
  const rejectedConfigs: any[] = [];
  allOrders.forEach(ord => {
    const docUid = String(ord.customer_id || ord.customerUid || ord.customerId || ord.uid || ord.userId || '').trim();
    const docEmail = String(ord.email || ord.customerEmail || ord.userEmail || '').toLowerCase().trim();
    const matchesUser = userUid
      ? (docUid === userUid || (!docUid && userEmail && docEmail === userEmail))
      : (userEmail && docEmail === userEmail);
    if (!matchesUser) return;

    const ordRowId = String(ord.id || '').trim();
    const ordPublicId = String(ord.order_id || '').trim();
    const grant = ordRowId ? grantByOrderId.get(ordRowId) : undefined;

    if (!isOrderRejectedOrRevoked(ord, grant?.status)) return;

    const hadProvisionedVpn = Boolean(
      ord.client_uuid ||
      ord.vless_url ||
      ord.vpn_credentials?.configLink ||
      ord.vpn_credentials?.password ||
      grant?.client_uuid ||
      (ordRowId && vpnConfigOrderIds.has(ordRowId)) ||
      (ordPublicId && vpnConfigOrderIds.has(ordPublicId))
    );
    if (!hadProvisionedVpn) return;

    const dedupeKey = ordRowId || ordPublicId;
    if (!dedupeKey || seenRejectedOrderKeys.has(dedupeKey)) return;
    seenRejectedOrderKeys.add(dedupeKey);

    rejectedConfigs.push(buildRejectedVpnDisplayConfig(ord, grant));
  });

  return {
    configs: [...finalConfigs, ...rejectedConfigs],
    deletedUuids: Array.from(confirmedDeletedUuids),
    legacyReconciliationRecords,
    dbTime,
  };
  } finally {
    unregisterClientTrafficCacheInvalidator(inFlightMutationListener);
  }
};

export interface TrafficResetPolicy {
  enabled: boolean;
  cooldownHours: number;
  maxResetsPerBillingPeriod: number;
  allowTrialReset: boolean;
}

export const DEFAULT_RESET_POLICY: TrafficResetPolicy = {
  enabled: true,
  cooldownHours: 24,
  maxResetsPerBillingPeriod: 1,
  allowTrialReset: false
};

export interface TrafficResetLog {
  id: string;
  userId: string;
  userEmail: string;
  configUuid: string;
  orderId?: string;
  inboundId?: number;
  clientEmail?: string;
  resetTimestamp: string;
  resetTimestampMs: number;
  upBytesBefore: number;
  downBytesBefore: number;
  totalBytesBefore: number;
  status: 'success' | 'failed';
}

export interface ResetTrafficStatus {
  canReset: boolean;
  allowed?: boolean;
  eligibleForTrafficReset?: boolean;
  isUnlimitedPlan?: boolean;
  reason?: string;
  cooldownHours: number;
  cooldownRemainingHours: number;
  resetsUsedInPeriod: number;
  maxResetsPerPeriod: number;
  lastResetTimestamp: string | null;
  lastResetAt?: string | null;
  nextAvailableReset: string | null;
  nextAllowedAt?: string | null;
  usedUpload?: number;
  usedDownload?: number;
  totalUsed?: number;
  dataLimit?: number | null;
}

export interface ResetVpnTrafficOptions {
  dbClient?: any;
  getLiveInboundFn?: (id: number) => Promise<any | null>;
  getInboundsFn?: (forceRefresh?: boolean) => Promise<any[]>;
  resetClientTrafficFn?: (
    email: string,
    inboundId?: number,
    clientUuid?: string,
    options?: ResetClientTrafficOptions
  ) => Promise<{ success: boolean; message: string }>;
  getTrafficResetPolicyFn?: () => Promise<TrafficResetPolicy>;
  getTrafficResetLogsFn?: () => Promise<TrafficResetLog[]>;
  recordTrafficResetLogFn?: (log: TrafficResetLog) => Promise<void>;
  nowMs?: number;
  maxLockedVerificationMs?: number;
  requireDurableLock?: boolean;
  skipNotification?: boolean;
  skipUsedBytesUpdate?: boolean;
}

let inMemoryTrafficResetPolicy: TrafficResetPolicy = { ...DEFAULT_RESET_POLICY };
let inMemoryTrafficResetLogs: TrafficResetLog[] = [];

export const getTrafficResetPolicy = async (): Promise<TrafficResetPolicy> => {
  try {
    const { data: doc } = await supabase.from('settings').select('*').eq('id', 'traffic_reset_policy').maybeSingle();
    if (doc && doc.data) {
      inMemoryTrafficResetPolicy = {
        enabled: doc.data.enabled !== false,
        cooldownHours: Number(doc.data.cooldownHours) || DEFAULT_RESET_POLICY.cooldownHours,
        maxResetsPerBillingPeriod: Number(doc.data.maxResetsPerBillingPeriod) || DEFAULT_RESET_POLICY.maxResetsPerBillingPeriod,
        allowTrialReset: Boolean(doc.data.allowTrialReset)
      };
      return inMemoryTrafficResetPolicy;
    }
  } catch (err) {
    console.warn('[vpnService] Error reading traffic_reset_policy:', err);
  }
  return inMemoryTrafficResetPolicy;
};

export const saveTrafficResetPolicy = async (policy: Partial<TrafficResetPolicy>): Promise<TrafficResetPolicy> => {
  const current = await getTrafficResetPolicy();
  const updated: TrafficResetPolicy = {
    enabled: policy.enabled !== undefined ? Boolean(policy.enabled) : current.enabled,
    cooldownHours: policy.cooldownHours !== undefined ? Math.max(1, Number(policy.cooldownHours)) : current.cooldownHours,
    maxResetsPerBillingPeriod: policy.maxResetsPerBillingPeriod !== undefined ? Math.max(1, Number(policy.maxResetsPerBillingPeriod)) : current.maxResetsPerBillingPeriod,
    allowTrialReset: policy.allowTrialReset !== undefined ? Boolean(policy.allowTrialReset) : current.allowTrialReset
  };
  inMemoryTrafficResetPolicy = updated;

  try {
    await supabase.from('settings').upsert({
      id: 'traffic_reset_policy',
      data: updated,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.warn('[vpnService] Note: Settings table upsert blocked or restricted by RLS; in-memory policy updated.');
  }

  return updated;
};

export const getTrafficResetLogs = async (): Promise<TrafficResetLog[]> => {
  try {
    const { data: doc } = await supabase.from('settings').select('*').eq('id', 'traffic_reset_logs').maybeSingle();
    if (doc && doc.data) {
      const dbLogs: TrafficResetLog[] = Array.isArray(doc.data) ? doc.data : (Array.isArray(doc.data.logs) ? doc.data.logs : []);
      const combined = [...inMemoryTrafficResetLogs];
      for (const d of dbLogs) {
        if (!combined.some(l => l.id === d.id)) {
          combined.push(d);
        }
      }
      combined.sort((a, b) => b.resetTimestampMs - a.resetTimestampMs);
      return combined;
    }
  } catch (err) {
    console.warn('[vpnService] Error reading traffic_reset_logs from Supabase:', err);
  }
  return [...inMemoryTrafficResetLogs].sort((a, b) => b.resetTimestampMs - a.resetTimestampMs);
};

export const clearTrafficResetLogsForTest = (userId?: string) => {
  if (userId) {
    inMemoryTrafficResetLogs = inMemoryTrafficResetLogs.filter(l => l.userId !== userId);
  } else {
    inMemoryTrafficResetLogs = [];
  }
};

export const recordTrafficResetLog = async (log: TrafficResetLog): Promise<void> => {
  // Always update in-memory cache immediately
  inMemoryTrafficResetLogs = [log, ...inMemoryTrafficResetLogs.filter(l => l.id !== log.id).slice(0, 499)];

  try {
    const existingLogs = await getTrafficResetLogs();
    const updatedLogs = [log, ...existingLogs.filter(l => l.id !== log.id).slice(0, 499)];
    await supabase.from('settings').upsert({
      id: 'traffic_reset_logs',
      data: { logs: updatedLogs },
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    console.warn('[vpnService] Error saving traffic_reset_logs to settings:', err);
  }

  // Also attempt insert into traffic_resets table if it exists
  try {
    await supabase.from('traffic_resets').insert({
      user_id: log.userId,
      config_uuid: log.configUuid,
      order_id: log.orderId || null,
      inbound_id: log.inboundId || null,
      client_email: log.clientEmail || null,
      up_bytes_before: log.upBytesBefore,
      down_bytes_before: log.downBytesBefore,
      total_bytes_before: log.totalBytesBefore,
      status: log.status,
      created_at: log.resetTimestamp
    });
  } catch (e) {
    // Non-fatal if table not created
  }
};

/**
 * Verify VPN configuration ownership strictly using Supabase
 */
export const verifyVpnOwnership = async (
  userId: string,
  userEmail: string,
  configUuid: string,
  options?: { dbClient?: any; allowXuiFallback?: boolean }
): Promise<{
  owned: boolean;
  source: 'vpn_accounts' | 'orders' | 'vpn_configs' | '3xui' | null;
  record: any;
}> => {
  const normUuid = (configUuid || '').trim().toLowerCase();
  const normUid = (userId || '').trim();
  const normEmail = (userEmail || '').trim().toLowerCase();
  const db = options?.dbClient || supabaseAdmin || supabase;
  const allowXuiFallback = options?.allowXuiFallback !== false;

  if (!normUuid) return { owned: false, source: null, record: null };

  const matchesOwner = (recUid: string, recEmail: string): boolean => {
    const cleanUid = (recUid || '').trim();
    const cleanEmail = (recEmail || '').trim().toLowerCase();
    if (normUid) {
      if (cleanUid) return cleanUid === normUid;
      return Boolean(normEmail && cleanEmail && cleanEmail === normEmail);
    }
    return Boolean(normEmail && cleanEmail && cleanEmail === normEmail);
  };

  // 1. Check vpn_accounts table filtered directly by UUID
  try {
    const { data: vpnAccs } = await db
      .from('vpn_accounts')
      .select('*')
      .ilike('uuid', normUuid);
    if (vpnAccs && Array.isArray(vpnAccs) && vpnAccs.length > 0) {
      for (const acc of vpnAccs) {
        const accUuid = String(acc.uuid || '').trim().toLowerCase();
        if (accUuid === normUuid) {
          if (matchesOwner(String(acc.user_id || ''), String(acc.email || ''))) {
            return { owned: true, source: 'vpn_accounts', record: acc };
          }
          // UUID exists in vpn_accounts but belongs to another user
          return { owned: false, source: 'vpn_accounts', record: null };
        }
      }
    }
  } catch (_e) {}

  // 2. Check orders table filtered directly by client_uuid
  try {
    const { data: orders } = await db
      .from('orders')
      .select('*')
      .ilike('client_uuid', normUuid);
    if (orders && Array.isArray(orders) && orders.length > 0) {
      for (const ord of orders) {
        const clientUuid = String(ord.client_uuid || ord.uuid || ord.vpn_credentials?.password || '').trim().toLowerCase();
        if (clientUuid === normUuid) {
          const ordUid = String(ord.customer_id || ord.customerUid || ord.customerId || '').trim();
          const ordEmail = String(ord.email || ord.customerEmail || '').trim().toLowerCase();
          if (matchesOwner(ordUid, ordEmail)) {
            return { owned: true, source: 'orders', record: ord };
          }
          // UUID exists in orders but belongs to another user
          return { owned: false, source: 'orders', record: null };
        }
      }
    }
  } catch (_e) {}

  // 3. Check vpn_configs table filtered directly by UUID
  try {
    const { data: vpnCfgs } = await db
      .from('vpn_configs')
      .select('*')
      .ilike('uuid', normUuid);
    if (vpnCfgs && Array.isArray(vpnCfgs) && vpnCfgs.length > 0) {
      for (const cfg of vpnCfgs) {
        const cfgUuid = String(cfg.uuid || '').trim().toLowerCase();
        if (cfgUuid === normUuid) {
          const cfgUid = String(cfg.customer_uid || cfg.user_id || cfg.userId || '').trim();
          const cfgEmail = String(cfg.customer_email || cfg.user_email || cfg.email || '').trim().toLowerCase();
          if (matchesOwner(cfgUid, cfgEmail)) {
            return { owned: true, source: 'vpn_configs', record: cfg };
          }
          return { owned: false, source: 'vpn_configs', record: null };
        }
      }
    }
  } catch (_e) {}

  if (!allowXuiFallback) {
    return { owned: false, source: null, record: null };
  }

  // 4. Check 3X-UI panel clients directly as fallback (strict exact email match only; never substring)
  try {
    const cached = await getCachedInbounds();
    if (Array.isArray(cached)) {
      for (const ib of cached) {
        let settingsObj: any = {};
        try {
          if (ib.settings) settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
        } catch (_e) {}
        const clients = settingsObj.clients || [];
        for (const c of clients) {
          const cUuid = String(c.id || '').trim().toLowerCase();
          const cEmail = String(c.email || '').trim().toLowerCase();
          if (cUuid === normUuid) {
            if (normEmail && cEmail === normEmail) {
              return {
                owned: true,
                source: '3xui',
                record: {
                  uuid: c.id,
                  email: c.email,
                  inbound_id: ib.id,
                  status: c.enable ? 'active' : 'disabled',
                  expiry_date: c.expiryTime && c.expiryTime > 0 ? new Date(c.expiryTime).toISOString() : null,
                  package_name: ib.remark || 'FIREVPN Package'
                }
              };
            }
            // UUID exists in 3X-UI but does not belong to this user
            return { owned: false, source: '3xui', record: null };
          }
        }
      }
    }
  } catch (_e) {}

  return { owned: false, source: null, record: null };
};

interface AuthoritativeResetDbContext {
  vpnAccount: any | null;
  vpnConfig: any | null;
  orders: any[];
  grants: any[];
  preferredInboundId: number | null;
  orderIdForLog: string;
  displayName: string;
}

const fetchAuthoritativeResetDbContext = async (
  db: any,
  normUuid: string,
  ownershipRecord: any
): Promise<AuthoritativeResetDbContext> => {
  const safeQueryRows = async (promise: Promise<any>): Promise<any[]> => {
    try {
      const res = await promise;
      return Array.isArray(res?.data) ? res.data : [];
    } catch {
      return [];
    }
  };

  const [accRows, cfgRows, orderByUuidRows, grantByUuidRows] = await Promise.all([
    safeQueryRows(db.from('vpn_accounts').select('*').ilike('uuid', normUuid)),
    safeQueryRows(db.from('vpn_configs').select('*').ilike('uuid', normUuid)),
    safeQueryRows(db.from('orders').select('*').ilike('client_uuid', normUuid)),
    safeQueryRows(db.from('vpn_entitlement_grants').select('*').ilike('client_uuid', normUuid)),
  ]);

  const sortNewest = (rows: any[]) =>
    [...rows].sort((a, b) => getEntitlementRecordTimestampMs(b) - getEntitlementRecordTimestampMs(a));

  const vpnAccount = sortNewest(accRows)[0] || null;
  const vpnConfig = sortNewest(cfgRows)[0] || null;

  const ordersMap = new Map<string, any>();
  const addOrder = (ord: any) => {
    if (!ord || typeof ord !== 'object') return;
    const key = String(ord.id || ord.order_id || Math.random());
    if (!ordersMap.has(key)) ordersMap.set(key, ord);
  };
  orderByUuidRows.forEach(addOrder);

  const linkedOrderIds = Array.from(
    new Set(
      [vpnAccount?.order_id, vpnConfig?.order_id, ownershipRecord?.order_id, ownershipRecord?.id]
        .filter(Boolean)
        .map((v) => String(v).trim())
    )
  );

  // Fetch any order/grant linked via order_id that didn't match client_uuid directly
  if (linkedOrderIds.length > 0) {
    const [extraOrdersById, extraOrdersByPubId, extraGrantsByOrder] = await Promise.all([
      safeQueryRows(db.from('orders').select('*').in('id', linkedOrderIds)),
      safeQueryRows(db.from('orders').select('*').in('order_id', linkedOrderIds)),
      safeQueryRows(db.from('vpn_entitlement_grants').select('*').in('order_id', linkedOrderIds)),
    ]);
    extraOrdersById.forEach(addOrder);
    extraOrdersByPubId.forEach(addOrder);

    const grantsMap = new Map<string, any>();
    const addGrant = (g: any) => {
      if (!g || typeof g !== 'object') return;
      const key = String(g.id || `${g.grant_type || 'new_order'}:${g.order_id || ''}:${g.client_uuid || ''}:${g.created_at || ''}`);
      if (!grantsMap.has(key)) grantsMap.set(key, g);
    };
    grantByUuidRows.forEach(addGrant);
    extraGrantsByOrder.forEach(addGrant);

    const grants = Array.from(grantsMap.values());
    const orders = Array.from(ordersMap.values());
    const preferredInboundCandidates = [
      vpnConfig?.inbound_id,
      ownershipRecord?.inbound_id,
      ...grants.map((g) => g.inbound_id),
    ];
    let preferredInboundId: number | null = null;
    for (const c of preferredInboundCandidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) {
        preferredInboundId = n;
        break;
      }
    }

    return {
      vpnAccount,
      vpnConfig,
      orders,
      grants,
      preferredInboundId,
      orderIdForLog: String(vpnAccount?.order_id || vpnConfig?.order_id || ownershipRecord?.order_id || ownershipRecord?.id || ''),
      displayName: String(vpnAccount?.remark || vpnConfig?.package_name || ownershipRecord?.remark || ownershipRecord?.package_name || 'FIREVPN Package'),
    };
  }

  const preferredInboundCandidates = [
    vpnConfig?.inbound_id,
    ownershipRecord?.inbound_id,
    ...grantByUuidRows.map((g) => g.inbound_id),
  ];
  let preferredInboundId: number | null = null;
  for (const c of preferredInboundCandidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) {
      preferredInboundId = n;
      break;
    }
  }

  return {
    vpnAccount,
    vpnConfig,
    orders: Array.from(ordersMap.values()),
    grants: grantByUuidRows,
    preferredInboundId,
    orderIdForLog: String(vpnAccount?.order_id || vpnConfig?.order_id || ownershipRecord?.order_id || ownershipRecord?.id || ''),
    displayName: String(vpnAccount?.remark || vpnConfig?.package_name || ownershipRecord?.remark || ownershipRecord?.package_name || 'FIREVPN Package'),
  };
};

interface LiveClientSnapshotResult {
  panelReachable: boolean;
  liveInbound: any | null;
  liveClient: any | null;
  liveStat: any | null;
}

const findClientInLiveInbounds = (
  inbounds: any[],
  normUuid: string
): { liveInbound: any; liveClient: any; liveStat: any | null } | null => {
  for (const ib of inbounds) {
    const parsed = parseInboundSettingsClientsStrict(ib);
    if (!parsed.ok) continue;
    const client = parsed.clients.find(
      (c: any) => String(c?.id || '').trim().toLowerCase() === normUuid
    );
    if (client) {
      const stats = Array.isArray(ib.clientStats) ? ib.clientStats : [];
      const clientEmailLower = String(client.email || '').trim().toLowerCase();
      const stat =
        stats.find((s: any) => String(s?.id || '').trim().toLowerCase() === normUuid) ||
        (clientEmailLower
          ? stats.find((s: any) => String(s?.email || '').trim().toLowerCase() === clientEmailLower)
          : null) ||
        null;
      return { liveInbound: ib, liveClient: client, liveStat: stat };
    }
  }
  return null;
};

const fetchFreshLiveClientSnapshotForReset = async (
  normUuid: string,
  preferredInboundId: number | null,
  getLiveInboundFn: (id: number) => Promise<any | null>,
  getInboundsFn: (forceRefresh?: boolean) => Promise<any[]>
): Promise<LiveClientSnapshotResult> => {
  if (preferredInboundId && preferredInboundId > 0) {
    try {
      const directIb = await getLiveInboundFn(preferredInboundId);
      if (directIb) {
        const hit = findClientInLiveInbounds([directIb], normUuid);
        if (hit) {
          return {
            panelReachable: true,
            liveInbound: hit.liveInbound,
            liveClient: hit.liveClient,
            liveStat: hit.liveStat,
          };
        }
      }
    } catch {
      // Fall through to full fresh inbound list attempt
    }
  }

  try {
    const freshInbounds = await getInboundsFn(true);
    if (!Array.isArray(freshInbounds) || freshInbounds.length === 0) {
      return { panelReachable: false, liveInbound: null, liveClient: null, liveStat: null };
    }
    const hit = findClientInLiveInbounds(freshInbounds, normUuid);
    if (hit) {
      return {
        panelReachable: true,
        liveInbound: hit.liveInbound,
        liveClient: hit.liveClient,
        liveStat: hit.liveStat,
      };
    }
    return { panelReachable: true, liveInbound: null, liveClient: null, liveStat: null };
  } catch {
    return { panelReachable: false, liveInbound: null, liveClient: null, liveStat: null };
  }
};

const evaluateResetCooldownWindow = (
  allLogs: TrafficResetLog[],
  userId: string,
  userEmail: string,
  normUuid: string,
  policy: TrafficResetPolicy,
  nowMs: number
): {
  allowed: boolean;
  reason?: string;
  cooldownRemainingHours: number;
  resetsUsedInPeriod: number;
  lastResetTimestamp: string | null;
  nextAvailableReset: string | null;
} => {
  const normEmail = (userEmail || '').trim().toLowerCase();
  const userLogs = allLogs
    .filter(
      (l) =>
        (l.userId === userId ||
          (normEmail && l.userEmail && l.userEmail.toLowerCase() === normEmail)) &&
        l.configUuid.toLowerCase() === normUuid &&
        l.status === 'success'
    )
    .sort((a, b) => b.resetTimestampMs - a.resetTimestampMs);

  const lastLog = userLogs[0] || null;
  const cooldownMs = policy.cooldownHours * 60 * 60 * 1000;
  const periodWindowMs = 30 * 24 * 60 * 60 * 1000;
  const resetsInPeriod = userLogs.filter((l) => nowMs - l.resetTimestampMs < periodWindowMs).length;

  if (lastLog) {
    const elapsedMs = nowMs - lastLog.resetTimestampMs;
    if (elapsedMs < cooldownMs) {
      const cooldownRemainingHours = Math.ceil((cooldownMs - elapsedMs) / (1000 * 60 * 60));
      const nextAvailableReset = new Date(lastLog.resetTimestampMs + cooldownMs).toISOString();
      return {
        allowed: false,
        reason: `Reset cooldown active. Please wait ${cooldownRemainingHours} hour(s) before resetting again.`,
        cooldownRemainingHours,
        resetsUsedInPeriod: resetsInPeriod,
        lastResetTimestamp: lastLog.resetTimestamp,
        nextAvailableReset,
      };
    }
  }

  if (resetsInPeriod >= policy.maxResetsPerBillingPeriod) {
    const oldestInPeriod = userLogs[resetsInPeriod - 1];
    const nextAvailableReset = oldestInPeriod
      ? new Date(oldestInPeriod.resetTimestampMs + periodWindowMs).toISOString()
      : null;
    return {
      allowed: false,
      reason: `Maximum traffic resets (${policy.maxResetsPerBillingPeriod}) reached for this billing period.`,
      cooldownRemainingHours: 0,
      resetsUsedInPeriod: resetsInPeriod,
      lastResetTimestamp: lastLog ? lastLog.resetTimestamp : null,
      nextAvailableReset,
    };
  }

  return {
    allowed: true,
    cooldownRemainingHours: 0,
    resetsUsedInPeriod: resetsInPeriod,
    lastResetTimestamp: lastLog ? lastLog.resetTimestamp : null,
    nextAvailableReset: null,
  };
};

/**
 * Check whether a customer can reset traffic right now, including authoritative unlimited-only
 * entitlement verification, live 3X-UI quota check, cooldown, and billing period limit status.
 */
export const getResetTrafficStatus = async (
  userId: string,
  userEmail: string,
  configUuid: string,
  options?: ResetVpnTrafficOptions
): Promise<ResetTrafficStatus> => {
  const db = options?.dbClient || supabaseAdmin || supabase;
  const getPolicyFn = options?.getTrafficResetPolicyFn || getTrafficResetPolicy;
  const getLogsFn = options?.getTrafficResetLogsFn || getTrafficResetLogs;
  const getLiveInboundFn = options?.getLiveInboundFn || getLiveInbound;
  const getInboundsFn = options?.getInboundsFn || getInbounds;
  const nowMs = options?.nowMs ?? Date.now();
  const normUuid = (configUuid || '').trim().toLowerCase();

  const policy = await getPolicyFn();

  if (!policy.enabled) {
    return {
      canReset: false,
      allowed: false,
      eligibleForTrafficReset: false,
      isUnlimitedPlan: false,
      reason: 'Traffic reset feature is currently disabled by administrator',
      cooldownHours: policy.cooldownHours,
      cooldownRemainingHours: 0,
      resetsUsedInPeriod: 0,
      maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
      lastResetTimestamp: null,
      lastResetAt: null,
      nextAvailableReset: null,
      nextAllowedAt: null,
    };
  }

  // 1. Verify strict Supabase DB ownership (never trust unlinked 3X-UI fallback)
  const ownership = await verifyVpnOwnership(userId, userEmail, normUuid, {
    dbClient: db,
    allowXuiFallback: false,
  });
  if (!ownership.owned) {
    return {
      canReset: false,
      allowed: false,
      eligibleForTrafficReset: false,
      isUnlimitedPlan: false,
      reason: 'Forbidden: You do not have ownership of this VPN configuration',
      cooldownHours: policy.cooldownHours,
      cooldownRemainingHours: 0,
      resetsUsedInPeriod: 0,
      maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
      lastResetTimestamp: null,
      lastResetAt: null,
      nextAvailableReset: null,
      nextAllowedAt: null,
    };
  }

  // 2. Fetch fresh authoritative DB entitlement context + fresh uncached live 3X-UI client snapshot
  const dbCtx = await fetchAuthoritativeResetDbContext(db, normUuid, ownership.record);
  const liveSnap = await fetchFreshLiveClientSnapshotForReset(
    normUuid,
    dbCtx.preferredInboundId,
    getLiveInboundFn,
    getInboundsFn
  );

  // 3. Evaluate authoritative unlimited-only eligibility
  const eligibility = evaluateCustomerTrafficResetEligibility({
    vpnAccount: dbCtx.vpnAccount,
    vpnConfig: dbCtx.vpnConfig,
    orders: dbCtx.orders,
    grants: dbCtx.grants,
    ownershipSource: ownership.source,
    panelReachable: liveSnap.panelReachable,
    liveInbound: liveSnap.liveInbound,
    liveClient: liveSnap.liveClient,
    liveStat: liveSnap.liveStat,
    nowMs,
  });

  const usedUpload = eligibility.liveUpBytes;
  const usedDownload = eligibility.liveDownBytes;
  const totalUsed = usedUpload + usedDownload;
  const dataLimit = eligibility.liveTotalLimitBytes;

  if (!eligibility.eligible) {
    return {
      canReset: false,
      allowed: false,
      eligibleForTrafficReset: false,
      isUnlimitedPlan: eligibility.isUnlimitedPlan,
      reason: eligibility.customerMessage || TRAFFIC_RESET_UNLIMITED_ONLY_MESSAGE,
      cooldownHours: policy.cooldownHours,
      cooldownRemainingHours: 0,
      resetsUsedInPeriod: 0,
      maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
      lastResetTimestamp: null,
      lastResetAt: null,
      nextAvailableReset: null,
      nextAllowedAt: null,
      usedUpload,
      usedDownload,
      totalUsed,
      dataLimit,
    };
  }

  // 4. Check cooldown and frequency
  const allLogs = await getLogsFn();
  const cooldownStatus = evaluateResetCooldownWindow(
    allLogs,
    userId,
    userEmail,
    normUuid,
    policy,
    nowMs
  );

  if (!cooldownStatus.allowed) {
    return {
      canReset: false,
      allowed: false,
      eligibleForTrafficReset: true,
      isUnlimitedPlan: true,
      reason: cooldownStatus.reason,
      cooldownHours: policy.cooldownHours,
      cooldownRemainingHours: cooldownStatus.cooldownRemainingHours,
      resetsUsedInPeriod: cooldownStatus.resetsUsedInPeriod,
      maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
      lastResetTimestamp: cooldownStatus.lastResetTimestamp,
      lastResetAt: cooldownStatus.lastResetTimestamp,
      nextAvailableReset: cooldownStatus.nextAvailableReset,
      nextAllowedAt: cooldownStatus.nextAvailableReset,
      usedUpload,
      usedDownload,
      totalUsed,
      dataLimit: 0,
    };
  }

  return {
    canReset: true,
    allowed: true,
    eligibleForTrafficReset: true,
    isUnlimitedPlan: true,
    cooldownHours: policy.cooldownHours,
    cooldownRemainingHours: 0,
    resetsUsedInPeriod: cooldownStatus.resetsUsedInPeriod,
    maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
    lastResetTimestamp: cooldownStatus.lastResetTimestamp,
    lastResetAt: cooldownStatus.lastResetTimestamp,
    nextAvailableReset: null,
    nextAllowedAt: null,
    usedUpload,
    usedDownload,
    totalUsed,
    dataLimit: 0,
  };
};

/**
 * Execute real customer self-service traffic reset in 3X-UI.
 * Hardened against direct API bypasses, stale quotas, free trials, finite-data plans,
 * concurrent double resets, and lock lease expiry races:
 * 1. Fast pre-lock authoritative check (rejects ineligible plans with HTTP 403 before acquiring locks).
 * 2. Locked verification under client:<uuid> -> inbound:<id> locks (bounded within safe lease window)
 *    re-verifying ownership, DB entitlements, live uncached 3X-UI quota, and fresh cooldown logs.
 * 3. Immediate dual lease ownership recheck inside xuiService.resetClientTraffic before dispatching POST.
 * 4. Atomic cooldown log recording while STILL holding client:<uuid> lock.
 */
export const resetVpnTraffic = async (
  userId: string,
  userEmail: string,
  configUuid: string,
  options?: ResetVpnTrafficOptions
): Promise<{
  success: boolean;
  message: string;
  nextAllowedAt: string;
  data: {
    configUuid: string;
    clientEmail: string;
    inboundId: number;
    previousUsedBytes: number;
    currentUsedGB: number;
    resetTimestamp: string;
    cooldownHours: number;
    nextAvailableReset: string;
  };
}> => {
  const normUuid = (configUuid || '').trim().toLowerCase();
  const db = options?.dbClient || supabaseAdmin || supabase;
  const getPolicyFn = options?.getTrafficResetPolicyFn || getTrafficResetPolicy;
  const getLogsFn = options?.getTrafficResetLogsFn || getTrafficResetLogs;
  const recordLogFn = options?.recordTrafficResetLogFn || recordTrafficResetLog;
  const getLiveInboundFn = options?.getLiveInboundFn || getLiveInbound;
  const getInboundsFn = options?.getInboundsFn || getInbounds;
  const resetClientTrafficFn = options?.resetClientTrafficFn || resetClientTraffic;
  const nowMs = options?.nowMs ?? Date.now();

  console.log(`[vpnService] Processing customer traffic reset request - User UID: '${userId}', Email: '${userEmail}', Config UUID: '${normUuid}'`);

  if (!userId) {
    const err: any = new Error('Unauthorized: Authentication required');
    err.status = 401;
    throw err;
  }

  if (!normUuid) {
    const err: any = new Error('Invalid request: VPN configuration UUID is required');
    err.status = 400;
    throw err;
  }

  // 1. Check reset policy
  const policy = await getPolicyFn();
  if (!policy.enabled) {
    const err: any = new Error('Traffic reset feature is currently disabled by administrator');
    err.status = 403;
    throw err;
  }

  // 2. Strict ownership verification against Supabase (never allow unlinked 3X-UI fallback)
  const preOwnership = await verifyVpnOwnership(userId, userEmail, normUuid, {
    dbClient: db,
    allowXuiFallback: false,
  });
  if (!preOwnership.owned) {
    console.warn(`[Security Alert] User '${userId}' attempted to reset configuration '${normUuid}' which they do not own or cannot verify in DB!`);
    const err: any = new Error('Forbidden: You do not own this VPN configuration');
    err.status = 403;
    throw err;
  }

  // 3. Fast pre-lock authoritative DB + fresh live 3X-UI eligibility check (rejects before acquiring any locks)
  const preDbCtx = await fetchAuthoritativeResetDbContext(db, normUuid, preOwnership.record);
  const preLiveSnap = await fetchFreshLiveClientSnapshotForReset(
    normUuid,
    preDbCtx.preferredInboundId,
    getLiveInboundFn,
    getInboundsFn
  );

  const preEligibility = evaluateCustomerTrafficResetEligibility({
    vpnAccount: preDbCtx.vpnAccount,
    vpnConfig: preDbCtx.vpnConfig,
    orders: preDbCtx.orders,
    grants: preDbCtx.grants,
    ownershipSource: preOwnership.source,
    panelReachable: preLiveSnap.panelReachable,
    liveInbound: preLiveSnap.liveInbound,
    liveClient: preLiveSnap.liveClient,
    liveStat: preLiveSnap.liveStat,
    nowMs,
  });

  if (!preEligibility.eligible) {
    console.warn(
      `[Security Guard] Blocked customer traffic reset for UUID '${normUuid}' (user '${userId}'): ${preEligibility.reasonCode}`
    );
    const err: any = new Error(preEligibility.customerMessage || TRAFFIC_RESET_UNLIMITED_ONLY_MESSAGE);
    err.status = preEligibility.httpStatus || 403;
    err.code = preEligibility.reasonCode;
    throw err;
  }

  // 4. Fast pre-lock cooldown & billing period check
  const preLogs = await getLogsFn();
  const preCooldown = evaluateResetCooldownWindow(
    preLogs,
    userId,
    userEmail,
    normUuid,
    policy,
    nowMs
  );
  if (!preCooldown.allowed) {
    const err: any = new Error(preCooldown.reason || 'Reset cooldown active.');
    err.status = 429;
    throw err;
  }

  let verifiedInboundId = Number(preLiveSnap.liveInbound!.id);
  let verifiedClientEmail = String(preLiveSnap.liveClient!.email || userEmail || '').trim();
  let upBytes = preEligibility.liveUpBytes;
  let downBytes = preEligibility.liveDownBytes;
  let totalBefore = upBytes + downBytes;
  let orderIdForLog = preDbCtx.orderIdForLog;
  let displayName = preDbCtx.displayName;
  let resetTimestampStr = new Date(nowMs).toISOString();
  let successLogRecordedUnderLock = false;

  console.log(`[vpnService] Executing locked 3X-UI traffic reset for client '${verifiedClientEmail}' in inbound ${verifiedInboundId}...`);

  // 5. Execute REAL reset in 3X-UI under durable client:<uuid> -> inbound:<id> locks,
  // with bounded locked re-verification immediately before lease recheck + POST,
  // and atomic cooldown logging while STILL holding client:<uuid> lock.
  try {
    await resetClientTrafficFn(verifiedClientEmail, verifiedInboundId, normUuid, {
      dbClient: db,
      maxLockedVerificationMs: options?.maxLockedVerificationMs,
      requireDurableLock: options?.requireDurableLock,
      beforeResetUnderLocks: async () => {
        const lockedNowMs = options?.nowMs ?? Date.now();
        // Re-verify strict DB ownership
        const lockedOwnership = await verifyVpnOwnership(userId, userEmail, normUuid, {
          dbClient: db,
          allowXuiFallback: false,
        });
        if (!lockedOwnership.owned) {
          const err: any = new Error('Forbidden: You do not own this VPN configuration');
          err.status = 403;
          err.beforeExternalWrite = true;
          err.xuiUncertain = false;
          throw err;
        }

        // Re-fetch authoritative DB records and fresh uncached live 3X-UI state under locks
        const lockedDbCtx = await fetchAuthoritativeResetDbContext(db, normUuid, lockedOwnership.record);
        const lockedLiveSnap = await fetchFreshLiveClientSnapshotForReset(
          normUuid,
          lockedDbCtx.preferredInboundId || verifiedInboundId,
          getLiveInboundFn,
          getInboundsFn
        );

        const lockedEligibility = evaluateCustomerTrafficResetEligibility({
          vpnAccount: lockedDbCtx.vpnAccount,
          vpnConfig: lockedDbCtx.vpnConfig,
          orders: lockedDbCtx.orders,
          grants: lockedDbCtx.grants,
          ownershipSource: lockedOwnership.source,
          panelReachable: lockedLiveSnap.panelReachable,
          liveInbound: lockedLiveSnap.liveInbound,
          liveClient: lockedLiveSnap.liveClient,
          liveStat: lockedLiveSnap.liveStat,
          nowMs: lockedNowMs,
        });

        if (!lockedEligibility.eligible) {
          console.warn(
            `[Security Guard] Locked re-verification blocked traffic reset for UUID '${normUuid}': ${lockedEligibility.reasonCode}`
          );
          const err: any = new Error(lockedEligibility.customerMessage || TRAFFIC_RESET_UNLIMITED_ONLY_MESSAGE);
          err.status = lockedEligibility.httpStatus || 403;
          err.code = lockedEligibility.reasonCode;
          err.beforeExternalWrite = true;
          err.xuiUncertain = false;
          throw err;
        }

        // Re-check fresh cooldown & billing period logs under client lock (blocks concurrent double-resets)
        const lockedLogs = await getLogsFn();
        const lockedCooldown = evaluateResetCooldownWindow(
          lockedLogs,
          userId,
          userEmail,
          normUuid,
          policy,
          lockedNowMs
        );
        if (!lockedCooldown.allowed) {
          const err: any = new Error(lockedCooldown.reason || 'Reset cooldown active.');
          err.status = 429;
          err.beforeExternalWrite = true;
          err.xuiUncertain = false;
          throw err;
        }

        // Update verified live coordinates from locked fresh read
        verifiedInboundId = Number(lockedLiveSnap.liveInbound!.id);
        verifiedClientEmail = String(lockedLiveSnap.liveClient!.email || userEmail || '').trim();
        upBytes = lockedEligibility.liveUpBytes;
        downBytes = lockedEligibility.liveDownBytes;
        totalBefore = upBytes + downBytes;
        orderIdForLog = lockedDbCtx.orderIdForLog;
        displayName = lockedDbCtx.displayName;
        resetTimestampStr = new Date(lockedNowMs).toISOString();

        return {
          email: verifiedClientEmail,
          inboundId: verifiedInboundId,
        };
      },
      afterResetUnderClientLock: async () => {
        const logNowMs = options?.nowMs ?? Date.now();
        resetTimestampStr = new Date(logNowMs).toISOString();
        await recordLogFn({
          id: crypto.randomUUID(),
          userId,
          userEmail,
          configUuid: normUuid,
          orderId: orderIdForLog,
          inboundId: verifiedInboundId,
          clientEmail: verifiedClientEmail,
          resetTimestamp: resetTimestampStr,
          resetTimestampMs: logNowMs,
          upBytesBefore: upBytes,
          downBytesBefore: downBytes,
          totalBytesBefore: totalBefore,
          status: 'success',
        });
        successLogRecordedUnderLock = true;
      },
    });
  } catch (xuiErr: any) {
    const explicitStatus = Number(xuiErr?.status || xuiErr?.statusCode || 0);
    // Preserve clean authorization, policy, cooldown, lock contention, or pre-mutation abort statuses directly
    if (
      explicitStatus === 400 ||
      explicitStatus === 401 ||
      explicitStatus === 403 ||
      explicitStatus === 404 ||
      explicitStatus === 409 ||
      explicitStatus === 429 ||
      explicitStatus === 503
    ) {
      throw xuiErr;
    }

    console.error('[vpnService] 3X-UI reset failed:', xuiErr?.message || xuiErr);
    // Record failed reset attempt only for actual 3X-UI mutation failures
    try {
      await recordLogFn({
        id: crypto.randomUUID(),
        userId,
        userEmail,
        configUuid: normUuid,
        orderId: orderIdForLog,
        inboundId: verifiedInboundId,
        clientEmail: verifiedClientEmail,
        resetTimestamp: new Date(nowMs).toISOString(),
        resetTimestampMs: nowMs,
        upBytesBefore: upBytes,
        downBytesBefore: downBytes,
        totalBytesBefore: totalBefore,
        status: 'failed',
      });
    } catch {
      // Non-fatal
    }
    const err: any = new Error(`Failed to reset traffic counter on 3X-UI server: ${xuiErr?.message || 'Server error'}`);
    err.status = 502;
    if (xuiErr?.xuiUncertain) err.xuiUncertain = true;
    throw err;
  }

  // Fallback log recording only if an injected mock resetClientTrafficFn didn't invoke afterResetUnderClientLock
  if (!successLogRecordedUnderLock) {
    await recordLogFn({
      id: crypto.randomUUID(),
      userId,
      userEmail,
      configUuid: normUuid,
      orderId: orderIdForLog,
      inboundId: verifiedInboundId,
      clientEmail: verifiedClientEmail,
      resetTimestamp: resetTimestampStr,
      resetTimestampMs: nowMs,
      upBytesBefore: upBytes,
      downBytesBefore: downBytes,
      totalBytesBefore: totalBefore,
      status: 'success',
    });
  }

  // 6. Reset in-memory preserved traffic counter (bumping per-UUID traffic mutation sequence) and update vpn_accounts used_bytes to 0
  if (normUuid) {
    notifyClientTrafficInvalidated(normUuid, 'reset', nowMs);
  }
  if (!options?.skipUsedBytesUpdate) {
    try {
      await db.from('vpn_accounts')
        .update({ used_bytes: 0, updated_at: resetTimestampStr })
        .eq('uuid', normUuid);
    } catch (dbErr) {
      console.warn('[vpnService] vpn_accounts used_bytes update warning:', dbErr);
    }
  }

  // 7. Send in-app notification
  if (!options?.skipNotification) {
    try {
      await createCustomerNotification({
        userId,
        userEmail: userEmail || preOwnership.record?.email || 'customer@firevpn.com',
        title: 'VPN Traffic Reset Successful',
        message: `Your VPN configuration "${displayName}" traffic counter has been reset to 0 MB. Your full data allowance is restored.`,
        type: 'traffic_reset',
        vpnName: displayName,
        vpnUuid: normUuid,
      });
    } catch (notifErr) {
      console.warn('[vpnService] Customer notification warning:', notifErr);
    }
  }

  const cooldownMs = policy.cooldownHours * 60 * 60 * 1000;
  const nextAvailableResetDate = new Date(nowMs + cooldownMs).toISOString();

  return {
    success: true,
    message: 'Traffic counter successfully reset in 3X-UI. Your full package data allowance has been restored.',
    nextAllowedAt: nextAvailableResetDate,
    data: {
      configUuid: normUuid,
      clientEmail: verifiedClientEmail,
      inboundId: verifiedInboundId,
      previousUsedBytes: totalBefore,
      currentUsedGB: 0,
      resetTimestamp: resetTimestampStr,
      cooldownHours: policy.cooldownHours,
      nextAvailableReset: nextAvailableResetDate,
    },
  };
};


