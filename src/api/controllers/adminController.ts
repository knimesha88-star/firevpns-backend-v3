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
  options?: { adminLabel?: string }
): Promise<any> => {
  console.log(`[AdminController] Calling xuiService.provisionOrderClient for orderId: ${orderId}`);
  const result = await xuiService.provisionOrderClient(orderId, token);

  syncOrderTelegramInlineMessage(orderId, 'APPROVED', {
    adminLabel: options?.adminLabel || 'Website Admin',
    uuid: result?.uuid
  }).catch((err) => {
    console.warn('[AdminController] Telegram inline message sync warning on approval:', err?.message || err);
  });

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
      adminLabel: req.user?.email || 'Website Admin'
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[AdminController] Order approval provisioning error:', error.message);
    res.status(400).json({ error: error.message || 'Provisioning template not found.' });
  }
};

export const verifyPayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawOrderId = String(req.params.orderId || req.body.orderId || '').trim();
    if (!rawOrderId) {
      res.status(400).json({ error: 'Order ID is required' });
      return;
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawOrderId);
    let existingOrder: any = null;
    if (isUuid) {
      const { data } = await supabaseAdmin.from('orders').select('id, status, payment_status').eq('id', rawOrderId).maybeSingle();
      existingOrder = data;
    }
    if (!existingOrder) {
      const { data } = await supabaseAdmin.from('orders').select('id, status, payment_status').eq('order_id', rawOrderId).maybeSingle();
      existingOrder = data;
    }

    if (!existingOrder) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }

    const { error: updateErr } = await supabaseAdmin
      .from('orders')
      .update({
        payment_status: 'Paid',
        updated_at: new Date().toISOString()
      })
      .eq('id', existingOrder.id);

    if (updateErr) {
      console.error('[AdminController] Error verifying payment in DB:', updateErr);
      res.status(500).json({ error: safeServerError(updateErr, 'Failed to verify payment.') });
      return;
    }

    res.json({ success: true, message: 'Payment verified successfully' });
  } catch (error: any) {
    console.error('[AdminController] Payment verification error:', error?.message || error);
    res.status(500).json({ error: safeServerError(error, 'Failed to verify payment.') });
  }
};

export const executeOrderRejection = async (
  orderId: string,
  reason = 'Rejected by Admin',
  options?: { adminLabel?: string; skipSeparateTelegramNotification?: boolean }
): Promise<{ order: any; message: string }> => {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(orderId).trim());

  let order: any = null;
  if (isUuid) {
    const { data } = await supabaseAdmin.from('orders').select('*').eq('id', orderId).maybeSingle();
    order = data;
  }
  if (!order) {
    const { data: qOrder } = await supabaseAdmin.from('orders').select('*').eq('order_id', orderId).maybeSingle();
    order = qOrder;
  }

  if (!order) {
    const notFoundErr: any = new Error(`Order '${orderId}' not found.`);
    notFoundErr.statusCode = 404;
    throw notFoundErr;
  }

  // Update order status to rejected and payment_status to Cancelled
  const rejectPayload = {
    status: 'rejected',
    payment_status: 'Cancelled',
    updated_at: new Date().toISOString()
  };

  const { error: updateErr } = await supabaseAdmin.from('orders').update(rejectPayload).eq('id', order.id);
  if (updateErr) {
    console.error('[AdminController] Error rejecting order in DB:', updateErr);
    throw new Error(`Failed to update order: ${updateErr.message}`);
  }

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
        message: `Your order #${order.order_id || order.id} was rejected: ${reason}`,
        type: 'order_rejected',
        orderId: order.id
      });
      await createCustomerNotification({
        userId: order.customer_id || null,
        userEmail: order.email,
        title: 'Payment Rejected',
        message: `Your payment/order was rejected: ${reason}`,
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
        customerEmail: order.email || 'N/A',
        reason: reason
      });
    } catch (tgErr) {
      console.warn('[AdminController] Telegram rejection notification warning:', tgErr);
    }
  }

  return { order, message: 'Order rejected successfully' };
};

export const rejectOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orderId = req.params.orderId || req.body.orderId;
    const reason = req.body.reason || req.body.reject_reason || 'Rejected by Admin';

    if (!orderId) {
      res.status(400).json({ error: 'Order ID is required' });
      return;
    }

    await executeOrderRejection(orderId, reason, {
      adminLabel: req.user?.email || 'Website Admin'
    });

    res.json({ success: true, message: 'Order rejected successfully' });
  } catch (error: any) {
    console.error('[AdminController] Order rejection error:', error?.message || error);
    const status = error?.statusCode === 404 ? 404 : 500;
    res.status(status).json({
      error: status === 404 ? (error?.message || 'Order not found.') : safeServerError(error, 'Failed to reject order.')
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



