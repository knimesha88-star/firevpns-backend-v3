import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as adminService from '../services/adminService.js';
import * as xuiService from '../services/xuiService.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createCustomerNotification } from '../services/notificationService.js';
import {
  sendOrderRejectedNotification,
  syncOrderTelegramInlineMessage
} from '../services/telegramService.js';
import {
  getEmailSettings,
  invalidateEmailSettingsCache,
  sendPaymentRejectedEmail,
  sendTrialRejectedEmail,
  sendMaintenanceAnnouncementEmail,
  sendSingleTestEmail
} from '../services/emailService.js';

const isProd = () => process.env.NODE_ENV === 'production';
const safeServerError = (error: any, fallback: string): string =>
  isProd() ? fallback : (error?.message || fallback);

export const getStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const stats = await adminService.getDashboardStats();
    res.json({ success: true, stats });
  } catch (error: any) {
    console.error('[AdminController] getStats error:', error?.message || error);
    res.status(500).json({ error: safeServerError(error, 'Failed to load dashboard statistics.') });
  }
};

export const getUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await adminService.getAllUsers();
    res.json({ success: true, users });
  } catch (error: any) {
    console.error('[AdminController] getUsers error:', error?.message || error);
    res.status(500).json({ error: safeServerError(error, 'Failed to load users.') });
  }
};

export const executeOrderApproval = async (
  orderId: string,
  token?: string,
  options?: xuiService.ProvisionOrderClientOptions
): Promise<any> => {
  console.log(`[AdminController] Calling xuiService.provisionOrderClient for orderId: ${orderId}`);
  const result = await xuiService.provisionOrderClient(orderId, token, {
    ...options,
    provisional: false,
  });

  if (!result?.deduplicated && !options?.skipSideEffects) {
    syncOrderTelegramInlineMessage(orderId, 'APPROVED', {
      adminLabel: options?.adminLabel || 'Website Admin',
      uuid: result?.uuid
    }).catch((err) => {
      console.warn('[AdminController] Telegram inline message sync warning on approval:', err?.message || err);
    });
  }

  return result;
};

export const approveOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  console.log(`[AdminController] Entering approveOrder with orderId: ${req.params.orderId || req.body.orderId}`);
  try {
    const orderId = req.params.orderId || req.body.orderId;
    if (!orderId) {
      res.status(400).json({ error: 'Order ID is required' });
      return;
    }
    const authHeader = req.headers.authorization || (req.headers as any)?.Authorization;
    const token = authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;

    const result = await executeOrderApproval(orderId, token, {
      adminLabel: req.user?.email || 'Website Admin',
      signal: (req as any).timeoutSignal,
    });
    if (res.headersSent) return;
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[AdminController] Order approval provisioning error:', error?.message || error);
    if (res.headersSent) return;
    const status =
      error?.statusCode === 409
        ? 409
        : error?.statusCode === 404
        ? 404
        : error?.statusCode === 503
        ? 503
        : error?.statusCode === 504
        ? 504
        : error?.statusCode === 403
        ? 403
        : 400;
    const message =
      status === 409 || status === 404 || status === 503 || status === 504 || status === 403
        ? String(error?.message || 'Unable to approve order.')
        : safeServerError(error, error?.message || 'Provisioning template not found.');
    res.status(status).json({
      success: false,
      error: message,
      ...(error?.code ? { code: error.code } : {}),
    });
  }
};

export const verifyPayment = async (req: AuthRequest, res: Response): Promise<void> => {
  let durableOrderLockKey = '';
  let durableOrderLockOwnerId = '';
  let ownsDurableLock = false;
  let finalLockStatus: 'completed' | 'failed' = 'failed';
  let finalLockError: string | null = null;
  const dbClient = supabaseAdmin;

  try {
    const rawOrderId = String(req.params.orderId || req.body.orderId || '').trim();
    if (!rawOrderId) {
      res.status(400).json({ error: 'Order ID is required' });
      return;
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawOrderId);
    let existingOrder: any = null;
    if (isUuid) {
      const { data } = await dbClient
        .from('orders')
        .select('id, order_id, status, payment_status, provisioning_status, client_uuid')
        .eq('id', rawOrderId)
        .maybeSingle();
      existingOrder = data;
    }
    if (!existingOrder) {
      const { data } = await dbClient
        .from('orders')
        .select('id, order_id, status, payment_status, provisioning_status, client_uuid')
        .eq('order_id', rawOrderId)
        .maybeSingle();
      existingOrder = data;
    }

    if (!existingOrder) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }

    durableOrderLockKey = `order:${existingOrder.id}`;
    const lockRes = await xuiService.acquireDurableProvisioningOperationLock({
      dbClient,
      operationKey: durableOrderLockKey,
      operationType: 'verify_payment',
      targetId: String(existingOrder.id),
      clientUuid: existingOrder.client_uuid || null,
      requireDurableLock: true,
      allowUncertainRecovery: false,
      metadata: {
        orderId: existingOrder.order_id || existingOrder.id,
        adminLabel: req.user?.email || 'Website Admin',
      },
    });

    if (!lockRes.acquired) {
      const lockErr = xuiService.buildDurableLockFailureError(
        lockRes,
        `Order '${existingOrder.order_id || existingOrder.id}'`
      );
      if (!res.headersSent) {
        res.status(lockErr.statusCode).json({
          success: false,
          error: lockErr.message,
          code: lockErr.code,
        });
      }
      return;
    }

    durableOrderLockOwnerId = lockRes.lockOwnerId;
    ownsDurableLock = lockRes.tableAvailable;

    // Re-read fresh order state inside the durable lock
    const { data: freshOrder } = await dbClient
      .from('orders')
      .select('id, order_id, status, payment_status, provisioning_status, client_uuid')
      .eq('id', existingOrder.id)
      .maybeSingle();
    if (freshOrder) {
      existingOrder = freshOrder;
    }

    const statusLower = String(existingOrder.status || '').toLowerCase().trim();
    const paymentStatusLower = String(existingOrder.payment_status || '').toLowerCase().trim();
    const provStatusLower = String(existingOrder.provisioning_status || '').toLowerCase().trim();

    if (
      statusLower === 'rejected' ||
      statusLower === 'cancelled' ||
      paymentStatusLower === 'cancelled' ||
      paymentStatusLower === 'rejected' ||
      provStatusLower === 'revoked'
    ) {
      finalLockError = 'Order has already been rejected and cannot be marked Paid.';
      if (!res.headersSent) {
        res.status(409).json({ error: 'Cannot verify payment on a rejected or revoked order.' });
      }
      return;
    }

    xuiService.assertRequestNotTimedOutBeforeExternalMutation(
      (req as any).timeoutSignal,
      `payment verification for order ${existingOrder.order_id || existingOrder.id}`
    );

    if (ownsDurableLock) {
      const stillOwned = await xuiService.renewDurableProvisioningOperationLock({
        dbClient,
        operationKey: durableOrderLockKey,
        lockOwnerId: durableOrderLockOwnerId,
      });
      if (!stillOwned) {
        finalLockError = `Lost durable order lock '${durableOrderLockKey}' before payment verification update.`;
        if (!res.headersSent) {
          res.status(409).json({
            success: false,
            error: finalLockError,
            code: 'ORDER_LOCK_LOST',
          });
        }
        return;
      }
    }

    const nowIso = new Date().toISOString();
    const isProvisionalOrder = provStatusLower === 'provisional';
    const orderUpdatePayload: Record<string, any> = isProvisionalOrder
      ? {
          payment_status: 'Paid',
          status: 'completed',
          provisioning_status: 'completed',
          updated_at: nowIso,
        }
      : {
          payment_status: 'Paid',
          updated_at: nowIso,
        };

    let { error: updateErr } = await dbClient
      .from('orders')
      .update(orderUpdatePayload)
      .eq('id', existingOrder.id);

    if (updateErr && String(updateErr.message || '').includes('provisioning_status')) {
      const { provisioning_status: _omitted, ...fallbackPayload } = orderUpdatePayload;
      const retryRes = await dbClient.from('orders').update(fallbackPayload).eq('id', existingOrder.id);
      updateErr = retryRes.error;
    }

    if (updateErr) {
      finalLockError = updateErr.message || 'Failed to verify payment.';
      console.error('[AdminController] Error verifying payment in DB:', updateErr);
      if (!res.headersSent) {
        res.status(500).json({ error: safeServerError(updateErr, 'Failed to verify payment.') });
      }
      return;
    }

    if (isProvisionalOrder) {
      try {
        await dbClient
          .from('vpn_entitlement_grants')
          .update({
            status: 'verified',
            verified_at: nowIso,
            verified_by: req.user?.email || 'Website Admin',
            updated_at: nowIso,
          })
          .eq('order_id', existingOrder.id)
          .in('status', ['provisioning', 'provisional']);
      } catch {
        // Non-blocking if ledger table is not installed in legacy mode
      }
    }

    finalLockStatus = 'completed';
    if (!res.headersSent) {
      res.json({
        success: true,
        completedProvisional: isProvisionalOrder,
        status: isProvisionalOrder ? 'completed' : existingOrder.status,
        payment_status: 'Paid',
        provisioning_status: isProvisionalOrder ? 'completed' : existingOrder.provisioning_status,
        message: isProvisionalOrder
          ? 'Payment verified and provisional order completed successfully'
          : 'Payment verified successfully',
      });
    }
  } catch (error: any) {
    finalLockError = error?.message || String(error);
    console.error('[AdminController] Payment verification error:', error?.message || error);
    if (!res.headersSent) {
      const status = error?.statusCode === 504 ? 504 : error?.statusCode === 409 ? 409 : 500;
      res.status(status).json({
        success: false,
        error:
          status === 504 || status === 409
            ? String(error?.message || 'Unable to verify payment.')
            : safeServerError(error, 'Failed to verify payment.'),
        ...(error?.code ? { code: error.code } : {}),
      });
    }
  } finally {
    if (ownsDurableLock && durableOrderLockKey && durableOrderLockOwnerId) {
      await xuiService.finalizeDurableProvisioningOperationLock({
        dbClient,
        operationKey: durableOrderLockKey,
        lockOwnerId: durableOrderLockOwnerId,
        status: finalLockStatus,
        errorMessage: finalLockError,
      });
    }
  }
};

export const executeOrderRejection = async (
  orderId: string,
  reason = 'Rejected by Admin',
  options?: {
    adminLabel?: string;
    skipSeparateTelegramNotification?: boolean;
    skipSideEffects?: boolean;
    dbClient?: any;
    requestApiFn?: any;
    getInboundsFn?: any;
    signal?: AbortSignal;
  }
): Promise<{ order: any; message: string; revocationResult?: any; alreadyRejected?: boolean }> => {
  const dbClient = options?.dbClient || supabaseAdmin;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(orderId).trim());

  let order: any = null;
  if (isUuid) {
    const { data } = await dbClient.from('orders').select('*').eq('id', orderId).maybeSingle();
    order = data;
  }
  if (!order) {
    const { data: qOrder } = await dbClient.from('orders').select('*').eq('order_id', orderId).maybeSingle();
    order = qOrder;
  }

  if (!order) {
    const notFoundErr: any = new Error(`Order '${orderId}' not found.`);
    notFoundErr.statusCode = 404;
    throw notFoundErr;
  }

  const sanitizedReason =
    String(reason || 'Rejected by Admin')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim()
      .slice(0, 500) || 'Rejected by Admin';

  // Acquire durable order-level lock FIRST so rejection and approval/auto-provisioning/verify-payment
  // are strictly mutually exclusive across instances and processes.
  const durableOrderLockKey = `order:${order.id}`;
  const lockRes = await xuiService.acquireDurableProvisioningOperationLock({
    dbClient,
    operationKey: durableOrderLockKey,
    operationType: 'reject_order',
    targetId: String(order.id),
    clientUuid: order.client_uuid || null,
    requireDurableLock: true,
    allowUncertainRecovery: false,
    metadata: {
      orderId: order.order_id || order.id,
      adminLabel: options?.adminLabel || 'Website Admin',
      reason: sanitizedReason,
    },
  });

  if (!lockRes.acquired) {
    throw xuiService.buildDurableLockFailureError(
      lockRes,
      `Order '${order.order_id || order.id}'`
    );
  }

  const ownsDurableLock = lockRes.tableAvailable;
  const lockOwnerId = lockRes.lockOwnerId;
  let finalLockStatus: 'completed' | 'failed' | 'uncertain' = 'failed';
  let finalLockError: string | null = null;

  let revocationResult: any = null;
  let rejectPayload: Record<string, any> = {};
  let vpnWasRevoked = false;

  try {
    // Re-read fresh order state INSIDE the durable lock so we never act on a stale snapshot
    const { data: freshOrder } = await dbClient.from('orders').select('*').eq('id', order.id).maybeSingle();
    if (freshOrder) {
      order = freshOrder;
    }

    const statusLower = String(order.status || '').toLowerCase().trim();
    const paymentStatusLower = String(order.payment_status || '').toLowerCase().trim();
    const provStatusLower = String(order.provisioning_status || '').toLowerCase().trim();

    if (
      statusLower === 'completed' ||
      statusLower === 'active' ||
      statusLower === 'approved' ||
      paymentStatusLower === 'paid' ||
      paymentStatusLower === 'approved' ||
      paymentStatusLower === 'verified'
    ) {
      finalLockError = `Order '${order.order_id || order.id}' is already approved/paid and cannot be rejected.`;
      const conflictErr: any = new Error(finalLockError);
      conflictErr.statusCode = 409;
      conflictErr.code = 'ALREADY_PAID_OR_APPROVED';
      throw conflictErr;
    }

    // If order is already rejected and does NOT need revoke_failed retry, return idempotently without duplicate notifications
    if (statusLower === 'rejected' && provStatusLower !== 'revoke_failed') {
      finalLockStatus = 'completed';
      return {
        order,
        alreadyRejected: true,
        revocationResult: { revoked: provStatusLower === 'revoked', reason: 'already_rejected' },
        message: 'Order has already been rejected',
      };
    }

    // Requirement 3: Mandatory rejection safety
    // Before rejecting the order, check if it has a provisionally activated VPN entitlement in public.vpn_entitlement_grants
    // and safely disable + read-back verify it on 3X-UI while holding the durable order lock.
    // If 3X-UI revocation or read-back verification fails, revokeProvisionalOrderClient retains 'revoke_failed' and throws.
    revocationResult = await xuiService.revokeProvisionalOrderClient(order.id, sanitizedReason, {
      adminLabel: options?.adminLabel || 'Website Admin',
      dbClient,
      requestApiFn: options?.requestApiFn,
      getInboundsFn: options?.getInboundsFn,
      heldOrderLockOwnerId: ownsDurableLock ? lockOwnerId : undefined,
      heldOrderLockTableAvailable: ownsDurableLock,
      signal: options?.signal,
    });

    vpnWasRevoked = Boolean(revocationResult?.revoked);

    // If no external revocation was performed, stop cleanly if HTTP deadline already elapsed
    if (!vpnWasRevoked) {
      xuiService.assertRequestNotTimedOutBeforeExternalMutation(
        options?.signal,
        `order rejection for order ${order.order_id || order.id}`
      );
    }

    // Post-write lock fencing: verify durable order lock is STILL owned by this worker before mutating orders
    if (ownsDurableLock) {
      const orderLockStillOwned = await xuiService.renewDurableProvisioningOperationLock({
        dbClient,
        operationKey: durableOrderLockKey,
        lockOwnerId,
      });
      if (!orderLockStillOwned) {
        const fenceErr: any = new Error(
          vpnWasRevoked
            ? `Lost durable order lock '${durableOrderLockKey}' after provisional VPN revocation; refusing stale order rejection DB update. Manual reconciliation required.`
            : `Lost durable order lock '${durableOrderLockKey}' before rejecting order in DB; aborting stale write.`
        );
        fenceErr.statusCode = 409;
        fenceErr.code = vpnWasRevoked ? 'RECONCILIATION_REQUIRED' : 'ORDER_LOCK_LOST';
        fenceErr.beforeExternalWrite = !vpnWasRevoked;
        fenceErr.xuiUncertain = vpnWasRevoked;
        fenceErr.markLockUncertain = vpnWasRevoked;
        throw fenceErr;
      }
    }

    // Update order status to rejected, payment_status to Cancelled, and persist sanitized reject_reason
    // atomically inside the durable lock (orders.reject_reason verified in deployed schema).
    const nowIso = new Date().toISOString();
    rejectPayload = {
      status: 'rejected',
      payment_status: 'Cancelled',
      reject_reason: sanitizedReason,
      ...(vpnWasRevoked ? { provisioning_status: 'revoked' } : {}),
      updated_at: nowIso,
    };

    const { error: updateErr } = await dbClient.from('orders').update(rejectPayload).eq('id', order.id);
    if (updateErr) {
      finalLockError = `Failed to update order: ${updateErr.message}`;
      console.error('[AdminController] Error rejecting order in DB:', updateErr);
      const dbErr: any = new Error(finalLockError);
      if (vpnWasRevoked) {
        dbErr.statusCode = 409;
        dbErr.code = 'RECONCILIATION_REQUIRED';
        dbErr.xuiUncertain = true;
        dbErr.markLockUncertain = true;
      }
      throw dbErr;
    }

    finalLockStatus = 'completed';
  } catch (err: any) {
    finalLockStatus = err?.markLockUncertain || err?.xuiUncertain ? 'uncertain' : 'failed';
    finalLockError = err?.message || String(err);
    throw err;
  } finally {
    if (ownsDurableLock) {
      await xuiService.finalizeDurableProvisioningOperationLock({
        dbClient,
        operationKey: durableOrderLockKey,
        lockOwnerId,
        status: finalLockStatus,
        clientUuid: revocationResult?.clientUuid || order.client_uuid || null,
        errorMessage: finalLockError,
      });
    }
  }

  // Side-effect notifications run AFTER durable lock release and durable DB state commit
  if (!options?.skipSideEffects) {
    // Create customer notification
    try {
      const isTrial = !!(
        order.is_trial ||
        String(order.order_id || '').startsWith('TRIAL-') ||
        String(order.package_name || '').toLowerCase().includes('trial')
      );

      if (isTrial) {
        console.log('[AdminController] Sending Trial Rejected notification');
        await createCustomerNotification({
          userId: order.customer_id || null,
          userEmail: order.email,
          title: 'Trial Rejected',
          message: `Your free trial request was rejected: ${reason}`,
          type: 'trial_rejected',
          orderId: order.id
        });
      } else {
        console.log('[AdminController] Sending Order Rejected and Payment Rejected notifications');
        await createCustomerNotification({
          userId: order.customer_id || null,
          userEmail: order.email,
          title: 'Order Rejected',
          message: vpnWasRevoked
            ? `Your order #${order.order_id || order.id} was rejected (${reason}) and provisional VPN access has been deactivated.`
            : `Your order #${order.order_id || order.id} was rejected: ${reason}`,
          type: 'order_rejected',
          orderId: order.id
        });
        await createCustomerNotification({
          userId: order.customer_id || null,
          userEmail: order.email,
          title: 'Payment Rejected',
          message: vpnWasRevoked
            ? `Your payment was rejected (${reason}). Your provisional VPN connection has been deactivated.`
            : `Your payment/order was rejected: ${reason}`,
          type: 'payment_rejected',
          orderId: order.id
        });
      }

      // Send email notification non-blockingly
      if (order.email) {
        const canonicalOrderId = order.order_id || order.id;
        if (isTrial) {
          sendTrialRejectedEmail({
            userEmail: order.email,
            trialId: canonicalOrderId,
            orderId: canonicalOrderId,
            packageName: order.package_name || 'Free Trial',
            reason: reason,
            userId: order.customer_id
          }).catch(e => console.warn('[AdminController] Trial rejected email warning:', e));
        } else {
          sendPaymentRejectedEmail({
            userEmail: order.email,
            orderId: canonicalOrderId,
            packageName: order.package_name || 'VPN Plan',
            reason: reason,
            vpnRevoked: vpnWasRevoked,
            userId: order.customer_id
          }).catch(e => console.warn('[AdminController] Payment rejected email warning:', e));
        }
      }
    } catch (notifErr: any) {
      console.error('[AdminController] CRITICAL: Customer notification creation failed during rejection:', notifErr.message || notifErr);
    }

    // Update inline Telegram message if one exists for this order
    syncOrderTelegramInlineMessage(order.order_id || order.id, 'REJECTED', {
      adminLabel: options?.adminLabel || 'Website Admin',
      reason
    }).catch((err) => {
      console.warn('[AdminController] Telegram inline message sync warning on rejection:', err?.message || err);
    });

    // Send Telegram rejection summary notification unless handled by inline callback edit
    if (!options?.skipSeparateTelegramNotification) {
      try {
        await sendOrderRejectedNotification({
          orderId: order.order_id || order.id,
          customerEmail: order.email || 'N/A',
          reason: vpnWasRevoked ? `${reason} (Provisional VPN Disabled)` : reason
        });
      } catch (tgErr) {
        console.warn('[AdminController] Telegram rejection notification warning:', tgErr);
      }
    }
  }

  return {
    order: { ...order, ...rejectPayload },
    revocationResult,
    message: vpnWasRevoked
      ? 'Order rejected and provisional VPN client disabled on 3X-UI'
      : 'Order rejected successfully'
  };
};

export const rejectOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orderId = req.params.orderId || req.body.orderId;
    const reason = req.body.reason || req.body.reject_reason || 'Rejected by Admin';

    if (!orderId) {
      res.status(400).json({ error: 'Order ID is required' });
      return;
    }

    const result = await executeOrderRejection(orderId, reason, {
      adminLabel: req.user?.email || 'Website Admin',
      signal: (req as any).timeoutSignal,
    });

    if (res.headersSent) return;
    res.json({
      success: true,
      message: result.message || 'Order rejected successfully',
      order: result.order,
    });
  } catch (error: any) {
    console.error('[AdminController] Order rejection error:', error?.message || error);
    if (res.headersSent) return;
    const status =
      error?.statusCode === 404
        ? 404
        : error?.statusCode === 409
        ? 409
        : error?.statusCode === 503
        ? 503
        : error?.statusCode === 504
        ? 504
        : error?.statusCode === 403
        ? 403
        : 500;
    res.status(status).json({
      success: false,
      error:
        status === 404 || status === 409 || status === 503 || status === 504 || status === 403
          ? (error?.message || 'Unable to reject order.')
          : safeServerError(error, 'Failed to reject order.'),
      ...(error?.code ? { code: error.code } : {}),
    });
  }
};

export const publishAnnouncementNotification = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { title, message, type, sendEmail } = req.body;
    if (!title || !message) {
      res.status(400).json({ error: 'Title and message are required' });
      return;
    }

    console.log(`[AdminController] Publishing announcement: "${title}" (Type: ${type || 'announcement'})`);

    // 1. Fetch all profiles
    const { data: profiles, error: fetchErr } = await supabaseAdmin.from('profiles').select('id, email');
    if (fetchErr) {
      console.error('[AdminController] Error fetching profiles for announcement:', fetchErr);
      res.status(500).json({ error: 'Failed to fetch profiles' });
      return;
    }

    if (!profiles || profiles.length === 0) {
      res.json({ success: true, count: 0 });
      return;
    }

    // 2. Insert notifications for each user
    const insertPromises = profiles.map((p) => {
      return createCustomerNotification({
        userId: p.id,
        userEmail: p.email || '',
        title,
        message,
        type: type || 'announcement'
      });
    });

    await Promise.all(insertPromises);

    // 3. Send email to users if sendEmail is true or announcement type is maintenance
    if (sendEmail) {
      profiles.forEach(p => {
        if (p.email) {
          sendMaintenanceAnnouncementEmail({
            userEmail: p.email,
            announcementTitle: title,
            announcementBody: message,
            userId: p.id
          }).catch(e => console.warn('[AdminController] Announcement email warning:', e));
        }
      });
    }

    res.json({ success: true, count: profiles.length });
  } catch (error: any) {
    console.error('[AdminController] Announcement notification error:', error?.message || error);
    res.status(500).json({ error: safeServerError(error, 'Failed to send announcement notifications.') });
  }
};

export const getEmailSettingsHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settings = await getEmailSettings();
    res.json({
      success: true,
      settings: {
        ...settings,
        apiKey: '' // Never expose secret API key to browser
      }
    });
  } catch (error: any) {
    console.error('[AdminController] getEmailSettings error:', error?.message || error);
    res.status(500).json({ error: safeServerError(error, 'Failed to load email settings.') });
  }
};

export const saveEmailSettingsHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      res.status(400).json({ error: 'Settings object is required' });
      return;
    }

    const { data: existingRow } = await supabaseAdmin
      .from('settings')
      .select('data')
      .eq('id', 'email')
      .maybeSingle();

    const sanitizedSettings = {
      ...settings,
      apiKey: settings.apiKey && String(settings.apiKey).trim()
        ? String(settings.apiKey).trim()
        : (existingRow?.data?.apiKey || '')
    };

    const { error: upsertErr } = await supabaseAdmin.from('settings').upsert({
      id: 'email',
      data: sanitizedSettings,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });

    if (upsertErr) {
      console.error('[AdminController] Error saving email settings:', upsertErr);
      res.status(500).json({ error: safeServerError(upsertErr, 'Failed to save email settings.') });
      return;
    }

    invalidateEmailSettingsCache();

    res.json({ success: true, message: 'Email settings saved successfully' });
  } catch (error: any) {
    console.error('[AdminController] saveEmailSettings error:', error?.message || error);
    res.status(500).json({ error: safeServerError(error, 'Failed to save email settings.') });
  }
};

export const getEmailLogsHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('email_notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      if (error.code === 'PGRST205') {
        res.json({ success: true, logs: [] });
        return;
      }
      console.error('[AdminController] getEmailLogs error:', error);
      res.status(500).json({ error: safeServerError(error, 'Failed to load email logs.') });
      return;
    }

    res.json({ success: true, logs: data || [] });
  } catch (error: any) {
    console.error('[AdminController] getEmailLogs exception:', error?.message || error);
    res.status(500).json({ error: safeServerError(error, 'Failed to load email logs.') });
  }
};

export const sendTestEmailHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { toEmail } = req.body;
    const recipient = String(toEmail || process.env.TEST_EMAIL_RECIPIENT || req.user?.email || '').trim();

    if (!recipient || !recipient.includes('@')) {
      res.status(400).json({ error: 'A valid single test recipient email address is required' });
      return;
    }

    const result = await sendSingleTestEmail(recipient, req.user?.uid);

    if (!result.success || !result.accepted) {
      res.status(400).json({
        success: false,
        accepted: false,
        from: result.from,
        to: recipient,
        statusCode: result.statusCode,
        error: result.error || 'Failed to send test email via Resend'
      });
      return;
    }

    res.json({
      success: true,
      accepted: true,
      messageId: result.messageId,
      from: result.from,
      to: recipient,
      message: `Test email accepted by Resend for ${recipient} (ID: ${result.messageId})`
    });
  } catch (error: any) {
    console.error('[AdminController] sendTestEmail error:', error?.message || error);
    res.status(500).json({ error: safeServerError(error, 'Failed to send test email.') });
  }
};



