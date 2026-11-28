import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as xuiService from '../services/xuiService.js';
import { supabase, supabaseAdmin } from '../../lib/supabase.js';
import {
  sendRenewNotification,
  sendRenewApprovedNotification,
  sendNewOrderNotification,
  sendOrderApprovedNotification,
  sendOrderRejectedNotification,
  syncRenewTelegramInlineMessage,
} from '../services/telegramService.js';
import { createCustomerNotification } from '../services/notificationService.js';
import {
  sendOrderReceivedEmail,
  sendPaymentApprovedEmail,
  sendPaymentRejectedEmail,
  sendRenewalRequestReceivedEmail,
  sendRenewalApprovedEmail,
  sendRenewalRejectedEmail
} from '../services/emailService.js';

import { verifyRenewalCheckoutPrice, verifySpecialOfferCheckoutPrice } from '../services/specialOfferService.js';
import { getBackendApiTimeoutMs } from '../../utils/apiTimeoutRoutes.js';
import {
  computePaymentSlipSha256AndVerifyStorage,
  claimPaymentReceiptForAutoActivation,
  claimPaymentReceiptForRenewal,
  isRenewalPaymentSlipStoragePathOwnedByUser,
  parsePaymentSlipReference,
} from '../services/paymentSlipService.js';

const CANONICAL_QUOTA_METADATA_KEYS = [
  'planId',
  'verified_plan_id',
  'package_type',
  'data_limit',
  'category',
  'quota_mode',
  'monthly_quota_gb',
  'quota_verified_by_server',
  'tier_upgrade_verified',
  'plan_name',
  'package_id',
  'package_name',
  'duration_months',
  'durationMonths',
  'duration_label',
  'duration',
] as const;

export interface PersistAutoRenewalBlockedReasonCasParams {
  dbClient: any;
  renewRequestId: string;
  blockedReason: string;
  canonicalExtraMetadata?: Record<string, any> | null;
  maxAttempts?: number;
  nowIso?: string;
}

export interface PersistAutoRenewalBlockedReasonCasResult {
  persisted: boolean;
  reason:
    | 'PERSISTED'
    | 'ROW_NOT_FOUND'
    | 'CONCURRENT_ADMIN_STATE_CHANGE'
    | 'CAS_CONFLICT_SKIPPED'
    | 'SUPABASE_READ_ERROR'
    | 'SUPABASE_UPDATE_ERROR';
  attempts: number;
  sanitizedBlockedReason: string;
  mergedNotes?: Record<string, any>;
  errorMessage?: string;
}

/**
 * Concurrency-safely persists `auto_renewal_blocked_reason` and `auto_renewal_held_at`
 * into `renew_requests.notes` using conditional Compare-And-Set (CAS) against the
 * exact `notes` value observed during read (using `.is('notes', null)` when NULL,
 * or `.eq('notes', originalNotes)` when non-null) and requiring `.eq('status', 'pending')`.
 *
 * Safety guarantees:
 * - Never overwrites concurrent admin approvals/rejections (`status !== 'pending'` or terminal `provisioning_status`).
 * - Preserves all canonical server-verified quota metadata keys.
 * - Preserves concurrent JSON fields added between initial creation and blocked-reason persistence.
 * - Preserves full plain-text or malformed-JSON `legacy_notes` without truncation.
 * - Explicitly checks Supabase returned errors on both read and update.
 * - Performs a bounded fresh read and merge (default max 2 attempts) on CAS conflict,
 *   and safely skips persistence if contention persists or Supabase returns an error.
 */
export async function persistAutoRenewalBlockedReasonCas(
  params: PersistAutoRenewalBlockedReasonCasParams
): Promise<PersistAutoRenewalBlockedReasonCasResult> {
  const { dbClient, renewRequestId } = params;
  const canonicalBase =
    params.canonicalExtraMetadata && typeof params.canonicalExtraMetadata === 'object'
      ? { ...params.canonicalExtraMetadata }
      : {};
  const maxAttempts = Math.max(1, Math.min(3, Math.trunc(Number(params.maxAttempts) || 2)));
  const sanitizedReason =
    xuiService.sanitizeAutoRenewalBlockedReason(params.blockedReason) ||
    'PROVISIONING_HELD_FOR_MANUAL_REVIEW';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const effectiveNowIso = params.nowIso || new Date().toISOString();

    const { data: latestReqRow, error: readErr } = await dbClient
      .from('renew_requests')
      .select('id, status, provisioning_status, notes')
      .eq('id', renewRequestId)
      .maybeSingle();

    if (readErr) {
      console.warn(
        `[RenewController] Supabase read error while preparing auto_renewal_blocked_reason for request ${renewRequestId} (attempt ${attempt}/${maxAttempts}):`,
        readErr?.message || readErr
      );
      return {
        persisted: false,
        reason: 'SUPABASE_READ_ERROR',
        attempts: attempt,
        sanitizedBlockedReason: sanitizedReason,
        errorMessage: String(readErr?.message || readErr),
      };
    }

    if (!latestReqRow) {
      return {
        persisted: false,
        reason: 'ROW_NOT_FOUND',
        attempts: attempt,
        sanitizedBlockedReason: sanitizedReason,
      };
    }

    const currentStatus = String(latestReqRow.status ?? 'pending').trim().toLowerCase();
    const currentProvStatus = String(latestReqRow.provisioning_status ?? '').trim().toLowerCase();
    if (
      currentStatus !== 'pending' ||
      currentProvStatus === 'completed' ||
      currentProvStatus === 'approved' ||
      currentProvStatus === 'revoked'
    ) {
      return {
        persisted: false,
        reason: 'CONCURRENT_ADMIN_STATE_CHANGE',
        attempts: attempt,
        sanitizedBlockedReason: sanitizedReason,
      };
    }

    const originalNotes: string | null =
      latestReqRow.notes === null || latestReqRow.notes === undefined
        ? null
        : String(latestReqRow.notes);

    let mergedNotesObj: Record<string, any> = { ...canonicalBase };

    if (originalNotes !== null && originalNotes.length > 0) {
      const trimmed = originalNotes.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(originalNotes);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            mergedNotesObj = { ...canonicalBase, ...parsed };
            for (const key of CANONICAL_QUOTA_METADATA_KEYS) {
              if (canonicalBase[key] !== undefined) {
                mergedNotesObj[key] = canonicalBase[key];
              }
            }
          } else {
            mergedNotesObj = { ...canonicalBase, legacy_notes: originalNotes };
          }
        } catch {
          mergedNotesObj = { ...canonicalBase, legacy_notes: originalNotes };
        }
      } else {
        mergedNotesObj = { ...canonicalBase, legacy_notes: originalNotes };
      }
    }

    mergedNotesObj.auto_renewal_blocked_reason = sanitizedReason;
    mergedNotesObj.auto_renewal_held_at = effectiveNowIso;

    let updateBuilder = dbClient
      .from('renew_requests')
      .update({
        notes: JSON.stringify(mergedNotesObj),
        updated_at: effectiveNowIso,
      })
      .eq('id', renewRequestId)
      .eq('status', 'pending');

    if (originalNotes === null) {
      updateBuilder = updateBuilder.is('notes', null);
    } else {
      updateBuilder = updateBuilder.eq('notes', originalNotes);
    }

    const { data: updatedRows, error: updateErr } = await updateBuilder.select('id, notes');

    if (updateErr) {
      console.warn(
        `[RenewController] Supabase update error while persisting auto_renewal_blocked_reason for request ${renewRequestId} (attempt ${attempt}/${maxAttempts}):`,
        updateErr?.message || updateErr
      );
      return {
        persisted: false,
        reason: 'SUPABASE_UPDATE_ERROR',
        attempts: attempt,
        sanitizedBlockedReason: sanitizedReason,
        errorMessage: String(updateErr?.message || updateErr),
      };
    }

    const matchedRowCount = Array.isArray(updatedRows)
      ? updatedRows.length
      : updatedRows && typeof updatedRows === 'object' && (updatedRows as any).id
      ? 1
      : 0;

    if (matchedRowCount > 0) {
      return {
        persisted: true,
        reason: 'PERSISTED',
        attempts: attempt,
        sanitizedBlockedReason: sanitizedReason,
        mergedNotes: mergedNotesObj,
      };
    }
  }

  console.warn(
    `[RenewController] Skipped persisting auto_renewal_blocked_reason for request ${renewRequestId} after ${maxAttempts} CAS attempts due to concurrent notes/status modification.`
  );
  return {
    persisted: false,
    reason: 'CAS_CONFLICT_SKIPPED',
    attempts: maxAttempts,
    sanitizedBlockedReason: sanitizedReason,
  };
}

/**
 * Feature flag helpers:
 * Both flags default to false.
 * Automatic renewals are controlled independently via AUTO_ACTIVATE_RENEWALS_ENABLED
 * and require a separate, explicit, non-empty AUTO_ACTIVATE_RENEWALS_ALLOWLIST.
 */
export const isAutoActivateNewOrdersEnabled = (): boolean =>
  String(process.env.AUTO_ACTIVATE_NEW_ORDERS_ENABLED || 'false').trim().toLowerCase() === 'true';

/**
 * Optional controlled rollout allowlist (comma-separated lowercase emails or user UIDs).
 * When AUTO_ACTIVATE_NEW_ORDERS_ENABLED=true AND AUTO_ACTIVATE_NEW_ORDERS_ALLOWLIST is non-empty,
 * ONLY matching authorized test accounts receive automatic provisional activation; all other
 * customers remain on the normal manual verification queue.
 */
export const getAutoActivateNewOrdersAllowlist = (): string[] =>
  String(process.env.AUTO_ACTIVATE_NEW_ORDERS_ALLOWLIST || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

export const isUserAuthorizedForAutoActivateNewOrders = (uid?: string | null, email?: string | null): boolean => {
  if (!isAutoActivateNewOrdersEnabled()) return false;
  const allowlist = getAutoActivateNewOrdersAllowlist();
  if (allowlist.length === 0) return true;
  const normUid = String(uid || '').trim().toLowerCase();
  const normEmail = String(email || '').trim().toLowerCase();
  return Boolean((normUid && allowlist.includes(normUid)) || (normEmail && allowlist.includes(normEmail)));
};

export const isAutoActivateRenewalsEnabled = (): boolean =>
  String(process.env.AUTO_ACTIVATE_RENEWALS_ENABLED || 'false').trim().toLowerCase() === 'true';

/**
 * Mandatory safety requirement:
 * Automatic renewals require a separate, explicit, non-empty AUTO_ACTIVATE_RENEWALS_ALLOWLIST
 * during initial testing and must NEVER inherit AUTO_ACTIVATE_NEW_ORDERS_ALLOWLIST.
 */
export const getAutoActivateRenewalsAllowlist = (): string[] =>
  String(process.env.AUTO_ACTIVATE_RENEWALS_ALLOWLIST || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

export const isUserAuthorizedForAutoActivateRenewals = (uid?: string | null, email?: string | null): boolean => {
  if (!isAutoActivateRenewalsEnabled()) return false;
  const allowlist = getAutoActivateRenewalsAllowlist();
  if (allowlist.length === 0) return false;
  const normUid = String(uid || '').trim().toLowerCase();
  const normEmail = String(email || '').trim().toLowerCase();
  return Boolean((normUid && allowlist.includes(normUid)) || (normEmail && allowlist.includes(normEmail)));
};

const getSafeOrderSourceLabel = (
  rawSource: unknown
): 'store_checkout' | 'billing_page' | 'other' | 'missing' => {
  const normalized = String(rawSource || '').trim().toLowerCase();
  if (!normalized) return 'missing';
  if (normalized === 'store_checkout') return 'store_checkout';
  if (normalized === 'billing_page') return 'billing_page';
  return 'other';
};

const evaluateAutoActivationDebugContext = (
  uid?: string | null,
  email?: string | null,
  rawSource?: unknown
) => {
  const flagEnvPresent = process.env.AUTO_ACTIVATE_NEW_ORDERS_ENABLED !== undefined;
  const allowlistEnvPresent = process.env.AUTO_ACTIVATE_NEW_ORDERS_ALLOWLIST !== undefined;
  const flagEnabled = isAutoActivateNewOrdersEnabled();
  const allowlist = getAutoActivateNewOrdersAllowlist();
  const allowlistConfigured = allowlist.length > 0;
  const normUid = String(uid || '').trim().toLowerCase();
  const normEmail = String(email || '').trim().toLowerCase();
  const customerMatchesAllowlist = allowlistConfigured
    ? Boolean((normUid && allowlist.includes(normUid)) || (normEmail && allowlist.includes(normEmail)))
    : true;
  const authorizedForAutoActivation = isUserAuthorizedForAutoActivateNewOrders(uid, email);
  const orderSource = getSafeOrderSourceLabel(rawSource);
  const isManualBilling = rawSource === 'billing_page';

  return {
    flagEnvPresent,
    flagEnabled,
    allowlistEnvPresent,
    allowlistConfigured,
    allowlistEntryCount: allowlist.length,
    customerMatchesAllowlist,
    authorizedForAutoActivation,
    orderSource,
    isManualBilling,
  };
};

const resolveAutoActivationSkipReason = (ctx: {
  flagEnabled: boolean;
  isManualBilling: boolean;
  allowlistConfigured: boolean;
  customerMatchesAllowlist: boolean;
}): string => {
  if (!ctx.flagEnabled) return 'FLAG_DISABLED';
  if (ctx.isManualBilling) return 'MANUAL_BILLING_ORDER';
  if (ctx.allowlistConfigured && !ctx.customerMatchesAllowlist) return 'ALLOWLIST_MISMATCH';
  return 'NOT_AUTHORIZED';
};

const logAutoActivationDebug = (
  stage: string,
  payload: Record<string, string | number | boolean | null>
): void => {
  console.log('[AutoActivationDebug]', JSON.stringify({ stage, ...payload }));
};

const ALLOWED_SLIP_STORAGE_BUCKETS = new Set(['payment-slips', 'payment_slips']);
const ALLOWED_NEW_ORDER_SLIP_FOLDERS = new Set(['orders', 'billing']);

/**
 * Validates authenticated customer ownership of a storage-backed payment slip path
 * for automatic new-order activation.
 * Compatible with:
 * - Current frontend upload format (`uploadPaymentSlipFile`): `[^a-zA-Z0-9@._-]` (preserves `@` and `.`)
 * - Raw authenticated email / UID path segments
 * - Legacy sanitized email / UID path segments (`[^a-zA-Z0-9_-]`)
 * Strictly rejects other customers' receipts, malformed paths, unauthorized folders/buckets, and path traversal.
 */
export function isPaymentSlipStoragePathOwnedByUser(params: {
  slipUrl: string;
  uid: string;
  email: string;
}): {
  valid: boolean;
  reason?:
    | 'PATH_TRAVERSAL_OR_INVALID'
    | 'UNAUTHORIZED_BUCKET'
    | 'MALFORMED_STORAGE_PATH'
    | 'INVALID_FOLDER'
    | 'OWNERSHIP_MISMATCH';
} {
  const raw = String(params.slipUrl || '').trim();
  let decodedOnce = raw;
  let decodedTwice = raw;
  try {
    decodedOnce = decodeURIComponent(raw);
    decodedTwice = decodeURIComponent(decodedOnce);
  } catch {
    // Keep last successfully decoded string
  }

  if (
    !raw ||
    raw.includes('..') ||
    raw.includes('\0') ||
    raw.includes('\\') ||
    decodedOnce.includes('..') ||
    decodedOnce.includes('\0') ||
    decodedOnce.includes('\\') ||
    decodedTwice.includes('..') ||
    decodedTwice.includes('\0') ||
    decodedTwice.includes('\\')
  ) {
    return { valid: false, reason: 'PATH_TRAVERSAL_OR_INVALID' };
  }

  const parsedSlip = parsePaymentSlipReference(raw);
  if (parsedSlip.kind === 'data') {
    return { valid: true };
  }
  if (parsedSlip.kind === 'empty') {
    return { valid: false, reason: 'PATH_TRAVERSAL_OR_INVALID' };
  }
  if (parsedSlip.kind !== 'storage') {
    return { valid: false, reason: 'MALFORMED_STORAGE_PATH' };
  }

  if (!ALLOWED_SLIP_STORAGE_BUCKETS.has(String(parsedSlip.bucket || '').trim().toLowerCase())) {
    return { valid: false, reason: 'UNAUTHORIZED_BUCKET' };
  }

  const objectPath = String(parsedSlip.objectPath || '').trim();
  let doubleDecodedPath = objectPath;
  try {
    doubleDecodedPath = decodeURIComponent(objectPath);
  } catch {
    // Keep objectPath as-is if already fully decoded or contains literal %
  }

  if (
    !objectPath ||
    objectPath.includes('..') ||
    objectPath.includes('\0') ||
    objectPath.includes('\\') ||
    doubleDecodedPath.includes('..') ||
    doubleDecodedPath.includes('\0') ||
    doubleDecodedPath.includes('\\')
  ) {
    return { valid: false, reason: 'PATH_TRAVERSAL_OR_INVALID' };
  }

  const segments = objectPath.split('/').filter(Boolean);
  if (segments.length < 3) {
    return { valid: false, reason: 'MALFORMED_STORAGE_PATH' };
  }
  if (segments.some((seg) => seg === '.' || seg === '..')) {
    return { valid: false, reason: 'PATH_TRAVERSAL_OR_INVALID' };
  }

  const folderSeg = String(segments[0] || '').trim().toLowerCase();
  if (!ALLOWED_NEW_ORDER_SLIP_FOLDERS.has(folderSeg)) {
    return { valid: false, reason: 'INVALID_FOLDER' };
  }

  const ownerSeg = String(segments[1] || '').trim().toLowerCase();
  const fileSeg = segments.slice(2).join('/').trim();
  if (!ownerSeg || !fileSeg) {
    return { valid: false, reason: 'MALFORMED_STORAGE_PATH' };
  }

  const cleanUid = String(params.uid || '').trim().toLowerCase();
  const cleanEmail = String(params.email || '').trim().toLowerCase();
  const allowedOwners = new Set<string>();
  if (cleanUid) {
    allowedOwners.add(cleanUid);
    allowedOwners.add(cleanUid.replace(/[^a-zA-Z0-9@._-]/g, '_'));
    allowedOwners.add(cleanUid.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }
  if (cleanEmail) {
    allowedOwners.add(cleanEmail);
    allowedOwners.add(cleanEmail.replace(/[^a-zA-Z0-9@._-]/g, '_'));
    allowedOwners.add(cleanEmail.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  if (allowedOwners.size === 0 || !allowedOwners.has(ownerSeg)) {
    return { valid: false, reason: 'OWNERSHIP_MISMATCH' };
  }

  return { valid: true };
}

export const validateRenewPrice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = req.body || {};
    const durationMonths = Number(body.durationMonths || body.duration || 1);
    const expectedAmount = body.expectedAmount !== undefined ? Number(body.expectedAmount) : undefined;

    const verified = await verifyRenewalCheckoutPrice({
      durationMonths,
      offerId: body.offerId || body.offer_id || null,
      packageId: body.packageId || body.package_id || null,
      packageName: body.packageName || body.package_name || body.configName || body.config_name || null,
      configName: body.configName || body.config_name || null,
      remark: body.remark || null,
      dataLimit: body.dataLimit || body.data_limit || null,
      planId: body.planId || body.plan_id || null,
      planName: body.planName || body.plan_name || body.plan || null,
      category: body.category || null,
      packageType: body.packageType || body.package_type || null,
      vpnAccountUuid: body.vpnAccountUuid || body.uuid || null,
      vpnAccountId: body.vpnAccountId || body.vpn_account_id || null,
    });

    if (
      expectedAmount !== undefined &&
      Number.isFinite(expectedAmount) &&
      Math.round(expectedAmount) !== verified.finalPrice
    ) {
      res.status(400).json({
        valid: false,
        priceChanged: true,
        error: `Renewal price has changed (Submitted: LKR ${Math.round(expectedAmount)}, Current Verified Price: LKR ${verified.finalPrice}). Please review the updated total.`,
        ...verified,
      });
      return;
    }

    res.json({
      success: true,
      valid: true,
      priceChanged: false,
      ...verified,
    });
  } catch (error: any) {
    console.warn('[RenewController] validateRenewPrice error:', error?.message || error);
    res.status(400).json({
      valid: false,
      error: error?.message || 'Failed to validate renewal price.',
    });
  }
};

export const createRenewRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const authEmail = String(req.user?.email || '').trim().toLowerCase();
    if (!uid || !authEmail) {
      res.status(401).json({ success: false, error: 'Unauthorized: Authentication required.' });
      return;
    }

    const data = req.body || {};
    const requestDeadlineMs =
      typeof (req as any).timeoutDeadlineMs === 'number' && Number.isFinite((req as any).timeoutDeadlineMs)
        ? (req as any).timeoutDeadlineMs
        : Date.now() + getBackendApiTimeoutMs('POST', '/renew/request');
    const customerEmail = authEmail;
    const requestedDuration = Number(data.durationMonths || data.duration || 1);
    const rawSlipUrl = String(data.slipUrl || data.slip_url || '').trim();

    if (rawSlipUrl && (rawSlipUrl.includes('..') || rawSlipUrl.includes('\0'))) {
      res.status(400).json({
        success: false,
        error: 'Invalid payment slip path.',
      });
      return;
    }

    const dbClient = (req as any).dbClient || supabaseAdmin || supabase;
    const autoActivateRenewalsAuthorized = isUserAuthorizedForAutoActivateRenewals(uid, customerEmail);

    // Upfront receipt storage path ownership verification when automatic renewal is authorized
    if (autoActivateRenewalsAuthorized && rawSlipUrl) {
      const ownershipCheck = isRenewalPaymentSlipStoragePathOwnedByUser({
        slipUrl: rawSlipUrl,
        uid,
        email: customerEmail,
      });
      if (!ownershipCheck.valid) {
        logAutoActivationDebug('renewal_upfront_ownership_rejected', {
          endpoint: 'createRenewRequest',
          authorizedForAutoRenewal: autoActivateRenewalsAuthorized,
          reason: `UPFRONT_OWNERSHIP_REJECTED:${ownershipCheck.reason || 'INVALID_SLIP_PATH'}`,
        });
        res.status(ownershipCheck.reason === 'OWNERSHIP_MISMATCH' ? 403 : 400).json({
          success: false,
          error:
            ownershipCheck.reason === 'OWNERSHIP_MISMATCH'
              ? 'Payment slip ownership mismatch. Please upload your own payment receipt.'
              : 'Invalid payment slip path. Please upload your payment receipt again.',
        });
        return;
      }
    }

    // Verify customer ownership of the target VPN account if uuid or vpn_account_id is supplied
    const requestedUuid = String(data.uuid || data.vpnAccountUuid || '').trim();
    const requestedAccountId = String(data.vpn_account_id || data.vpnAccountId || '').trim();
    let verifiedTargetVpnAccount: any = null;

    if (requestedAccountId) {
      const { data: vAcc } = await dbClient
        .from('vpn_accounts')
        .select('*')
        .eq('id', requestedAccountId)
        .maybeSingle();
      if (vAcc) verifiedTargetVpnAccount = vAcc;
    }
    if (!verifiedTargetVpnAccount && requestedUuid) {
      const { data: vAcc } = await dbClient
        .from('vpn_accounts')
        .select('*')
        .eq('uuid', requestedUuid)
        .maybeSingle();
      if (vAcc) verifiedTargetVpnAccount = vAcc;
    }

    if (verifiedTargetVpnAccount) {
      const accOwnerUid = String(verifiedTargetVpnAccount.user_id || '').trim();
      const accOwnerEmail = String(verifiedTargetVpnAccount.email || '').trim().toLowerCase();
      const uidMatches = Boolean(accOwnerUid && accOwnerUid === uid);
      const emailMatches = Boolean(!accOwnerUid && accOwnerEmail && accOwnerEmail === customerEmail);
      if (!uidMatches && !emailMatches && !(accOwnerEmail && accOwnerEmail === customerEmail)) {
        res.status(403).json({
          success: false,
          error: 'Forbidden: You do not own the selected VPN account.',
        });
        return;
      }
    }

    // Duplicate-submission protection: if an identical renewal request for this customer & slip was created within the last 2 minutes, return it
    if (rawSlipUrl && !data.renewalId && !data.id) {
      const twoMinutesAgoIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const { data: existingRecentRenew } = await dbClient
        .from('renew_requests')
        .select('*')
        .eq('user_id', uid)
        .eq('slip_url', rawSlipUrl)
        .eq('status', 'pending')
        .gte('created_at', twoMinutesAgoIso)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingRecentRenew) {
        let existingNotes: any = {};
        if (typeof existingRecentRenew.notes === 'string' && existingRecentRenew.notes.startsWith('{')) {
          try {
            existingNotes = JSON.parse(existingRecentRenew.notes);
          } catch {
            existingNotes = {};
          }
        }
        const wasProvisional =
          existingRecentRenew.provisioning_status === 'provisional' ||
          Boolean(existingNotes?.provisional_renewal);
        res.status(200).json({
          success: true,
          deduplicated: true,
          renewalId: existingRecentRenew.id,
          autoRenewed: wasProvisional,
          provisional: wasProvisional,
          provisioningStatus: existingRecentRenew.provisioning_status || (wasProvisional ? 'provisional' : 'pending'),
          newExpiry: existingNotes?.new_expiry || null,
          oldExpiry: existingNotes?.old_expiry || null,
          dataAllowance: existingNotes?.data_allowance || null,
          packageName: existingNotes?.package_name || existingRecentRenew.plan_name || null,
          uuid: existingNotes?.uuid || requestedUuid || null,
          message: wasProvisional
            ? 'Renewal already processed and provisionally active.'
            : 'Renewal request already submitted and pending payment verification.',
        });
        return;
      }
    }

    // Reject internally conflicting, ambiguous, or non-standard forged customer-submitted quota hints
    // (never trust client-supplied quota_verified_by_server, verified_plan_id, addedQuotaBytes, or conflicting tier fields)
    const submittedQuotaHints: Array<{ name: string; val: unknown }> = [
      { name: 'planId', val: data.planId ?? data.plan_id },
      { name: 'packageType', val: data.packageType ?? data.package_type },
      { name: 'dataLimit', val: data.dataLimit ?? data.data_limit },
    ];
    let submittedFiniteGb: number | null = null;
    let submittedUnlimited = false;
    for (const hint of submittedQuotaHints) {
      if (hint.val === undefined || hint.val === null || String(hint.val).trim() === '') continue;
      const parsedHint = xuiService.parseExplicitRenewalQuotaSignal(hint.val);
      if (parsedHint.kind === 'ambiguous') {
        res.status(400).json({
          success: false,
          code: 'AMBIGUOUS_QUOTA_METADATA',
          error: `Invalid or ambiguous renewal quota metadata in ${hint.name}.`,
        });
        return;
      }
      if (parsedHint.kind === 'finite' && parsedHint.monthlyGb) {
        if (parsedHint.monthlyGb !== 100) {
          res.status(400).json({
            success: false,
            code: 'INVALID_QUOTA_METADATA',
            error: `Unsupported renewal data quota (${parsedHint.monthlyGb}GB). Only standard SIM 100GB or Unlimited packages are supported.`,
          });
          return;
        }
        submittedFiniteGb = parsedHint.monthlyGb;
      } else if (parsedHint.kind === 'unlimited') {
        submittedUnlimited = true;
      }
    }
    if (submittedFiniteGb !== null && submittedUnlimited) {
      res.status(400).json({
        success: false,
        code: 'CONFLICTING_QUOTA_METADATA',
        error: 'Conflicting renewal quota metadata submitted (both 100GB and Unlimited specified).',
      });
      return;
    }

    // Read target vpn_configs non-blockingly so we can cross-check authoritative existing account quota
    let verifiedTargetVpnConfig: any = null;
    if (verifiedTargetVpnAccount?.uuid || requestedUuid) {
      try {
        const lookupUuid = String(verifiedTargetVpnAccount?.uuid || requestedUuid).trim();
        const { data: cfgRow } = await dbClient
          .from('vpn_configs')
          .select('id, uuid, package_name, data_limit, order_id')
          .eq('uuid', lookupUuid)
          .maybeSingle();
        if (cfgRow) verifiedTargetVpnConfig = cfgRow;
      } catch (_cfgErr) {
        // Non-blocking lookup
      }
    }

    const existingAccLimitSig = xuiService.parseExplicitRenewalQuotaSignal(verifiedTargetVpnAccount?.data_limit);
    const existingCfgLimitSig = xuiService.parseExplicitRenewalQuotaSignal(verifiedTargetVpnConfig?.data_limit);
    const existingAccountIsFinite100Gb =
      Number(verifiedTargetVpnAccount?.total_bytes || 0) > 0 ||
      existingAccLimitSig.kind === 'finite' ||
      existingCfgLimitSig.kind === 'finite';

    // Authoritatively validate renewal duration, package eligibility, and latest active offer price from Supabase
    const verified = await verifyRenewalCheckoutPrice({
      durationMonths: requestedDuration,
      offerId: data.offerId || data.offer_id || null,
      packageId: data.packageId || data.package_id || null,
      packageName: data.packageName || data.package_name || data.configName || data.config_name || null,
      configName: data.configName || data.config_name || null,
      remark: data.remark || null,
      dataLimit: data.dataLimit || data.data_limit || null,
      planId: data.planId || data.plan_id || null,
      planName: data.planName || data.plan || null,
      category: data.category || null,
      packageType: data.packageType || data.package_type || null,
      vpnAccountUuid: requestedUuid || null,
      vpnAccountId: requestedAccountId || null,
    });

    if (verified.category === 'ROUTER' && submittedFiniteGb !== null) {
      res.status(400).json({
        success: false,
        code: 'CONFLICTING_PACKAGE_CATEGORY_METADATA',
        error: 'Router packages do not support the SIM 100GB tier.',
      });
      return;
    }

    // Block Special Offer tier spoofing: a conclusively finite 100GB account cannot claim Unlimited
    // on a fixed-price Special Offer renewal by submitting forged planId/dataLimit/packageType fields.
    if (
      verified.isSpecialOffer &&
      verified.category !== 'ROUTER' &&
      verified.planId !== 'sim_100' &&
      existingAccountIsFinite100Gb
    ) {
      res.status(400).json({
        success: false,
        code: 'CONFLICTING_SPECIAL_OFFER_QUOTA_METADATA',
        error: 'Invalid renewal quota metadata: an existing 100GB VPN account cannot claim Unlimited quota via a 100GB Special Offer renewal.',
      });
      return;
    }

    const submittedAmount =
      data.expectedAmount !== undefined
        ? Number(data.expectedAmount)
        : data.amount !== undefined
        ? Number(data.amount)
        : undefined;

    if (
      submittedAmount !== undefined &&
      Number.isFinite(submittedAmount) &&
      Math.round(submittedAmount) !== verified.finalPrice
    ) {
      res.status(400).json({
        valid: false,
        priceChanged: true,
        error: `Invalid renewal total (LKR ${Math.round(submittedAmount)}). Server verified final price for this ${verified.durationLabel} renewal is LKR ${verified.finalPrice}.`,
        ...verified,
      });
      return;
    }

    let renewalRecordId = data.renewalId || data.id || null;

    // Derive canonical server-verified quota metadata exclusively from verified checkout pricing output
    const verifiedPlanId: xuiService.CanonicalRenewalPlanId =
      verified.planId === 'router_unlimited'
        ? 'router_unlimited'
        : verified.planId === 'sim_unlimited'
        ? 'sim_unlimited'
        : 'sim_100';
    const verifiedPackageType: xuiService.CanonicalRenewalPackageType =
      verifiedPlanId === 'router_unlimited'
        ? 'Router Unlimited'
        : verifiedPlanId === 'sim_unlimited'
        ? 'SIM Unlimited'
        : 'SIM 100GB';
    const verifiedQuotaMode: 'finite' | 'unlimited' = verifiedPlanId === 'sim_100' ? 'finite' : 'unlimited';
    const verifiedDataLimit = verifiedQuotaMode === 'finite' ? '100GB' : 'Unlimited';
    const verifiedMonthlyQuotaGb = verifiedQuotaMode === 'finite' ? 100 : null;

    const effectivePlanDisplay = verified.isSpecialOffer && verified.appliedOffer
      ? `${verified.packageName} - ${verifiedPackageType} (${verified.appliedOffer.name} - ${verified.durationLabel})`
      : `${verified.packageName} (${verifiedPackageType})`;

    const extraMetadata: Record<string, any> = {
      planId: verifiedPlanId,
      verified_plan_id: verifiedPlanId,
      package_type: verifiedPackageType,
      data_limit: verifiedDataLimit,
      category: verified.category,
      quota_mode: verifiedQuotaMode,
      monthly_quota_gb: verifiedMonthlyQuotaGb,
      quota_verified_by_server: true,
      plan_name: effectivePlanDisplay,
      package_id: verified.packageId,
      package_name: verified.packageName,
      durationMonths: verified.durationMonths,
      duration: verified.durationLabel,
      original_price: verified.originalPrice,
      discount_amount: verified.discountAmount,
      discount_percentage: verified.discountPercentage,
      final_price: verified.finalPrice,
      is_special_offer: verified.isSpecialOffer,
      offer_id: verified.appliedOffer?.id || null,
      offer_name: verified.appliedOffer?.name || null,
      discount_id: verified.appliedDiscount?.id || null,
      discount_name: verified.appliedDiscount?.name || null,
      paymentDate: String(data.paymentDate || '').trim(),
      receiptNumber: String(data.receiptNumber || '').trim(),
      message: String(data.message || '').trim().slice(0, 1000),
      vpn_account_id: requestedAccountId || (verifiedTargetVpnAccount?.id ? String(verifiedTargetVpnAccount.id) : ''),
      uuid: requestedUuid || (verifiedTargetVpnAccount?.uuid ? String(verifiedTargetVpnAccount.uuid) : ''),
      order_id: verifiedTargetVpnAccount?.order_id ? String(verifiedTargetVpnAccount.order_id) : undefined,
      config_name: String(data.configName || data.config_name || effectivePlanDisplay).trim(),
      server_node: String(data.serverNode || data.server_node || 'Singapore Server').trim(),
      old_expiry: String(data.oldExpiry || data.old_expiry || '').trim(),
      slip_url: rawSlipUrl,
      user_name: String(data.customerName || data.userName || authEmail.split('@')[0] || 'Customer').trim().slice(0, 120),
    };

    if (renewalRecordId) {
      // Legacy client-inserted row: verify ownership AND pending status before syncing authoritative price & quota
      const { data: existingRow } = await dbClient
        .from('renew_requests')
        .select('id, user_id, user_email, notes, status')
        .eq('id', renewalRecordId)
        .maybeSingle();

      if (!existingRow) {
        res.status(404).json({ success: false, error: 'Renewal request not found.' });
        return;
      }

      const rowOwnerUid = String(existingRow.user_id || '').trim();
      const rowOwnerEmail = String(existingRow.user_email || '').trim().toLowerCase();
      if (rowOwnerUid !== uid && rowOwnerEmail !== authEmail) {
        res.status(403).json({ success: false, error: 'Forbidden: You do not own this renewal request.' });
        return;
      }

      if (String(existingRow.status || 'pending').toLowerCase() === 'pending') {
        let mergedExtra: any = { ...extraMetadata };
        if (typeof existingRow.notes === 'string' && existingRow.notes.length > 0) {
          if (existingRow.notes.trim().startsWith('{')) {
            try {
              const parsedExisting = JSON.parse(existingRow.notes);
              delete parsedExisting.plan_id;
              delete parsedExisting.packageType;
              delete parsedExisting.dataLimit;
              delete parsedExisting.tier_upgrade_verified;
              mergedExtra = { ...parsedExisting, ...extraMetadata };
            } catch {
              mergedExtra = { legacy_notes: existingRow.notes, ...extraMetadata };
            }
          } else {
            mergedExtra = { legacy_notes: existingRow.notes, ...extraMetadata };
          }
        }
        await dbClient
          .from('renew_requests')
          .update({
            plan_name: effectivePlanDisplay,
            amount: verified.finalPrice,
            notes: JSON.stringify(mergedExtra),
          })
          .eq('id', existingRow.id)
          .eq('status', 'pending');
      }
    } else {
      // Authoritative server-side renewal insertion (always forced pending & verified price)
      const insertPayload: Record<string, any> = {
        user_id: uid,
        user_email: customerEmail,
        plan_name: effectivePlanDisplay,
        amount: verified.finalPrice,
        payment_method: String(data.receiptNumber || '').trim() || 'Bank Transfer',
        slip_url: rawSlipUrl,
        notes: JSON.stringify(extraMetadata),
        status: 'pending',
        provisioning_status: 'pending',
        created_at: new Date().toISOString(),
      };

      let { data: insertedRenew, error: insertRenewErr } = await dbClient
        .from('renew_requests')
        .insert(insertPayload)
        .select('id')
        .maybeSingle();

      if (insertRenewErr && String(insertRenewErr.message || '').includes('provisioning_status')) {
        const { provisioning_status: _omitted, ...fallbackPayload } = insertPayload;
        const retryInsert = await dbClient
          .from('renew_requests')
          .insert(fallbackPayload)
          .select('id')
          .maybeSingle();
        insertedRenew = retryInsert.data;
        insertRenewErr = retryInsert.error;
      }

      if (insertRenewErr) {
        console.error('[RenewController] Failed to create renew_requests row:', insertRenewErr.message);
        res.status(500).json({ success: false, error: 'Failed to save renewal request. Please try again.' });
        return;
      }
      renewalRecordId = insertedRenew?.id || null;
    }

    // Automatic Provisional Renewal Workflow (when AUTO_ACTIVATE_RENEWALS_ENABLED=true and user is in AUTO_ACTIVATE_RENEWALS_ALLOWLIST)
    let autoRenewed = false;
    let provisioningStatus: 'pending' | 'provisional' | 'uncertain' = 'pending';
    let autoRenewalBlockedReason: string | null = null;
    let provisionalResult: xuiService.ProvisionalRenewalProvisionResult | null = null;

    if (autoActivateRenewalsAuthorized && renewalRecordId) {
      if (!rawSlipUrl) {
        autoRenewalBlockedReason = 'MISSING_PAYMENT_SLIP';
      } else {
        try {
          const slipCheck = await computePaymentSlipSha256AndVerifyStorage({
            slipUrl: rawSlipUrl,
            userUid: uid,
            userEmail: customerEmail,
            allowedFolders: ['renewals', 'orders', 'billing'],
            storageClient: dbClient.storage,
          });

          if (!slipCheck.valid) {
            autoRenewalBlockedReason = slipCheck.code || 'SLIP_VERIFICATION_FAILED';
            console.warn(
              `[RenewController] Auto-renewal held for request ${renewalRecordId} (${autoRenewalBlockedReason}): ${slipCheck.error || 'Slip verification failed'}`
            );
          } else {
            const claimRes = await claimPaymentReceiptForRenewal({
              sha256: slipCheck.sha256,
              canonicalSlipUrl: slipCheck.canonicalSlipUrl,
              renewRequestId: String(renewalRecordId),
              userId: uid,
              userEmail: customerEmail,
              byteSize: slipCheck.byteSize,
              contentType: slipCheck.contentType,
              dbClient,
            });

            if (!claimRes.claimed) {
              autoRenewalBlockedReason = claimRes.conflictReason || claimRes.code || 'DUPLICATE_SLIP';
              console.warn(
                `[RenewController] Auto-renewal held for request ${renewalRecordId} (${autoRenewalBlockedReason}): ${claimRes.error || 'Receipt claim blocked'}`
              );
            } else {
              console.log(
                `[RenewController] AUTO_ACTIVATE_RENEWALS_ENABLED=true: Receipt claimed (${slipCheck.sha256.slice(0, 12)}...). Provisioning provisional renewal for request ${renewalRecordId}...`
              );
              provisionalResult = await xuiService.provisionProvisionalRenewal(String(renewalRecordId), {
                dbClient,
                signal: (req as any).timeoutSignal,
                deadlineMs: requestDeadlineMs,
              });

              if (
                provisionalResult?.success &&
                provisionalResult?.autoRenewed === true &&
                provisionalResult?.provisioningStatus === 'provisional'
              ) {
                autoRenewed = true;
                provisioningStatus = 'provisional';
              } else {
                autoRenewed = false;
                provisioningStatus =
                  provisionalResult?.provisioningStatus === 'uncertain' ? 'uncertain' : 'pending';
                autoRenewalBlockedReason =
                  provisionalResult?.blockedReason || 'PROVISIONING_HELD_FOR_MANUAL_REVIEW';
              }
            }
          }
        } catch (autoErr: any) {
          autoRenewed = false;
          autoRenewalBlockedReason =
            autoRenewalBlockedReason || autoErr?.blockedReason || autoErr?.code || 'PROVISIONING_ERROR';
          console.error(
            `[RenewController] Provisional automatic renewal failed for request ${renewalRecordId} (preserved in pending queue for manual admin review):`,
            autoErr?.message || autoErr
          );
        }
      }

      if (!autoRenewed && autoRenewalBlockedReason) {
        const sanitizedReason =
          xuiService.sanitizeAutoRenewalBlockedReason(autoRenewalBlockedReason) ||
          'PROVISIONING_HELD_FOR_MANUAL_REVIEW';
        autoRenewalBlockedReason = sanitizedReason;

        try {
          await persistAutoRenewalBlockedReasonCas({
            dbClient,
            renewRequestId: String(renewalRecordId),
            blockedReason: sanitizedReason,
            canonicalExtraMetadata: extraMetadata,
          });
        } catch (persistReasonErr: any) {
          console.warn(
            `[RenewController] Failed to persist sanitized auto_renewal_blocked_reason for request ${renewalRecordId}:`,
            persistReasonErr?.message || persistReasonErr
          );
        }
      }
    }

    const notificationData = {
      requestId: renewalRecordId ? String(renewalRecordId) : undefined,
      email: customerEmail,
      userEmail: customerEmail,
      planName: effectivePlanDisplay,
      durationMonths: verified.durationMonths,
      amount: verified.finalPrice,
      receiptNumber: String(data.receiptNumber || '').trim(),
      message: String(data.message || '').trim(),
      paymentDate: String(data.paymentDate || '').trim(),
      slipUrl: rawSlipUrl,
      status: 'Pending',
      provisional: autoRenewed,
      provisioningStatus,
      newExpiry: provisionalResult?.newExpiryIso,
      oldExpiry: provisionalResult?.oldExpiryIso,
      autoRenewalBlockedReason: autoRenewalBlockedReason || undefined,
      dbClient,
    };

    // Create customer notification
    try {
      await createCustomerNotification({
        userId: uid,
        userEmail: customerEmail,
        title: autoRenewed ? 'VPN Renewed (Pending Payment Verification)' : 'Payment Submitted',
        message: autoRenewed
          ? `Your VPN package "${provisionalResult?.packageName || verified.packageName}" has been renewed immediately (${verified.durationLabel}). Your payment of LKR ${notificationData.amount} is pending admin verification.`
          : `Your payment of LKR ${notificationData.amount} for "${notificationData.planName || 'VPN Package'}" (${verified.durationLabel}) has been submitted for verification.`,
        type: 'payment_submitted'
      });
    } catch (notifErr: any) {
      console.error('[RenewController] CRITICAL: Error creating Payment Submitted notification in createRenewRequest:', notifErr.message || notifErr);
    }

    // Send Renewal Request Submitted Email non-blockingly
    if (customerEmail && customerEmail.includes('@')) {
      sendRenewalRequestReceivedEmail({
        userEmail: customerEmail,
        renewalId: renewalRecordId || undefined,
        receiptNumber: notificationData.receiptNumber || undefined,
        vpnAccountId: data.vpn_account_id || data.uuid || undefined,
        packageName: notificationData.planName || 'FIREVPN Package',
        durationMonths: Number(verified.durationMonths) || 1,
        amount: Number(verified.finalPrice) || 0,
        userId: uid
      }).catch((emailErr) => {
        console.warn('[RenewController] Renewal request received email warning:', emailErr?.message || emailErr);
      });
    }

    // Send Telegram Notification safely without crashing or rejecting request
    sendRenewNotification(notificationData).catch((err) => {
      console.error('[RenewController] Telegram notification error:', err?.message || err);
    });

    res.json({
      success: true,
      renewalId: renewalRecordId,
      autoRenewed,
      provisional: autoRenewed,
      provisioningStatus,
      autoRenewalBlockedReason,
      newExpiry: autoRenewed ? provisionalResult?.newExpiryIso || null : null,
      oldExpiry: autoRenewed ? provisionalResult?.oldExpiryIso || null : null,
      dataAllowance: autoRenewed ? provisionalResult?.dataAllowanceLabel || null : null,
      packageName: autoRenewed
        ? provisionalResult?.packageName || verified.packageName || effectivePlanDisplay
        : verified.packageName || effectivePlanDisplay,
      uuid: provisionalResult?.uuid || extraMetadata.uuid || null,
      paymentStatus: 'Pending Verification',
      vpnStatus: autoRenewed ? 'Active' : undefined,
      message: autoRenewed
        ? 'VPN renewed and active immediately! Payment verification is pending admin review.'
        : 'Renewal request verified and submitted successfully.',
      verifiedPrice: verified,
    });
  } catch (error: any) {
    console.error('[RenewController] Error processing renewal request:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to process renewal request' });
  }
};

export interface ExecuteRenewalActionOptions {
  adminId?: string | null;
  adminLabel?: string;
  dbClient?: any;
  requestApiFn?: any;
  getInboundsFn?: any;
  getClientExpiryFn?: typeof xuiService.getClientExpiry;
  updateClientExpiryFn?: typeof xuiService.updateClientExpiry;
  nowMs?: number;
  skipSideEffects?: boolean;
  signal?: AbortSignal;
}

/**
 * Authoritative renewal approval handler shared by Admin HTTP API and Telegram inline button callbacks.
 * Works regardless of whether AUTO_ACTIVATE_RENEWALS_ENABLED is true or false.
 * - If the renewal request has already been provisionally applied in 3X-UI, confirms payment and marks
 *   the grant verified WITHOUT extending expiry or adding quota a second time.
 * - If the renewal request is a standard manual pending renewal, acquires client & inbound locks and
 *   extends expiry/quota in 3X-UI with read-back verification.
 */
export const executeRenewalApproval = async (
  requestId: string,
  options?: ExecuteRenewalActionOptions
): Promise<{
  success: boolean;
  provisionalConfirmed: boolean;
  uuid?: string;
  newExpiryIso?: string;
  data?: any;
}> => {
  const cleanRequestId = String(requestId || '').trim();
  if (!cleanRequestId) {
    throw new Error('Request ID is required');
  }

  const dbClient = options?.dbClient || supabaseAdmin || supabase;
  const lockKey = `renew:${cleanRequestId}`;
  const lockClaim = await xuiService.acquireDurableProvisioningOperationLock({
    dbClient,
    operationKey: lockKey,
    operationType: 'approve_renew',
    targetId: cleanRequestId,
    leaseSeconds: 120,
    requireDurableLock: true,
    allowUncertainRecovery: false,
    metadata: { action: 'approve_renew', adminLabel: options?.adminLabel || 'Admin' },
  });

  if (!lockClaim.acquired) {
    throw xuiService.buildDurableLockFailureError(
      lockClaim,
      `Renewal request '${cleanRequestId}'`
    );
  }

  let finalLockStatus: 'completed' | 'failed' | 'uncertain' = 'failed';
  let finalLockError: string | null = null;

  try {
    const { data, error: fetchErr } = await dbClient
      .from('renew_requests')
      .select('*')
      .eq('id', cleanRequestId)
      .maybeSingle();

    if (fetchErr || !data) {
      const notFoundErr: any = new Error('Renewal request not found');
      notFoundErr.statusCode = 404;
      throw notFoundErr;
    }

    const currentStatus = String(data.status || '').toLowerCase();
    if (currentStatus !== 'pending') {
      const statusErr: any = new Error(
        `Cannot approve request with status '${data.status}'. Status must be 'pending'.`
      );
      statusErr.statusCode = 400;
      throw statusErr;
    }

    const email = data.user_email || data.userEmail || data.email;
    if (!email) {
      const emailErr: any = new Error('Client email is missing in the renewal request.');
      emailErr.statusCode = 400;
      throw emailErr;
    }

    let durationMonths = Number(data.durationMonths || data.duration_months || data.duration || 1);
    const parsedNotes = data.notes
      ? typeof data.notes === 'string' && data.notes.startsWith('{')
        ? JSON.parse(data.notes)
        : data.notes
      : null;
    if (parsedNotes && typeof parsedNotes === 'object') {
      if (parsedNotes.durationMonths) {
        durationMonths = Number(parsedNotes.durationMonths);
      } else if (parsedNotes.duration) {
        const numMatch = String(parsedNotes.duration).match(/(\d+)/);
        if (numMatch) durationMonths = Number(numMatch[1]);
      }
    }
    if (!Number.isFinite(durationMonths) || durationMonths < 1) {
      durationMonths = 1;
    }

    // 1. Check if this renewal request was already provisionally provisioned
    const provisionalConfirm = await xuiService.confirmProvisionalRenewal(cleanRequestId, {
      dbClient,
      adminLabel: options?.adminLabel || (options?.adminId ? `Admin (${options.adminId})` : 'Admin Panel'),
      getInboundsFn: options?.getInboundsFn,
      heldRenewLockOwnerId: lockClaim.lockOwnerId,
      heldRenewLockTableAvailable: lockClaim.tableAvailable,
      signal: options?.signal,
    });

    if (provisionalConfirm.handledAsProvisional) {
      const nowIso = new Date().toISOString();
      const confirmedExpiryIso =
        provisionalConfirm.newExpiryIso ||
        parsedNotes?.new_expiry ||
        new Date().toISOString();
      const confirmedUuid = provisionalConfirm.uuid || parsedNotes?.uuid || data.uuid;
      const { data: refreshedApprovedRow } = await dbClient
        .from('renew_requests')
        .select('*')
        .eq('id', cleanRequestId)
        .maybeSingle();

      if (!options?.skipSideEffects) {
        try {
          await createCustomerNotification({
            userId: data.user_id || data.userId || null,
            userEmail: email,
            title: 'Renewal Payment Approved',
            message: `Your payment for VPN renewal "${data.plan_name || data.planName || 'Plan'}" has been verified and approved. Your renewed VPN remains active until ${new Date(confirmedExpiryIso).toLocaleDateString()}.`,
            type: 'vpn_renewed',
          });
        } catch (nErr: any) {
          console.error('[RenewController] Customer notification creation error:', nErr?.message || nErr);
        }

        sendRenewApprovedNotification({
          email,
          userEmail: email,
          planName: data.planName || data.plan_name || data.plan || 'FIREVPN Package',
          durationMonths,
          new_expiry: confirmedExpiryIso,
          approved_at: new Date(nowIso),
        }).catch((telegramErr) => {
          console.error('[RenewController] Telegram approved notification error:', telegramErr?.message || telegramErr);
        });

        syncRenewTelegramInlineMessage(cleanRequestId, 'APPROVED', {
          adminLabel: options?.adminLabel || 'Admin Panel',
          uuid: confirmedUuid,
          newExpiry: confirmedExpiryIso,
        }).catch(() => {});

        if (email) {
          sendRenewalApprovedEmail({
            userEmail: email,
            customerName: data.user_name || parsedNotes?.user_name || undefined,
            renewalId: cleanRequestId,
            packageName: data.planName || data.plan_name || data.plan || 'FIREVPN Package',
            expiryDate: confirmedExpiryIso,
            vlessUrl: '',
            userId: data.user_id || data.userId,
          }).catch((e) => console.warn('[RenewController] Renewal approved email warning:', e));
        }
      }

      finalLockStatus = 'completed';
      return {
        success: true,
        provisionalConfirmed: true,
        uuid: confirmedUuid,
        newExpiryIso: confirmedExpiryIso,
        data: refreshedApprovedRow || data,
      };
    }

    // 2. Standard Manual Renewal Approval Flow (not provisionally applied yet)
    const orderId = data.order_id || data.orderId || parsedNotes?.order_id || parsedNotes?.orderId;
    const specAccountId = data.vpn_account_id || parsedNotes?.vpn_account_id;
    const specUuid = data.uuid || parsedNotes?.uuid;

    let targetVpnAcc: any = null;

    if (orderId) {
      const { data: vAcc } = await dbClient
        .from('vpn_accounts')
        .select('*')
        .eq('order_id', orderId)
        .maybeSingle();
      if (vAcc) targetVpnAcc = vAcc;
    }

    if (!targetVpnAcc && specAccountId) {
      const { data: vAcc } = await dbClient
        .from('vpn_accounts')
        .select('*')
        .eq('id', specAccountId)
        .maybeSingle();
      if (vAcc) targetVpnAcc = vAcc;
    }

    if (!targetVpnAcc && specUuid) {
      const { data: vAcc } = await dbClient
        .from('vpn_accounts')
        .select('*')
        .eq('uuid', specUuid)
        .maybeSingle();
      if (vAcc) targetVpnAcc = vAcc;
    }

    if (!targetVpnAcc && data.user_id) {
      const { data: vAcc } = await dbClient
        .from('vpn_accounts')
        .select('*')
        .eq('user_id', data.user_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (vAcc) targetVpnAcc = vAcc;
    }

    if (!targetVpnAcc && email) {
      const { data: vAcc } = await dbClient
        .from('vpn_accounts')
        .select('*')
        .ilike('email', email)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (vAcc) targetVpnAcc = vAcc;
    }

    const targetUuid = targetVpnAcc?.uuid || specUuid;

    if (!targetUuid) {
      const uuidErr: any = new Error('Could not resolve target VPN account UUID for renewal request.');
      uuidErr.statusCode = 400;
      throw uuidErr;
    }

    const assertRenewLockStillHeld = async (
      stage: 'before_external_write' | 'before_db_finalization'
    ): Promise<void> => {
      if (!lockClaim.tableAvailable) {
        const missingErr: any = new Error(
          `Missing verified durable renewal lock '${lockKey}' (${stage}); refusing to proceed without required lock.`
        );
        missingErr.statusCode = 409;
        missingErr.code = stage === 'before_db_finalization' ? 'RECONCILIATION_REQUIRED' : 'RENEW_LOCK_MISSING';
        missingErr.beforeExternalWrite = stage === 'before_external_write';
        missingErr.xuiUncertain = stage === 'before_db_finalization';
        missingErr.markLockUncertain = stage === 'before_db_finalization';
        throw missingErr;
      }
      const renewed = await xuiService.renewDurableProvisioningOperationLock({
        dbClient,
        operationKey: lockKey,
        lockOwnerId: lockClaim.lockOwnerId,
      });
      if (!renewed) {
        const fenceErr: any = new Error(
          stage === 'before_db_finalization'
            ? `Lost durable renewal lock '${lockKey}' after 3X-UI renewal mutation; refusing stale DB finalization. Manual reconciliation required.`
            : `Lost durable renewal lock '${lockKey}' before 3X-UI renewal mutation; aborting before external mutation.`
        );
        fenceErr.statusCode = 409;
        fenceErr.code = stage === 'before_db_finalization' ? 'RECONCILIATION_REQUIRED' : 'RENEW_LOCK_LOST';
        fenceErr.beforeExternalWrite = stage === 'before_external_write';
        fenceErr.xuiUncertain = stage === 'before_db_finalization';
        fenceErr.markLockUncertain = stage === 'before_db_finalization';
        throw fenceErr;
      }
    };

    const manualUpdateResult = await xuiService.withClientMutationLock(
      {
        dbClient,
        clientUuid: targetUuid,
        operationType: 'client_lock',
        targetId: `approve_renew:${cleanRequestId}`,
        requireDurableLock: true,
        allowUncertainRecovery: false,
        metadata: { renewRequestId: cleanRequestId, action: 'manual_approve_renew' },
      },
      async (assertClientLockStillHeld) => {
        await xuiService.assertNoUnresolvedClientRenewalGrant({
          dbClient,
          clientUuid: targetUuid,
          excludeRenewRequestId: cleanRequestId,
          operationDescription: 'manual renewal approval',
        });

        let oldExpiryMs: number | null = null;
        if (data.old_expiry) {
          oldExpiryMs = new Date(data.old_expiry).getTime();
        } else if (parsedNotes?.old_expiry) {
          oldExpiryMs = new Date(parsedNotes.old_expiry).getTime();
        }

        const getClientExpiryCall = options?.getClientExpiryFn || xuiService.getClientExpiry;
        const updateClientExpiryCall = options?.updateClientExpiryFn || xuiService.updateClientExpiry;

        if (!oldExpiryMs || isNaN(oldExpiryMs)) {
          try {
            oldExpiryMs = await getClientExpiryCall(targetUuid);
          } catch (e) {
            console.warn('[RenewController] Could not fetch live expiry from 3X-UI:', e);
          }
        }

        if (!oldExpiryMs || isNaN(oldExpiryMs)) {
          if (targetVpnAcc?.expiry_time) {
            oldExpiryMs = Number(targetVpnAcc.expiry_time);
          } else if (targetVpnAcc?.expiry_date) {
            oldExpiryMs = new Date(targetVpnAcc.expiry_date).getTime();
          }
        }

        const oldExpiryIso =
          oldExpiryMs && !isNaN(oldExpiryMs)
            ? new Date(oldExpiryMs).toISOString()
            : new Date().toISOString();

        const planName =
          data.plan_name ||
          data.planName ||
          data.plan ||
          parsedNotes?.plan_name ||
          parsedNotes?.planName ||
          '';

        // Resolve authoritative renewal quota BEFORE touching 3X-UI so Special Offers, legacy pending
        // requests, and missing/ambiguous/forged metadata never default to Unlimited.
        let targetVpnConfig: any = null;
        let targetParentOrder: any = null;
        try {
          const { data: cfgRow } = await dbClient
            .from('vpn_configs')
            .select('*')
            .eq('uuid', targetUuid)
            .maybeSingle();
          if (cfgRow) targetVpnConfig = cfgRow;
        } catch {
          // Non-blocking lookup
        }
        try {
          if (targetVpnAcc?.order_id) {
            const { data: ordRow } = await dbClient
              .from('orders')
              .select('*')
              .eq('id', targetVpnAcc.order_id)
              .maybeSingle();
            if (ordRow) targetParentOrder = ordRow;
          }
          if (!targetParentOrder) {
            const { data: ordRowByUuid } = await dbClient
              .from('orders')
              .select('*')
              .eq('client_uuid', targetUuid)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (ordRowByUuid) targetParentOrder = ordRowByUuid;
          }
        } catch {
          // Non-blocking lookup
        }

        const resolvedManualQuota = xuiService.resolveAuthoritativeRenewalQuota({
          renewRequest: data,
          extraNotes: parsedNotes,
          durationMonths,
          vpnAccount: targetVpnAcc,
          vpnConfig: targetVpnConfig,
          parentOrder: targetParentOrder,
        });

        if (!resolvedManualQuota.resolved || !resolvedManualQuota.quotaMode) {
          const quotaErr: any = new Error(
            resolvedManualQuota.reason ||
              'Renewal quota tier (100GB vs Unlimited) could not be conclusively verified. Held for manual reconciliation without modifying 3X-UI.'
          );
          quotaErr.statusCode = 409;
          quotaErr.code = resolvedManualQuota.blockedReason || 'UNVERIFIED_RENEWAL_QUOTA_METADATA';
          quotaErr.beforeExternalWrite = true;
          quotaErr.xuiUncertain = false;
          throw quotaErr;
        }

        // Narrowly scoped fencing callbacks verifying BOTH renew:<id> AND client:<uuid> locks
        // immediately before every external 3X-UI mutation attempt (and after post-write read-back).
        const verifyRenewalAndClientLocksBeforeExternalMutation = async (): Promise<void> => {
          await assertClientLockStillHeld();
          await assertRenewLockStillHeld('before_external_write');
        };
        const verifyRenewalAndClientLocksAfterExternalMutation = async (): Promise<void> => {
          try {
            await assertClientLockStillHeld();
          } catch {
            const reconErr: any = new Error(
              `Lost durable client lock 'client:${targetUuid}' after 3X-UI renewal update; manual reconciliation required.`
            );
            reconErr.statusCode = 409;
            reconErr.code = 'RECONCILIATION_REQUIRED';
            reconErr.beforeExternalWrite = false;
            reconErr.xuiUncertain = true;
            reconErr.markLockUncertain = true;
            throw reconErr;
          }
          await assertRenewLockStillHeld('before_db_finalization');
        };

        const { new_expiryMs, newTotalBytes, verifiedEnable, inboundId } =
          await updateClientExpiryCall(targetUuid, durationMonths, planName, oldExpiryMs, {
            dbClient,
            getInboundsFn: options?.getInboundsFn,
            requestApiFn: options?.requestApiFn,
            nowMs: options?.nowMs,
            requireDurableLock: true,
            allowUncertainRecovery: false,
            beforeExternalMutation: verifyRenewalAndClientLocksBeforeExternalMutation,
            afterExternalMutationCheck: verifyRenewalAndClientLocksAfterExternalMutation,
            signal: options?.signal,
            verifiedQuota: {
              quotaMode: resolvedManualQuota.quotaMode,
              addedQuotaBytes: resolvedManualQuota.addedQuotaBytes ?? 0,
              canonicalPlanId: resolvedManualQuota.canonicalPlanId,
            },
          });

        if (!verifiedEnable || !new_expiryMs || new_expiryMs <= Date.now()) {
          throw new Error(
            `3X-UI client reactivation verification failed for UUID ${targetUuid}: client remains disabled or expiry was not extended in the future.`
          );
        }

        return {
          oldExpiryIso,
          new_expiryMs,
          new_expiryIso: new Date(new_expiryMs).toISOString(),
          newTotalBytes,
          inboundId,
        };
      }
    );

    // Post-write lock fencing: ensure this worker STILL owns renew:<id> before finalizing DB rows
    await assertRenewLockStillHeld('before_db_finalization');

    const { oldExpiryIso, new_expiryMs, new_expiryIso, newTotalBytes } = manualUpdateResult;
    const nowIso = new Date().toISOString();

    const updatedNotesObj =
      parsedNotes && typeof parsedNotes === 'object'
        ? {
            ...parsedNotes,
            old_expiry: oldExpiryIso,
            new_expiry: new_expiryIso,
            approved_at: nowIso,
          }
        : undefined;

    const updatePayload: Record<string, any> = {
      status: 'approved',
      provisioning_status: 'completed',
      updated_at: nowIso,
      ...(updatedNotesObj ? { notes: JSON.stringify(updatedNotesObj) } : {}),
    };

    let { data: updatedRow, error: updateErr } = await dbClient
      .from('renew_requests')
      .update(updatePayload)
      .eq('id', cleanRequestId)
      .select()
      .maybeSingle();

    if (updateErr && String(updateErr.message || '').includes('provisioning_status')) {
      const { provisioning_status: _omitted, ...fallbackPayload } = updatePayload;
      const retry = await dbClient
        .from('renew_requests')
        .update(fallbackPayload)
        .eq('id', cleanRequestId)
        .select()
        .maybeSingle();
      updatedRow = retry.data;
      updateErr = retry.error;
    }

    if (updateErr) {
      console.error('[RenewController] Error updating renew_requests table:', updateErr);
      const dbErr: any = new Error(
        `3X-UI renewal succeeded but updating renew_requests failed (${updateErr?.message || updateErr}); manual reconciliation required.`
      );
      dbErr.statusCode = 409;
      dbErr.code = 'RECONCILIATION_REQUIRED';
      dbErr.xuiUncertain = true;
      dbErr.markLockUncertain = true;
      throw dbErr;
    }

    const dataLimitStr =
      newTotalBytes > 0 ? `${newTotalBytes / (1024 * 1024 * 1024)}GB` : 'Unlimited';

    try {
      let updatedSpecific = false;
      const accUpdatePayload = {
        expiry_date: new_expiryIso,
        expiry_time: new_expiryMs,
        total_bytes: newTotalBytes,
        data_limit: dataLimitStr,
        status: 'active',
        updated_at: nowIso,
      };

      if (targetVpnAcc?.id) {
        const { error: vErr } = await dbClient
          .from('vpn_accounts')
          .update(accUpdatePayload)
          .eq('id', targetVpnAcc.id);
        if (!vErr) updatedSpecific = true;
      } else if (targetUuid) {
        const { error: vErr } = await dbClient
          .from('vpn_accounts')
          .update(accUpdatePayload)
          .eq('uuid', targetUuid);
        if (!vErr) updatedSpecific = true;
      }

      if (!updatedSpecific && targetUuid) {
        await dbClient
          .from('vpn_accounts')
          .update(accUpdatePayload)
          .eq('uuid', targetUuid);
      }
    } catch (vErr) {
      console.warn('[RenewController] vpn_accounts update warning:', vErr);
    }

    try {
      if (targetUuid) {
        await dbClient
          .from('vpn_configs')
          .update({
            expiry_date: new_expiryIso,
            data_limit: dataLimitStr,
            enabled: true,
            status: 'active',
          })
          .eq('uuid', targetUuid);

        await dbClient
          .from('orders')
          .update({
            expiry_date: new_expiryIso,
            status: 'completed',
            payment_status: 'Paid',
            updated_at: nowIso,
          })
          .eq('client_uuid', targetUuid);
      }
    } catch (cErr) {
      console.warn('[RenewController] vpn_configs/orders update warning:', cErr);
    }

    if (!options?.skipSideEffects) {
      try {
        await createCustomerNotification({
          userId: data.user_id || data.userId || null,
          userEmail: email,
          title: 'VPN Renewed & Reactivated',
          message: `Your VPN renewal request for "${data.plan_name || data.planName || 'Plan'}" was approved and your VPN connection has been reactivated. Expiry extended to ${new Date(new_expiryMs).toLocaleDateString()}.`,
          type: 'vpn_renewed',
        });
      } catch (nErr: any) {
        console.error('[RenewController] CRITICAL: Customer notification creation error:', nErr.message || nErr);
      }

      sendRenewApprovedNotification({
        email,
        userEmail: email,
        planName: data.planName || data.plan_name || data.plan || 'FIREVPN Package',
        durationMonths,
        new_expiry: new_expiryIso,
        approved_at: new Date(nowIso),
      }).catch((telegramErr) => {
        console.error('[RenewController] Telegram approved notification error:', telegramErr?.message || telegramErr);
      });

      syncRenewTelegramInlineMessage(cleanRequestId, 'APPROVED', {
        adminLabel: options?.adminLabel || 'Admin Panel',
        uuid: targetUuid,
        newExpiry: new_expiryIso,
      }).catch(() => {});

      if (email) {
        sendRenewalApprovedEmail({
          userEmail: email,
          customerName: data.user_name || parsedNotes?.user_name || undefined,
          renewalId: cleanRequestId,
          packageName: data.planName || data.plan_name || data.plan || 'FIREVPN Package',
          expiryDate: new_expiryIso,
          vlessUrl: targetVpnAcc?.vless_url || '',
          userId: data.user_id || data.userId,
        }).catch((e) => console.warn('[RenewController] Renewal approved email warning:', e));
      }

      xuiService.triggerBackgroundSyncIfNeeded('VPN Renewed', true);
    }

    finalLockStatus = 'completed';
    return {
      success: true,
      provisionalConfirmed: false,
      uuid: targetUuid,
      newExpiryIso: new_expiryIso,
      data: updatedRow,
    };
  } catch (err: any) {
    finalLockStatus = err?.markLockUncertain ? 'uncertain' : 'failed';
    finalLockError = err?.message || String(err);
    throw err;
  } finally {
    if (lockClaim.tableAvailable) {
      await xuiService.finalizeDurableProvisioningOperationLock({
        dbClient,
        operationKey: lockKey,
        lockOwnerId: lockClaim.lockOwnerId,
        status: finalLockStatus,
        errorMessage: finalLockError,
      });
    }
  }
};

export const approveRenewRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  const { requestId } = req.params;

  try {
    if (!requestId) {
      res.status(400).json({ error: 'Request ID is required' });
      return;
    }

    const result = await executeRenewalApproval(requestId, {
      adminId: req.user?.uid || null,
      adminLabel: req.user?.email ? `Admin (${req.user.email})` : 'Admin Panel',
      dbClient: (req as any).dbClient || supabaseAdmin || supabase,
      signal: (req as any).timeoutSignal,
    });

    if (res.headersSent) return;
    res.json({
      success: true,
      provisionalConfirmed: result.provisionalConfirmed,
      message: result.provisionalConfirmed
        ? 'Provisional renewal payment confirmed and verified without duplicate extension.'
        : 'Renewal request approved, client subscription extended and VPN reactivated successfully.',
      data: result.data,
    });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 500;
    console.error(`[RenewController] Error approving renewal request ${requestId}:`, error?.message || error);
    if (res.headersSent) return;
    res.status(statusCode).json({
      success: false,
      error:
        error?.message ||
        'Failed to approve renewal and reactivate 3X-UI client. The request remains pending and can be retried safely.',
      ...(error?.code ? { code: error.code } : {}),
    });
  }
};

/**
 * Authoritative renewal rejection handler shared by Admin HTTP API and Telegram inline button callbacks.
 * Works regardless of whether AUTO_ACTIVATE_RENEWALS_ENABLED is true or false.
 * - If the renewal request was provisionally applied, rolls back 3X-UI expiry, quota, and enable state
 *   (preserving live traffic counters) and restores Supabase records from pre_renewal_db_snapshot
 *   while preserving valid paid VPN access.
 * - If the renewal request was a manual pending request, marks it rejected.
 */
export const executeRenewalRejection = async (
  requestId: string,
  reason = 'Rejected by Admin',
  options?: ExecuteRenewalActionOptions
): Promise<{
  success: boolean;
  provisionalRevoked: boolean;
  uuid?: string;
  data?: any;
}> => {
  const cleanRequestId = String(requestId || '').trim();
  if (!cleanRequestId) {
    throw new Error('Request ID is required');
  }

  const dbClient = options?.dbClient || supabaseAdmin || supabase;
  const lockKey = `renew:${cleanRequestId}`;
  const lockClaim = await xuiService.acquireDurableProvisioningOperationLock({
    dbClient,
    operationKey: lockKey,
    operationType: 'reject_renew',
    targetId: cleanRequestId,
    leaseSeconds: 120,
    requireDurableLock: true,
    allowUncertainRecovery: false,
    metadata: { action: 'reject_renew', reason, adminLabel: options?.adminLabel || 'Admin' },
  });

  if (!lockClaim.acquired) {
    throw xuiService.buildDurableLockFailureError(
      lockClaim,
      `Renewal request '${cleanRequestId}'`
    );
  }

  let finalLockStatus: 'completed' | 'failed' | 'uncertain' = 'failed';
  let finalLockError: string | null = null;

  try {
    const { data, error: fetchErr } = await dbClient
      .from('renew_requests')
      .select('*')
      .eq('id', cleanRequestId)
      .maybeSingle();

    if (fetchErr || !data) {
      const notFoundErr: any = new Error('Renewal request not found');
      notFoundErr.statusCode = 404;
      throw notFoundErr;
    }

    const currentStatus = String(data.status || '').toLowerCase();
    if (currentStatus !== 'pending') {
      const statusErr: any = new Error(
        `Cannot reject request with status '${data.status}'. Status must be 'pending'.`
      );
      statusErr.statusCode = 400;
      throw statusErr;
    }

    const email = data.user_email || data.userEmail || data.email;
    const nowIso = new Date().toISOString();

    const revokeRes = await xuiService.revokeProvisionalRenewal(cleanRequestId, reason, {
      dbClient,
      adminLabel: options?.adminLabel || (options?.adminId ? `Admin (${options.adminId})` : 'Admin Panel'),
      requestApiFn: options?.requestApiFn,
      getInboundsFn: options?.getInboundsFn,
      nowMs: options?.nowMs,
      heldRenewLockOwnerId: lockClaim.lockOwnerId,
      heldRenewLockTableAvailable: lockClaim.tableAvailable,
      signal: options?.signal,
    });

    let updatedRow: any = data;

    if (!revokeRes.handledAsProvisional) {
      xuiService.assertRequestNotTimedOutBeforeExternalMutation(
        options?.signal,
        `manual renewal rejection for request ${cleanRequestId}`
      );
      if (lockClaim.tableAvailable) {
        const renewLockStillOwned = await xuiService.renewDurableProvisioningOperationLock({
          dbClient,
          operationKey: lockKey,
          lockOwnerId: lockClaim.lockOwnerId,
        });
        if (!renewLockStillOwned) {
          const fenceErr: any = new Error(
            `Lost durable renewal lock '${lockKey}' before updating manual rejection in DB; aborting stale write.`
          );
          fenceErr.statusCode = 409;
          fenceErr.code = 'RENEW_LOCK_LOST';
          fenceErr.beforeExternalWrite = true;
          fenceErr.xuiUncertain = false;
          throw fenceErr;
        }
      }

      const { data: manualRejectedRow, error: updateErr } = await dbClient
        .from('renew_requests')
        .update({
          status: 'rejected',
          updated_at: nowIso,
        })
        .eq('id', cleanRequestId)
        .select()
        .maybeSingle();

      if (updateErr) {
        console.error('[RenewController] Error updating renew_requests on rejection:', updateErr);
        throw updateErr;
      }
      updatedRow = manualRejectedRow;
    } else {
      const { data: refreshedRow } = await dbClient
        .from('renew_requests')
        .select('*')
        .eq('id', cleanRequestId)
        .maybeSingle();
      if (refreshedRow) updatedRow = refreshedRow;
    }

    if (!options?.skipSideEffects) {
      try {
        await createCustomerNotification({
          userId: data.user_id || data.userId || null,
          userEmail: email,
          title: 'Payment Rejected',
          message: revokeRes.handledAsProvisional
            ? `Your VPN renewal payment for "${data.plan_name || data.planName || 'Plan'}" was rejected (${reason}) and the provisional renewal extension has been rolled back.`
            : `Your VPN renewal payment/request for "${data.plan_name || data.planName || 'Plan'}" was rejected: ${reason}`,
          type: 'payment_rejected',
        });
      } catch (nErr: any) {
        console.error('[RenewController] CRITICAL: Customer notification creation error on reject:', nErr.message || nErr);
      }

      syncRenewTelegramInlineMessage(cleanRequestId, 'REJECTED', {
        adminLabel: options?.adminLabel || 'Admin Panel',
        uuid: revokeRes.uuid,
        reason,
      }).catch(() => {});

      if (email) {
        sendRenewalRejectedEmail({
          userEmail: email,
          customerName: data.user_name || undefined,
          renewalId: cleanRequestId,
          packageName: data.plan_name || data.planName || 'VPN Plan',
          reason,
          userId: data.user_id || data.userId,
        }).catch((e) => console.warn('[RenewController] Renewal rejected email warning:', e));
      }
    }

    finalLockStatus = 'completed';
    return {
      success: true,
      provisionalRevoked: revokeRes.handledAsProvisional,
      uuid: revokeRes.uuid,
      data: updatedRow,
    };
  } catch (err: any) {
    finalLockStatus = err?.markLockUncertain ? 'uncertain' : 'failed';
    finalLockError = err?.message || String(err);
    throw err;
  } finally {
    if (lockClaim.tableAvailable) {
      await xuiService.finalizeDurableProvisioningOperationLock({
        dbClient,
        operationKey: lockKey,
        lockOwnerId: lockClaim.lockOwnerId,
        status: finalLockStatus,
        errorMessage: finalLockError,
      });
    }
  }
};

export const rejectRenewRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  const { requestId } = req.params;
  const reason =
    req.body?.reason || req.body?.reject_reason || req.body?.rejection_reason || 'Rejected by Admin';

  try {
    if (!requestId) {
      res.status(400).json({ error: 'Request ID is required' });
      return;
    }

    const result = await executeRenewalRejection(requestId, reason, {
      adminId: req.user?.uid || null,
      adminLabel: req.user?.email ? `Admin (${req.user.email})` : 'Admin Panel',
      dbClient: (req as any).dbClient || supabaseAdmin || supabase,
      signal: (req as any).timeoutSignal,
    });

    if (res.headersSent) return;
    res.json({
      success: true,
      provisionalRevoked: result.provisionalRevoked,
      message: result.provisionalRevoked
        ? 'Renewal request rejected and provisional VPN extension rolled back safely.'
        : 'Renewal request rejected successfully.',
      data: result.data,
    });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 500;
    console.error(`[RenewController] Error rejecting renewal request ${requestId}:`, error?.message || error);
    if (res.headersSent) return;
    res.status(statusCode).json({
      success: false,
      error: error?.message || 'Failed to reject renewal request',
      ...(error?.code ? { code: error.code } : {}),
    });
  }
};

/**
 * Authoritative server-side order creation endpoint.
 * Computes verified pricing/discounts/special offers on the server, forces `status='pending'`
 * and `payment_status='Pending Verification'`, persists the order via supabaseAdmin,
 * and dispatches customer & Telegram admin notifications.
 */
export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const authEmail = String(req.user?.email || '').trim().toLowerCase();
    if (!uid || !authEmail) {
      res.status(401).json({ success: false, error: 'Unauthorized: Authentication required.' });
      return;
    }

    const data = req.body || {};
    const serverName = String(data.server || 'Singapore').trim();
    if (serverName.toLowerCase().includes('united states') || serverName.toLowerCase() === 'us') {
      res.status(400).json({
        success: false,
        error: 'Currently Unavailable – This server is temporarily unavailable. Please select another server.'
      });
      return;
    }

    const isManualBilling = data.source === 'billing_page';
    const slipUrl = String(data.slipUrl || data.slip_url || '').trim();
    if (!slipUrl) {
      res.status(400).json({ success: false, error: 'Payment slip receipt is required.' });
      return;
    }

    const dbClient = supabaseAdmin || supabase;

    // Idempotency / duplicate-retry protection: if an identical pending order for this customer & slip was just created, return it instead of creating a duplicate
    const twoMinutesAgoIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: existingPendingOrder } = await dbClient
      .from('orders')
      .select('*')
      .eq('customer_id', uid)
      .eq('slip_url', slipUrl)
      .eq('status', 'pending')
      .gte('created_at', twoMinutesAgoIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingPendingOrder) {
      const dedupDebugCtx = evaluateAutoActivationDebugContext(uid, authEmail, data.source);
      logAutoActivationDebug('deduplication_early_return', {
        endpoint: 'createOrder',
        orderId: existingPendingOrder.order_id || null,
        ...dedupDebugCtx,
        deduplicationTriggered: true,
        enteredAutoActivationBlock: false,
        provisionalProvisioningInvoked: false,
        reason: 'DEDUPLICATION_EARLY_RETURN',
      });
      res.status(200).json({
        success: true,
        deduplicated: true,
        order: existingPendingOrder,
        orderDocId: existingPendingOrder.id,
        orderId: existingPendingOrder.order_id,
        message: 'Order already submitted and pending payment verification.'
      });
      return;
    }

    // Basic path traversal protection always applies without breaking legacy manual slip URL formats.
    if (slipUrl.includes('..') || slipUrl.includes('\0')) {
      res.status(400).json({
        success: false,
        error: 'Invalid payment slip path.',
      });
      return;
    }

    const autoActivateOrdersEnabled = isUserAuthorizedForAutoActivateNewOrders(uid, authEmail);
    const autoActivationDebugCtx = evaluateAutoActivationDebugContext(uid, authEmail, data.source);

    // When automatic activation is enabled, strictly validate storage slip ownership up front;
    // when AUTO_ACTIVATE_NEW_ORDERS_ENABLED=false, preserve 100% backward-compatible manual order submission.
    if (autoActivateOrdersEnabled && !isManualBilling) {
      const ownershipCheck = isPaymentSlipStoragePathOwnedByUser({
        slipUrl,
        uid,
        email: authEmail,
      });
      if (!ownershipCheck.valid) {
        logAutoActivationDebug('upfront_ownership_rejected', {
          endpoint: 'createOrder',
          ...autoActivationDebugCtx,
          deduplicationTriggered: false,
          enteredAutoActivationBlock: false,
          provisionalProvisioningInvoked: false,
          reason: `UPFRONT_OWNERSHIP_REJECTED:${ownershipCheck.reason || 'INVALID_SLIP_PATH'}`,
        });
        res.status(400).json({
          success: false,
          error:
            ownershipCheck.reason === 'OWNERSHIP_MISMATCH'
              ? 'Payment slip ownership mismatch. Please upload your own payment receipt.'
              : 'Invalid payment slip path. Please upload your payment receipt again.',
        });
        return;
      }
    }

    let verifiedPrice: {
      originalPrice: number;
      discountAmount: number;
      discountPercentage: number;
      finalPrice: number;
      appliedDiscount?: any | null;
      appliedOffer?: any | null;
    };

    if (isManualBilling) {
      const manualAmt = Number(data.amount);
      if (!Number.isFinite(manualAmt) || manualAmt <= 0 || manualAmt > 500000) {
        res.status(400).json({ success: false, error: 'Please enter a valid payment amount.' });
        return;
      }
      const rounded = Math.round(manualAmt);
      verifiedPrice = {
        originalPrice: rounded,
        discountAmount: 0,
        discountPercentage: 0,
        finalPrice: rounded,
        appliedDiscount: null,
        appliedOffer: null,
      };
    } else if (data.offerId || data.offer_id) {
      const offerVerified = await verifySpecialOfferCheckoutPrice({
        offerId: String(data.offerId || data.offer_id),
        packageId: data.packageId,
        packageName: data.plan || data.packageName,
        category: data.category,
        packageType: data.packageType,
        duration: data.duration,
      });
      verifiedPrice = {
        originalPrice: offerVerified.originalPrice,
        discountAmount: offerVerified.discountAmount,
        discountPercentage: offerVerified.discountPercentage,
        finalPrice: offerVerified.finalPrice,
        appliedDiscount: null,
        appliedOffer: offerVerified.offer,
      };
    } else {
      const { calculateVerifiedOrderPrice } = await import('../services/discountService.js');
      verifiedPrice = await calculateVerifiedOrderPrice({
        packageId: data.packageId,
        packageName: data.plan || data.packageName,
        category: data.category,
        packageType: data.packageType,
        duration: data.duration,
      });
    }

    const verifiedAmount = verifiedPrice.finalPrice;
    const rawClientOrderId = String(data.clientOrderId || data.orderId || '').trim();
    let generatedOrderId = `ORD-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    if (/^ORD-\d{6}-\d{3,4}$/.test(rawClientOrderId)) {
      const { data: existingOrderById } = await dbClient
        .from('orders')
        .select('id')
        .eq('order_id', rawClientOrderId)
        .maybeSingle();
      if (!existingOrderById) {
        generatedOrderId = rawClientOrderId;
      }
    }
    const packageName = String(data.plan || data.packageName || 'VPN Package').trim().slice(0, 180);

    const paymentMetadata: Record<string, any> = {
      ...(typeof data.metadata === 'object' && data.metadata ? data.metadata : {}),
      paymentMethod: String(data.paymentMethod || 'Bank Transfer').slice(0, 120),
      configurationName: String(data.configurationName || data.customerName || '').trim().slice(0, 120),
      plan: packageName,
      packageId: data.packageId || null,
      packageName,
      package_name: packageName,
      templateId: data.templateId || null,
      template_id: data.templateId || null,
      packageType: String(data.packageType || (isManualBilling ? 'Manual Bank Transfer' : 'SIM Unlimited')).slice(0, 80),
      server: serverName,
      duration: String(data.duration || '1 Month').slice(0, 60),
      duration_months: data.durationMonths || (verifiedPrice.appliedOffer?.duration_months ?? undefined),
      category: String(data.category || 'SIM').slice(0, 40),
      package: packageName,
      type: String(data.type || 'Unlimited').slice(0, 40),
      original_price: verifiedPrice.originalPrice,
      discount_amount: verifiedPrice.discountAmount,
      discount_percentage: verifiedPrice.discountPercentage,
      final_price: verifiedAmount,
      discount_id: verifiedPrice.appliedDiscount?.id || null,
      discount_name: verifiedPrice.appliedDiscount?.name || null,
      is_special_offer: Boolean(verifiedPrice.appliedOffer),
      offer_id: verifiedPrice.appliedOffer?.id || null,
      offer_name: verifiedPrice.appliedOffer?.name || null,
      extend_uuid: data.extendUuid || undefined,
      price: verifiedAmount,
      bankName: data.bankName ? String(data.bankName).slice(0, 120) : undefined,
      transactionRef: String(data.transactionRef || '').trim().slice(0, 120),
      paymentDate: String(data.paymentDate || '').trim().slice(0, 40),
      paymentTime: String(data.paymentTime || '').trim().slice(0, 40),
      notes: String(data.notes || '').trim().slice(0, 1000),
      slipName: data.slipName ? String(data.slipName).slice(0, 180) : undefined,
      slipType: data.slipType ? String(data.slipType).slice(0, 80) : undefined,
      source: isManualBilling ? 'billing_page' : 'store_checkout',
    };

    const orderPayload: Record<string, any> = {
      order_id: generatedOrderId,
      customer_id: uid,
      email: authEmail,
      package_name: packageName,
      amount: verifiedAmount,
      payment_method: JSON.stringify(paymentMetadata),
      payment_status: 'Pending Verification',
      status: 'pending',
      provisioning_status: 'pending',
      slip_url: slipUrl,
      vless_url: null,
      client_uuid: null,
      created_at: new Date().toISOString(),
    };

    let { data: insertedOrder, error: insertErr } = await dbClient
      .from('orders')
      .insert(orderPayload)
      .select('*')
      .maybeSingle();

    if (insertErr && String(insertErr.message || '').includes('provisioning_status')) {
      const { provisioning_status: _omitted, ...fallbackOrderPayload } = orderPayload;
      const retryNoProvCol = await dbClient
        .from('orders')
        .insert(fallbackOrderPayload)
        .select('*')
        .maybeSingle();
      insertedOrder = retryNoProvCol.data;
      insertErr = retryNoProvCol.error;
    }

    if (insertErr && (insertErr.message?.includes('payment_status') || insertErr.code === '23514')) {
      const { provisioning_status: _omitted, ...fallbackOrderPayload } = orderPayload;
      const retry = await dbClient
        .from('orders')
        .insert({ ...fallbackOrderPayload, payment_status: 'Pending' })
        .select('*')
        .maybeSingle();
      insertedOrder = retry.data;
      insertErr = retry.error;
    }

    if (insertErr || !insertedOrder) {
      console.error('[RenewController] Authoritative order insert failed:', insertErr?.message || insertErr);
      res.status(500).json({ success: false, error: 'Failed to create order. Please try again.' });
      return;
    }

    // Requirement 1: Automatic New Order Activation (when AUTO_ACTIVATE_NEW_ORDERS_ENABLED === 'true')
    // Before auto-activating, verify actual uploaded slip bytes + compute SHA-256 and atomically claim the receipt
    // in PostgreSQL (public.claim_payment_receipt). If receipt verification or atomic claim fails (e.g. duplicate file
    // or renamed duplicate image), hold automatic activation and preserve the order in the manual pending admin queue.
    let autoActivationResult: any = null;
    let autoActivationBlockedReason: string | null = null;
    if (autoActivateOrdersEnabled && !isManualBilling) {
      logAutoActivationDebug('auto_activation_entered', {
        endpoint: 'createOrder',
        orderId: insertedOrder.order_id || null,
        ...autoActivationDebugCtx,
        deduplicationTriggered: false,
        enteredAutoActivationBlock: true,
        reason: 'NONE',
      });
      try {
        const slipCheck = await computePaymentSlipSha256AndVerifyStorage({
          slipUrl,
          userUid: uid,
          userEmail: authEmail,
          allowedFolders: ['orders', 'billing'],
          storageClient: dbClient.storage,
        });

        logAutoActivationDebug('receipt_verification', {
          endpoint: 'createOrder',
          orderId: insertedOrder.order_id || null,
          enteredAutoActivationBlock: true,
          receiptVerificationSucceeded: Boolean(slipCheck.valid),
          receiptVerificationCode: slipCheck.code || (slipCheck.valid ? 'OK' : 'SLIP_VERIFICATION_FAILED'),
          provisionalProvisioningInvoked: false,
          reason: slipCheck.valid ? 'NONE' : `SLIP_VERIFICATION_FAILED:${slipCheck.code || 'UNKNOWN'}`,
        });

        if (!slipCheck.valid) {
          autoActivationBlockedReason = slipCheck.code || 'SLIP_VERIFICATION_FAILED';
          console.warn(
            `[RenewController] Auto-activation held for order ${insertedOrder.order_id || insertedOrder.id} (${autoActivationBlockedReason}): ${slipCheck.error || 'Slip verification failed'}`
          );
        } else {
          const claimRes = await claimPaymentReceiptForAutoActivation({
            sha256: slipCheck.sha256,
            canonicalSlipUrl: slipCheck.canonicalSlipUrl,
            orderId: insertedOrder.id,
            userId: uid,
            userEmail: authEmail,
            byteSize: slipCheck.byteSize,
            contentType: slipCheck.contentType,
            dbClient,
          });

          logAutoActivationDebug('receipt_claim', {
            endpoint: 'createOrder',
            orderId: insertedOrder.order_id || null,
            enteredAutoActivationBlock: true,
            receiptVerificationSucceeded: true,
            receiptClaimSucceeded: Boolean(claimRes.claimed),
            receiptClaimCode: claimRes.code || null,
            receiptConflictReason: claimRes.conflictReason || null,
            provisionalProvisioningInvoked: false,
            reason: claimRes.claimed
              ? 'NONE'
              : `RECEIPT_CLAIM_FAILED:${claimRes.conflictReason || claimRes.code || 'DUPLICATE_SLIP'}`,
          });

          if (!claimRes.claimed) {
            autoActivationBlockedReason = claimRes.conflictReason || claimRes.code || 'DUPLICATE_SLIP';
            console.warn(
              `[RenewController] Auto-activation held for order ${insertedOrder.order_id || insertedOrder.id} (${autoActivationBlockedReason}): ${claimRes.error || 'Receipt claim blocked'}`
            );
          } else {
            console.log(
              `[RenewController] AUTO_ACTIVATE_NEW_ORDERS_ENABLED=true: Receipt claimed (${slipCheck.sha256.slice(0, 12)}...). Provisioning full purchased VPN package for order ${insertedOrder.order_id || insertedOrder.id} (payment remains Pending Verification)...`
            );
            logAutoActivationDebug('provisional_provisioning_invoked', {
              endpoint: 'createOrder',
              orderId: insertedOrder.order_id || null,
              enteredAutoActivationBlock: true,
              receiptVerificationSucceeded: true,
              receiptClaimSucceeded: true,
              provisionalProvisioningInvoked: true,
              reason: 'NONE',
            });
            autoActivationResult = await xuiService.provisionOrderClient(insertedOrder.id, undefined, {
              provisional: true,
              dbClient,
            });
            const provisioningSucceeded = Boolean(autoActivationResult?.success && autoActivationResult?.vlessUrl);
            logAutoActivationDebug('provisional_provisioning_result', {
              endpoint: 'createOrder',
              orderId: insertedOrder.order_id || null,
              enteredAutoActivationBlock: true,
              provisionalProvisioningInvoked: true,
              provisionalProvisioningSucceeded: provisioningSucceeded,
              reason: provisioningSucceeded ? 'ACTIVATED' : 'PROVISIONING_RETURNED_NO_CONFIG',
            });
            if (autoActivationResult?.success && autoActivationResult?.vlessUrl) {
              const { data: refreshedOrder } = await dbClient
                .from('orders')
                .select('*')
                .eq('id', insertedOrder.id)
                .maybeSingle();
              if (refreshedOrder) {
                insertedOrder = refreshedOrder;
              } else {
                insertedOrder = {
                  ...insertedOrder,
                  client_uuid: autoActivationResult.uuid,
                  vless_url: autoActivationResult.vlessUrl,
                  subscription_url: autoActivationResult.subscriptionUrl || autoActivationResult.vlessUrl,
                  expiry_date: autoActivationResult.expiryDate || insertedOrder.expiry_date,
                  provisioning_status: 'provisional',
                  payment_status: 'Pending Verification',
                  status: 'pending',
                };
              }
            }
          }
        }
      } catch (autoErr: any) {
        autoActivationBlockedReason = autoActivationBlockedReason || 'PROVISIONING_ERROR';
        logAutoActivationDebug('auto_activation_exception', {
          endpoint: 'createOrder',
          orderId: insertedOrder.order_id || null,
          enteredAutoActivationBlock: true,
          errorName: String(autoErr?.name || 'Error').slice(0, 64),
          reason: autoActivationBlockedReason,
        });
        console.error(
          `[RenewController] Provisional automatic VPN activation failed for order ${insertedOrder.id} (order preserved in pending queue for manual admin review):`,
          autoErr?.message || autoErr
        );
      }
    } else {
      logAutoActivationDebug('auto_activation_skipped', {
        endpoint: 'createOrder',
        orderId: insertedOrder.order_id || null,
        ...autoActivationDebugCtx,
        deduplicationTriggered: false,
        enteredAutoActivationBlock: false,
        receiptVerificationSucceeded: false,
        receiptClaimSucceeded: false,
        provisionalProvisioningInvoked: false,
        reason: resolveAutoActivationSkipReason(autoActivationDebugCtx),
      });
    }

    let resolvedCustomerName = String(
      data.customerName || paymentMetadata.configurationName || ''
    ).trim();

    if (!resolvedCustomerName) {
      try {
        const { data: profileRow } = await dbClient
          .from('profiles')
          .select('full_name')
          .eq('id', uid)
          .maybeSingle();
        if (profileRow?.full_name) {
          resolvedCustomerName = String(profileRow.full_name).trim();
        }
      } catch {
        // ignore profile lookup failure
      }
    }
    if (!resolvedCustomerName) {
      resolvedCustomerName = authEmail.split('@')[0] || 'Customer';
    }

    const isProvisionallyActive = Boolean(insertedOrder.vless_url && insertedOrder.client_uuid);

    const notificationData = {
      orderId: insertedOrder.order_id || generatedOrderId,
      orderDocId: insertedOrder.id,
      customerName: resolvedCustomerName,
      email: authEmail,
      plan: packageName,
      server: serverName,
      duration: paymentMetadata.duration,
      packageType: paymentMetadata.packageType,
      amount: verifiedAmount,
      originalPrice: verifiedPrice.originalPrice,
      discountAmount: verifiedPrice.discountAmount,
      finalPrice: verifiedPrice.finalPrice,
      paymentMethod: paymentMetadata.bankName
        ? `Bank Transfer (${paymentMetadata.bankName})`
        : paymentMetadata.paymentMethod,
      transactionRef: paymentMetadata.transactionRef || 'N/A',
      paymentDate: paymentMetadata.paymentDate || 'N/A',
      paymentTime: paymentMetadata.paymentTime || '',
      slipUrl,
      slipName: paymentMetadata.slipName || '',
      notes: paymentMetadata.notes || '',
      status: insertedOrder.payment_status || 'Pending Verification',
      provisional: isProvisionallyActive,
      provisioningStatus: isProvisionallyActive ? 'provisional' : 'pending',
      autoActivationBlockedReason: autoActivationBlockedReason || undefined,
      clientUuid: insertedOrder.client_uuid || undefined,
      vlessUrl: insertedOrder.vless_url || undefined,
      expiryDate: insertedOrder.expiry_date || undefined,
    };

    try {
      await createCustomerNotification({
        userId: uid,
        userEmail: authEmail,
        title: 'Order Placed',
        message: `Your order #${notificationData.orderId} for "${notificationData.plan}" has been placed successfully.`,
        type: 'order_placed',
        orderId: notificationData.orderId
      });
      await createCustomerNotification({
        userId: uid,
        userEmail: authEmail,
        title: 'Payment Submitted',
        message: `Your payment of LKR ${notificationData.amount} for "${notificationData.plan}" has been submitted for verification.`,
        type: 'payment_submitted',
        orderId: notificationData.orderId
      });
    } catch (notifErr: any) {
      console.error('[RenewController] Customer notification creation warning:', notifErr?.message || notifErr);
    }

    sendOrderReceivedEmail({
      userEmail: authEmail,
      customerName: resolvedCustomerName,
      orderId: notificationData.orderId,
      packageName: notificationData.plan,
      amount: Number(notificationData.amount) || 0,
      vlessUrl: insertedOrder.vless_url || undefined,
      expiryDate: insertedOrder.expiry_date || undefined,
      provisional: isProvisionallyActive,
      userId: uid
    }).catch(e => console.warn('[RenewController] Order received email warning:', e));

    sendNewOrderNotification(notificationData).catch((err) => {
      console.error('[RenewController] Telegram new order notification error:', err?.message || err);
    });

    res.status(201).json({
      success: true,
      order: insertedOrder,
      orderDocId: insertedOrder.id,
      orderId: insertedOrder.order_id || generatedOrderId,
      provisional: isProvisionallyActive,
      autoActivated: isProvisionallyActive,
      autoActivationBlockedReason: autoActivationBlockedReason || null,
      vlessUrl: insertedOrder.vless_url || null,
      subscriptionUrl: insertedOrder.subscription_url || insertedOrder.vless_url || null,
      clientUuid: insertedOrder.client_uuid || null,
      expiryDate: insertedOrder.expiry_date || null,
      verifiedPrice,
      message: isProvisionallyActive
        ? 'Order submitted and VPN package automatically activated! Payment verification is pending admin review.'
        : 'Order created and submitted for payment verification.'
    });
  } catch (error: any) {
    console.error('[RenewController] createOrder error:', error?.message || error);
    res.status(400).json({ success: false, error: error?.message || 'Failed to create order.' });
  }
};

export const createOrderNotification = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const authEmail = String(req.user?.email || '').trim().toLowerCase();
    if (!uid || !authEmail) {
      res.status(401).json({ success: false, error: 'Unauthorized: Authentication required.' });
      return;
    }

    const data = req.body || {};

    const serverName = String(data.server || '').toLowerCase();
    if (serverName.includes('united states') || serverName === 'us') {
      res.status(400).json({
        success: false,
        error: 'Currently Unavailable – This server is temporarily unavailable. Please select another server.'
      });
      return;
    }

    // Server-side independent price & discount / special offer validation to prevent client-side tampering
    let verifiedPrice: {
      originalPrice: number;
      discountAmount: number;
      discountPercentage: number;
      finalPrice: number;
      appliedDiscount?: any | null;
      appliedOffer?: any | null;
    };

    if (data.offerId || data.offer_id) {
      const offerVerified = await verifySpecialOfferCheckoutPrice({
        offerId: String(data.offerId || data.offer_id),
        packageId: data.packageId,
        packageName: data.plan,
        category: data.category,
        packageType: data.packageType,
        duration: data.duration,
      });
      verifiedPrice = {
        originalPrice: offerVerified.originalPrice,
        discountAmount: offerVerified.discountAmount,
        discountPercentage: offerVerified.discountPercentage,
        finalPrice: offerVerified.finalPrice,
        appliedDiscount: null,
        appliedOffer: offerVerified.offer,
      };
    } else {
      const { calculateVerifiedOrderPrice } = await import('../services/discountService.js');
      verifiedPrice = await calculateVerifiedOrderPrice({
        packageId: data.packageId,
        packageName: data.plan,
        category: data.category,
        packageType: data.packageType,
        duration: data.duration,
      });
    }

    const verifiedAmount = verifiedPrice.finalPrice;

    // Verify ownership & pending status before syncing price metadata
    let resolvedOrderRow: any = null;
    let resolvedExtra: any = {};
    let resolvedCustomerName = String(data.customerName || '').trim();

    if (data.orderDocId || data.orderId) {
      const dbClient = supabaseAdmin || supabase;
      const orderLookupCol = data.orderDocId ? 'id' : 'order_id';
      const orderLookupVal = data.orderDocId || data.orderId;
      const { data: existingOrder } = await dbClient
        .from('orders')
        .select('id, order_id, customer_id, email, package_name, amount, payment_method, payment_status, status, slip_url')
        .eq(orderLookupCol, orderLookupVal)
        .maybeSingle();

      if (existingOrder) {
        const orderOwnerUid = String(existingOrder.customer_id || '').trim();
        const orderOwnerEmail = String(existingOrder.email || '').trim().toLowerCase();
        if (orderOwnerUid !== uid && orderOwnerEmail !== authEmail) {
          res.status(403).json({ success: false, error: 'Forbidden: You do not own this order.' });
          return;
        }

        resolvedOrderRow = existingOrder;
        let extra: any = {};
        if (typeof existingOrder.payment_method === 'string' && existingOrder.payment_method.startsWith('{')) {
          try {
            extra = JSON.parse(existingOrder.payment_method);
          } catch (_e) {
            extra = {};
          }
        }
        extra.original_price = verifiedPrice.originalPrice;
        extra.discount_amount = verifiedPrice.discountAmount;
        extra.discount_percentage = verifiedPrice.discountPercentage;
        extra.final_price = verifiedPrice.finalPrice;
        if (verifiedPrice.appliedOffer) {
          extra.is_special_offer = true;
          extra.offer_id = verifiedPrice.appliedOffer.id;
          extra.offer_name = verifiedPrice.appliedOffer.name;
        } else {
          extra.discount_id = verifiedPrice.appliedDiscount?.id || null;
          extra.discount_name = verifiedPrice.appliedDiscount?.name || null;
        }

        resolvedExtra = extra;

        if (String(existingOrder.status || '').toLowerCase() === 'pending') {
          await dbClient
            .from('orders')
            .update({
              amount: verifiedAmount,
              payment_method: JSON.stringify(extra),
            })
            .eq('id', existingOrder.id);

          const notifyDebugCtx = evaluateAutoActivationDebugContext(uid, authEmail, resolvedExtra.source);
          if (isUserAuthorizedForAutoActivateNewOrders(uid, authEmail) && resolvedExtra.source !== 'billing_page') {
            logAutoActivationDebug('auto_activation_entered', {
              endpoint: 'createOrderNotification',
              orderId: existingOrder.order_id || null,
              ...notifyDebugCtx,
              deduplicationTriggered: false,
              enteredAutoActivationBlock: true,
              reason: 'NONE',
            });
            const candidateSlip = String(
              data.slipUrl || existingOrder.slip_url || extra.slipUrl || extra.slip_url || ''
            ).trim();
            try {
              const slipCheck = await computePaymentSlipSha256AndVerifyStorage({
                slipUrl: candidateSlip,
                userUid: uid,
                userEmail: authEmail,
                allowedFolders: ['orders', 'billing'],
                storageClient: dbClient.storage,
              });

              logAutoActivationDebug('receipt_verification', {
                endpoint: 'createOrderNotification',
                orderId: existingOrder.order_id || null,
                enteredAutoActivationBlock: true,
                receiptVerificationSucceeded: Boolean(slipCheck.valid),
                receiptVerificationCode: slipCheck.code || (slipCheck.valid ? 'OK' : 'SLIP_VERIFICATION_FAILED'),
                provisionalProvisioningInvoked: false,
                reason: slipCheck.valid ? 'NONE' : `SLIP_VERIFICATION_FAILED:${slipCheck.code || 'UNKNOWN'}`,
              });

              if (!slipCheck.valid) {
                console.warn(
                  `[RenewController] createOrderNotification auto-activation held for ${existingOrder.id} (${slipCheck.code}): ${slipCheck.error}`
                );
              } else {
                const claimRes = await claimPaymentReceiptForAutoActivation({
                  sha256: slipCheck.sha256,
                  canonicalSlipUrl: slipCheck.canonicalSlipUrl,
                  orderId: existingOrder.id,
                  userId: uid,
                  userEmail: authEmail,
                  byteSize: slipCheck.byteSize,
                  contentType: slipCheck.contentType,
                  dbClient,
                });

                logAutoActivationDebug('receipt_claim', {
                  endpoint: 'createOrderNotification',
                  orderId: existingOrder.order_id || null,
                  enteredAutoActivationBlock: true,
                  receiptVerificationSucceeded: true,
                  receiptClaimSucceeded: Boolean(claimRes.claimed),
                  receiptClaimCode: claimRes.code || null,
                  receiptConflictReason: claimRes.conflictReason || null,
                  provisionalProvisioningInvoked: false,
                  reason: claimRes.claimed
                    ? 'NONE'
                    : `RECEIPT_CLAIM_FAILED:${claimRes.conflictReason || claimRes.code || 'DUPLICATE_SLIP'}`,
                });

                if (!claimRes.claimed) {
                  console.warn(
                    `[RenewController] createOrderNotification auto-activation held for ${existingOrder.id} (${claimRes.conflictReason || claimRes.code}): ${claimRes.error}`
                  );
                } else {
                  logAutoActivationDebug('provisional_provisioning_invoked', {
                    endpoint: 'createOrderNotification',
                    orderId: existingOrder.order_id || null,
                    enteredAutoActivationBlock: true,
                    receiptVerificationSucceeded: true,
                    receiptClaimSucceeded: true,
                    provisionalProvisioningInvoked: true,
                    reason: 'NONE',
                  });
                  const autoProvRes = await xuiService.provisionOrderClient(existingOrder.id, undefined, {
                    provisional: true,
                    dbClient,
                  });
                  const provisioningSucceeded = Boolean(autoProvRes?.success && autoProvRes?.vlessUrl);
                  logAutoActivationDebug('provisional_provisioning_result', {
                    endpoint: 'createOrderNotification',
                    orderId: existingOrder.order_id || null,
                    enteredAutoActivationBlock: true,
                    provisionalProvisioningInvoked: true,
                    provisionalProvisioningSucceeded: provisioningSucceeded,
                    reason: provisioningSucceeded ? 'ACTIVATED' : 'PROVISIONING_RETURNED_NO_CONFIG',
                  });
                  if (autoProvRes?.success && autoProvRes?.vlessUrl) {
                    resolvedOrderRow = {
                      ...existingOrder,
                      vless_url: autoProvRes.vlessUrl,
                      subscription_url: autoProvRes.subscriptionUrl || autoProvRes.vlessUrl,
                      client_uuid: autoProvRes.uuid,
                      expiry_date: autoProvRes.expiryDate,
                      provisioning_status: 'provisional',
                    };
                  }
                }
              }
            } catch (autoErr: any) {
              logAutoActivationDebug('auto_activation_exception', {
                endpoint: 'createOrderNotification',
                orderId: existingOrder.order_id || null,
                enteredAutoActivationBlock: true,
                errorName: String(autoErr?.name || 'Error').slice(0, 64),
                reason: 'PROVISIONING_ERROR',
              });
              console.error(`[RenewController] createOrderNotification provisional activation error for ${existingOrder.id}:`, autoErr?.message || autoErr);
            }
          } else {
            logAutoActivationDebug('auto_activation_skipped', {
              endpoint: 'createOrderNotification',
              orderId: existingOrder.order_id || null,
              ...notifyDebugCtx,
              deduplicationTriggered: false,
              enteredAutoActivationBlock: false,
              receiptVerificationSucceeded: false,
              receiptClaimSucceeded: false,
              provisionalProvisioningInvoked: false,
              reason: resolveAutoActivationSkipReason(notifyDebugCtx),
            });
          }
        }
      }
    }

    if (!resolvedCustomerName) {
      resolvedCustomerName = String(
        resolvedExtra.customerName ||
          resolvedExtra.configurationName ||
          resolvedExtra.full_name ||
          resolvedExtra.name ||
          ''
      ).trim();
    }

    if (!resolvedCustomerName) {
      try {
        const dbClient = supabaseAdmin || supabase;
        const { data: profileRow } = await dbClient
          .from('profiles')
          .select('full_name, email')
          .eq('id', uid)
          .maybeSingle();
        if (profileRow?.full_name) {
          resolvedCustomerName = String(profileRow.full_name).trim();
        }
      } catch {
        // Ignore profile lookup warning
      }
    }

    const resolvedEmail = authEmail;
    if (!resolvedCustomerName) {
      resolvedCustomerName = resolvedEmail.split('@')[0] || 'Customer';
    }

    const resolvedPaymentMethod =
      data.paymentMethod ||
      resolvedExtra.paymentMethod ||
      (resolvedExtra.bankName
        ? `Bank Transfer (${resolvedExtra.bankName})`
        : 'Bank Transfer (Commercial Bank - G.K Nimesha, Ganemulla)');

    const isProvisionallyActive = Boolean(resolvedOrderRow?.vless_url && resolvedOrderRow?.client_uuid);

    const notificationData = {
      orderId: data.orderId || resolvedOrderRow?.order_id || resolvedOrderRow?.id || 'N/A',
      orderDocId: data.orderDocId || resolvedOrderRow?.id || undefined,
      customerName: resolvedCustomerName,
      email: resolvedEmail,
      plan: data.plan || resolvedOrderRow?.package_name || 'N/A',
      server: data.server || resolvedExtra.server || 'Singapore',
      duration: data.duration || resolvedExtra.duration || '1 Month',
      packageType: data.packageType || resolvedExtra.packageType || 'SIM Unlimited',
      amount: verifiedAmount,
      originalPrice: verifiedPrice.originalPrice,
      discountAmount: verifiedPrice.discountAmount,
      finalPrice: verifiedPrice.finalPrice,
      paymentMethod: resolvedPaymentMethod,
      transactionRef: data.transactionRef || resolvedExtra.transactionRef || 'N/A',
      paymentDate: data.paymentDate || resolvedExtra.paymentDate || 'N/A',
      paymentTime: data.paymentTime || resolvedExtra.paymentTime || '',
      slipUrl: data.slipUrl || resolvedOrderRow?.slip_url || resolvedExtra.slipUrl || resolvedExtra.slip_url || '',
      slipName: data.slipName || resolvedExtra.slipName || '',
      notes: data.notes || resolvedExtra.notes || '',
      status: resolvedOrderRow?.payment_status || 'Pending Verification',
      provisional: isProvisionallyActive,
      provisioningStatus: isProvisionallyActive ? 'provisional' : 'pending',
      clientUuid: resolvedOrderRow?.client_uuid || undefined,
      vlessUrl: resolvedOrderRow?.vless_url || undefined,
      expiryDate: resolvedOrderRow?.expiry_date || undefined,
    };

    try {
      await createCustomerNotification({
        userId: uid,
        userEmail: notificationData.email,
        title: 'Order Placed',
        message: `Your order #${notificationData.orderId} for "${notificationData.plan}" has been placed successfully.`,
        type: 'order_placed',
        orderId: notificationData.orderId
      });
      await createCustomerNotification({
        userId: uid,
        userEmail: notificationData.email,
        title: 'Payment Submitted',
        message: `Your payment of LKR ${notificationData.amount} for "${notificationData.plan}" has been submitted for verification.`,
        type: 'payment_submitted',
        orderId: notificationData.orderId
      });
    } catch (notifErr: any) {
      console.error('[RenewController] CRITICAL: Error creating Order Placed/Payment Submitted notifications in createOrderNotification:', notifErr.message || notifErr);
    }

    sendOrderReceivedEmail({
      userEmail: notificationData.email,
      customerName: resolvedCustomerName,
      orderId: notificationData.orderId,
      packageName: notificationData.plan,
      amount: Number(notificationData.amount) || 0,
      vlessUrl: resolvedOrderRow?.vless_url || undefined,
      expiryDate: resolvedOrderRow?.expiry_date || undefined,
      provisional: isProvisionallyActive,
      userId: uid
    }).catch(e => console.warn('[RenewController] Order received email warning:', e));

    sendNewOrderNotification(notificationData).catch((err) => {
      console.error('[RenewController] Telegram new order notification error:', err?.message || err);
    });

    res.json({
      success: true,
      provisional: isProvisionallyActive,
      vlessUrl: resolvedOrderRow?.vless_url || null,
      clientUuid: resolvedOrderRow?.client_uuid || null,
      expiryDate: resolvedOrderRow?.expiry_date || null,
      message: 'New order Telegram notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[RenewController] Error processing order notification:', error?.message || error);
    res.status(500).json({ error: 'Failed to process order notification.' });
  }
};

export const notifyOrderApprove = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = req.body || {};
    
    const notificationData = {
      customerEmail: data.customerEmail || data.email || 'N/A',
      packageName: data.packageName || data.package || data.plan || 'N/A',
      packageType: data.packageType || 'SIM Unlimited',
      server: data.server || 'N/A',
      duration: data.duration || 'N/A',
      price: data.price !== undefined ? data.price : (data.amount !== undefined ? data.amount : 0),
      uuid: data.uuid || 'N/A',
      orderId: data.orderId || 'N/A',
      status: '🟢 COMPLETED'
    };

    if (notificationData.customerEmail && notificationData.customerEmail !== 'N/A' && notificationData.orderId !== 'N/A') {
      sendPaymentApprovedEmail({
        userEmail: notificationData.customerEmail,
        orderId: notificationData.orderId,
        packageName: notificationData.packageName,
        vlessUrl: data.vlessUrl || undefined,
        expiryDate: data.expiryDate || undefined,
        userId: data.userId || undefined
      }).catch((err) => {
        console.warn('[RenewController] Order approve email warning:', err?.message || err);
      });
    }

    sendOrderApprovedNotification(notificationData).catch((err) => {
      console.error('[RenewController] Telegram order approve notification error:', err?.message || err);
    });

    res.json({
      success: true,
      message: 'Order approved Telegram notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[RenewController] Error processing order approve notification:', error.message);
    res.status(500).json({ error: error.message });
  }
};

export const notifyOrderReject = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = req.body || {};

    const notificationData = {
      customerEmail: data.customerEmail || data.email || 'N/A',
      reason: data.reason || 'Payment not received'
    };

    if (notificationData.customerEmail && notificationData.customerEmail !== 'N/A') {
      sendPaymentRejectedEmail({
        userEmail: notificationData.customerEmail,
        orderId: data.orderId || `order_${notificationData.customerEmail}`,
        packageName: data.packageName || data.package || data.plan || 'VPN Plan',
        reason: notificationData.reason,
        userId: data.userId || undefined
      }).catch((err) => {
        console.warn('[RenewController] Order reject email warning:', err?.message || err);
      });
    }

    sendOrderRejectedNotification(notificationData).catch((err) => {
      console.error('[RenewController] Telegram order reject notification error:', err?.message || err);
    });

    res.json({
      success: true,
      message: 'Order rejected Telegram notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[RenewController] Error processing order reject notification:', error.message);
    res.status(500).json({ error: error.message });
  }
};

