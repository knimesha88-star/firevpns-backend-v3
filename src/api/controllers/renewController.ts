import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as xuiService from '../services/xuiService.js';
import { supabase, supabaseAdmin } from '../../lib/supabase.js';
import { sendRenewNotification, sendRenewApprovedNotification, sendNewOrderNotification, sendOrderApprovedNotification, sendOrderRejectedNotification } from '../services/telegramService.js';
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
import {
  computePaymentSlipSha256AndVerifyStorage,
  claimPaymentReceiptForAutoActivation,
  parsePaymentSlipReference,
} from '../services/paymentSlipService.js';

/**
 * Feature flag helpers (Requirement 7 & 8):
 * Both flags default to false. Automatic renewals are strictly disabled in Phase 1.
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

export const isAutoActivateRenewalsEnabled = (): boolean => false;

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
    const customerEmail = authEmail;
    const requestedDuration = Number(data.durationMonths || data.duration || 1);

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
      vpnAccountUuid: data.uuid || data.vpnAccountUuid || null,
      vpnAccountId: data.vpn_account_id || data.vpnAccountId || null,
    });

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

    const dbClient = supabaseAdmin || supabase;
    let renewalRecordId = data.renewalId || data.id || null;

    const effectivePlanDisplay = verified.isSpecialOffer && verified.appliedOffer
      ? `${verified.packageName} (${verified.appliedOffer.name} - ${verified.durationLabel})`
      : data.planName || data.plan || `${verified.packageName} (${verified.planName})`;

    const extraMetadata = {
      planId: data.planId || null,
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
      vpn_account_id: String(data.vpn_account_id || data.vpnAccountId || '').trim(),
      uuid: String(data.uuid || data.vpnAccountUuid || '').trim(),
      config_name: String(data.configName || data.config_name || effectivePlanDisplay).trim(),
      server_node: String(data.serverNode || data.server_node || 'Singapore Server').trim(),
      old_expiry: String(data.oldExpiry || data.old_expiry || '').trim(),
      slip_url: String(data.slipUrl || data.slip_url || '').trim(),
      user_name: String(data.customerName || data.userName || authEmail.split('@')[0] || 'Customer').trim().slice(0, 120),
    };

    if (renewalRecordId) {
      // Legacy client-inserted row: verify ownership AND pending status before syncing authoritative price
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
        if (existingRow.notes && String(existingRow.notes).startsWith('{')) {
          try {
            mergedExtra = { ...JSON.parse(existingRow.notes), ...extraMetadata };
          } catch {
            // keep extraMetadata
          }
        }
        await dbClient
          .from('renew_requests')
          .update({
            amount: verified.finalPrice,
            notes: JSON.stringify(mergedExtra),
          })
          .eq('id', existingRow.id);
      }
    } else {
      // Authoritative server-side renewal insertion (always forced pending & verified price)
      const { data: insertedRenew, error: insertRenewErr } = await dbClient
        .from('renew_requests')
        .insert({
          user_id: uid,
          user_email: customerEmail,
          plan_name: effectivePlanDisplay,
          amount: verified.finalPrice,
          payment_method: String(data.receiptNumber || '').trim() || 'Bank Transfer',
          slip_url: String(data.slipUrl || data.slip_url || '').trim(),
          notes: JSON.stringify(extraMetadata),
          status: 'pending',
          created_at: new Date().toISOString(),
        })
        .select('id')
        .maybeSingle();

      if (insertRenewErr) {
        console.error('[RenewController] Failed to create renew_requests row:', insertRenewErr.message);
        res.status(500).json({ success: false, error: 'Failed to save renewal request. Please try again.' });
        return;
      }
      renewalRecordId = insertedRenew?.id || null;
    }

    const notificationData = {
      email: customerEmail,
      userEmail: customerEmail,
      planName: effectivePlanDisplay,
      durationMonths: verified.durationMonths,
      amount: verified.finalPrice,
      receiptNumber: String(data.receiptNumber || '').trim(),
      message: String(data.message || '').trim(),
      paymentDate: String(data.paymentDate || '').trim(),
      status: 'Pending'
    };

    // Create customer notification
    try {
      await createCustomerNotification({
        userId: uid,
        userEmail: customerEmail,
        title: 'Payment Submitted',
        message: `Your payment of LKR ${notificationData.amount} for "${notificationData.planName || 'VPN Package'}" (${verified.durationLabel}) has been submitted for verification.`,
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
      message: 'Renewal request verified and submitted successfully.',
      verifiedPrice: verified,
    });
  } catch (error: any) {
    console.error('[RenewController] Error processing renewal request:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to process renewal request' });
  }
};

export const approveRenewRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  const { requestId } = req.params;
  
  try {
    if (!requestId) {
      res.status(400).json({ error: 'Request ID is required' });
      return;
    }
    
    // Read the renew_requests record from Supabase using admin client
    const dbClient = supabaseAdmin || supabase;
    const { data, error: fetchErr } = await dbClient
      .from('renew_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle();
    
    if (fetchErr || !data) {
      res.status(404).json({ error: 'Renewal request not found' });
      return;
    }
    
    console.log("[RenewController] Loaded renew request for approval:", data);
    
    // Validate status must equal "pending"
    const currentStatus = String(data.status || '').toLowerCase();
    if (currentStatus !== 'pending') {
      res.status(400).json({ error: `Cannot approve request with status '${data.status}'. Status must be 'pending'.` });
      return;
    }
    
    const email = data.user_email || data.userEmail || data.email;
    if (!email) {
      res.status(400).json({ error: 'Client email is missing in the renewal request.' });
      return;
    }
    
    let durationMonths = Number(data.durationMonths || data.duration_months || data.duration || 1);
    const parsedNotes = data.notes ? (typeof data.notes === 'string' && data.notes.startsWith('{') ? JSON.parse(data.notes) : data.notes) : null;
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

    // Resolve corresponding vpn_accounts row by order_id / vpn_account_id / uuid / user
    const orderId = data.order_id || data.orderId || parsedNotes?.order_id || parsedNotes?.orderId;
    const specAccountId = data.vpn_account_id || parsedNotes?.vpn_account_id;
    const specUuid = data.uuid || parsedNotes?.uuid;

    let targetVpnAcc: any = null;

    if (orderId) {
      const { data: vAcc } = await supabase
        .from('vpn_accounts')
        .select('*')
        .eq('order_id', orderId)
        .maybeSingle();
      if (vAcc) targetVpnAcc = vAcc;
    }

    if (!targetVpnAcc && specAccountId) {
      const { data: vAcc } = await supabase
        .from('vpn_accounts')
        .select('*')
        .eq('id', specAccountId)
        .maybeSingle();
      if (vAcc) targetVpnAcc = vAcc;
    }

    if (!targetVpnAcc && specUuid) {
      const { data: vAcc } = await supabase
        .from('vpn_accounts')
        .select('*')
        .eq('uuid', specUuid)
        .maybeSingle();
      if (vAcc) targetVpnAcc = vAcc;
    }

    if (!targetVpnAcc && data.user_id) {
      const { data: vAcc } = await supabase
        .from('vpn_accounts')
        .select('*')
        .eq('user_id', data.user_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (vAcc) targetVpnAcc = vAcc;
    }

    if (!targetVpnAcc && email) {
      const { data: vAcc } = await supabase
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
      res.status(400).json({ error: 'Could not resolve target VPN account UUID for renewal request.' });
      return;
    }

    // 1. Fetch old expiry date
    let oldExpiryMs: number | null = null;
    if (data.old_expiry) {
      oldExpiryMs = new Date(data.old_expiry).getTime();
    } else if (parsedNotes?.old_expiry) {
      oldExpiryMs = new Date(parsedNotes.old_expiry).getTime();
    }

    if (!oldExpiryMs || isNaN(oldExpiryMs)) {
      try {
        oldExpiryMs = await xuiService.getClientExpiry(targetUuid);
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

    const oldExpiryIso = oldExpiryMs && !isNaN(oldExpiryMs) ? new Date(oldExpiryMs).toISOString() : new Date().toISOString();

    console.log(`[RenewController] Approving renewal request ${requestId} for ${email} (UUID: ${targetUuid}, ${durationMonths} month(s)). Old Expiry: ${oldExpiryIso}`);
    
    const planName = data.plan_name || data.planName || data.plan || parsedNotes?.plan_name || parsedNotes?.planName || '';

    // 2. Extend client expiry and reactivate (enable: true) in 3X-UI using UUID (preserving existing UUID & credentials and extending by durationMonths calendar months)
    const { new_expiryMs, newTotalBytes, verifiedEnable, inboundId } = await xuiService.updateClientExpiry(
      targetUuid,
      durationMonths,
      planName,
      oldExpiryMs
    );

    if (!verifiedEnable || !new_expiryMs || new_expiryMs <= Date.now()) {
      throw new Error(
        `3X-UI client reactivation verification failed for UUID ${targetUuid}: client remains disabled or expiry was not extended in the future.`
      );
    }

    const new_expiryIso = new Date(new_expiryMs).toISOString();

    console.log(
      `[RenewController] 3X-UI update & reactivation verified on inbound ${inboundId} (enable=true). New expiry time: ${new_expiryIso}. New total bytes: ${newTotalBytes}. Executing atomic database updates...`
    );
    
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

    // 3. Update renew_requests table (retaining original agreed amount and duration)
    const { data: updatedRow, error: updateErr } = await supabase
      .from('renew_requests')
      .update({
        status: 'approved',
        updated_at: nowIso,
        ...(updatedNotesObj ? { notes: JSON.stringify(updatedNotesObj) } : {}),
      })
      .eq('id', requestId)
      .select()
      .maybeSingle();

    if (updateErr) {
      console.error('[RenewController] Error updating renew_requests table:', updateErr);
      throw updateErr;
    }
    
    const dataLimitStr = newTotalBytes > 0 
      ? `${newTotalBytes / (1024 * 1024 * 1024)}GB` 
      : 'Unlimited';

    // 4. Update vpn_accounts
    try {
      let updatedSpecific = false;
      const accUpdatePayload = {
        expiry_date: new_expiryIso,
        expiry_time: new_expiryMs,
        data_limit: dataLimitStr,
        status: 'active',
        updated_at: nowIso
      };

      if (targetVpnAcc?.id) {
        console.log('[vpn_accounts.update payload]:', JSON.stringify(accUpdatePayload, null, 2));
        const { error: vErr } = await supabase
          .from('vpn_accounts')
          .update(accUpdatePayload)
          .eq('id', targetVpnAcc.id);
        if (!vErr) {
          updatedSpecific = true;
          console.log(`[RenewController] Successfully renewed vpn_account by ID: ${targetVpnAcc.id} with data limit: ${dataLimitStr}`);
        } else {
          console.warn(`[RenewController] Failed to renew vpn_account by ID: ${targetVpnAcc.id}`, vErr);
        }
      } else if (targetUuid) {
        console.log('[vpn_accounts.update payload]:', JSON.stringify(accUpdatePayload, null, 2));
        const { error: vErr } = await supabase
          .from('vpn_accounts')
          .update(accUpdatePayload)
          .eq('uuid', targetUuid);
        if (!vErr) {
          updatedSpecific = true;
          console.log(`[RenewController] Successfully renewed vpn_account by UUID: ${targetUuid} with data limit: ${dataLimitStr}`);
        } else {
          console.warn(`[RenewController] Failed to renew vpn_account by UUID: ${targetUuid}`, vErr);
        }
      }

      if (!updatedSpecific && targetUuid) {
        console.log(`[RenewController] Fallback: Renewing vpn_accounts by UUID: ${targetUuid} with data limit: ${dataLimitStr}`);
        console.log('[vpn_accounts.update payload]:', JSON.stringify(accUpdatePayload, null, 2));
        await supabase
          .from('vpn_accounts')
          .update(accUpdatePayload)
          .eq('uuid', targetUuid);
      }
    } catch (vErr) {
      console.warn('[RenewController] vpn_accounts update warning:', vErr);
    }

    // 5. Update vpn_configs (and orders if previously expired)
    try {
      if (targetUuid) {
        const { error: cErr } = await supabase
          .from('vpn_configs')
          .update({
            expiry_date: new_expiryIso,
            data_limit: dataLimitStr,
            enabled: true,
            status: 'active',
          })
          .eq('uuid', targetUuid);
        if (!cErr) {
          console.log(`[RenewController] Successfully renewed and re-enabled vpn_configs by UUID: ${targetUuid} with data limit: ${dataLimitStr}`);
        } else {
          console.warn(`[RenewController] Failed to renew vpn_configs by UUID: ${targetUuid}`, cErr);
        }

        await supabase
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
    
    // 6. Create customer notification informing them that their VPN has been renewed and reactivated
    try {
      console.log('[RenewController] Creating VPN Renewed & Reactivated notification');
      await createCustomerNotification({
        userId: data.user_id || data.userId || null,
        userEmail: email,
        title: 'VPN Renewed & Reactivated',
        message: `Your VPN renewal request for "${data.plan_name || data.planName || 'Plan'}" was approved and your VPN connection has been reactivated. Expiry extended to ${new Date(new_expiryMs).toLocaleDateString()}.`,
        type: 'vpn_renewed'
      });
    } catch (nErr: any) {
      console.error('[RenewController] CRITICAL: Customer notification creation error:', nErr.message || nErr);
    }

    // 7. Trigger Telegram approved notification
    sendRenewApprovedNotification({
      email: email,
      userEmail: email,
      planName: data.planName || data.plan_name || data.plan || 'FIREVPN Package',
      durationMonths: durationMonths,
      new_expiry: new_expiryIso,
      approved_at: new Date(nowIso),
    }).catch((telegramErr) => {
      console.error('[RenewController] Telegram approved notification error:', telegramErr?.message || telegramErr);
    });

    // Send Renewal Approved Email (non-blocking)
    if (email) {
      sendRenewalApprovedEmail({
        userEmail: email,
        customerName: data.user_name || parsedNotes?.user_name || undefined,
        renewalId: requestId,
        packageName: data.planName || data.plan_name || data.plan || 'FIREVPN Package',
        expiryDate: new_expiryIso,
        vlessUrl: targetVpnAcc?.vless_url || '',
        userId: data.user_id || data.userId
      }).catch(e => console.warn('[RenewController] Renewal approved email warning:', e));
    }
    
    // Trigger background synchronization asynchronously and non-blockingly
    xuiService.triggerBackgroundSyncIfNeeded('VPN Renewed', true);

    res.json({
      success: true,
      message: 'Renewal request approved, client subscription extended and VPN reactivated successfully.',
      data: updatedRow
    });
  } catch (error: any) {
    console.error(`[RenewController] Error approving renewal request ${requestId}:`, error?.message || error);
    res.status(500).json({
      error:
        error?.message ||
        'Failed to approve renewal and reactivate 3X-UI client. The request remains pending and can be retried safely.'
    });
  }
};

export const rejectRenewRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  const { requestId } = req.params;
  const reason = req.body?.reason || req.body?.reject_reason || req.body?.rejection_reason || 'Rejected by Admin';

  try {
    if (!requestId) {
      res.status(400).json({ error: 'Request ID is required' });
      return;
    }

    const dbClient = supabaseAdmin || supabase;
    const { data, error: fetchErr } = await dbClient
      .from('renew_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle();

    if (fetchErr || !data) {
      res.status(404).json({ error: 'Renewal request not found' });
      return;
    }

    const currentStatus = String(data.status || '').toLowerCase();
    if (currentStatus !== 'pending') {
      res.status(400).json({ error: `Cannot reject request with status '${data.status}'. Status must be 'pending'.` });
      return;
    }

    const email = data.user_email || data.userEmail || data.email;
    const nowIso = new Date().toISOString();

    const { data: updatedRow, error: updateErr } = await supabase
      .from('renew_requests')
      .update({
        status: 'rejected',
        updated_at: nowIso
      })
      .eq('id', requestId)
      .select()
      .maybeSingle();

    if (updateErr) {
      console.error('[RenewController] Error updating renew_requests on rejection:', updateErr);
      throw updateErr;
    }

    // Create customer notification
    try {
      console.log('[RenewController] Creating Payment Rejected notification for renewal rejection');
      await createCustomerNotification({
        userId: data.user_id || data.userId || null,
        userEmail: email,
        title: 'Payment Rejected',
        message: `Your VPN renewal payment/request for "${data.plan_name || data.planName || 'Plan'}" was rejected: ${reason}`,
        type: 'payment_rejected'
      });
    } catch (nErr: any) {
      console.error('[RenewController] CRITICAL: Customer notification creation error on reject:', nErr.message || nErr);
    }

    // Send Renewal Rejected Email (non-blocking)
    if (email) {
      sendRenewalRejectedEmail({
        userEmail: email,
        customerName: data.user_name || undefined,
        renewalId: requestId,
        packageName: data.plan_name || data.planName || 'VPN Plan',
        reason: reason,
        userId: data.user_id || data.userId
      }).catch(e => console.warn('[RenewController] Renewal rejected email warning:', e));
    }

    res.json({
      success: true,
      message: 'Renewal request rejected successfully.',
      data: updatedRow
    });
  } catch (error: any) {
    console.error(`[RenewController] Error rejecting renewal request ${requestId}:`, error.message);
    res.status(500).json({ error: error.message || 'Failed to reject renewal request' });
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
    const generatedOrderId = `ORD-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
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

