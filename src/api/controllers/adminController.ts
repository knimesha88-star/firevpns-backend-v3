import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as adminService from '../services/adminService.js';
import * as xuiService from '../services/xuiService.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createCustomerNotification } from '../services/notificationService.js';
import { sendOrderRejectedNotification } from '../services/telegramService.js';
import {
  getEmailSettings,
  sendPaymentRejectedEmail,
  sendTrialRejectedEmail,
  sendMaintenanceAnnouncementEmail,
  sendEmail
} from '../services/emailService.js';

export const getStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const stats = await adminService.getDashboardStats();
    res.json({ success: true, stats });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await adminService.getAllUsers();
    res.json({ success: true, users });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
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
    
    console.log(`[AdminController] Calling xuiService.provisionOrderClient for orderId: ${orderId}`);
    const result = await xuiService.provisionOrderClient(orderId, token);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[AdminController] Order approval provisioning error:', error.message);
    res.status(400).json({ error: error.message || 'Provisioning template not found.' });
  }
};

export const verifyPayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orderId = req.params.orderId || req.body.orderId;
    if (!orderId) {
      res.status(400).json({ error: 'Order ID is required' });
      return;
    }

    const { error: updateErr } = await supabaseAdmin
      .from('orders')
      .update({
        payment_status: 'Paid',
        updated_at: new Date().toISOString()
      })
      .eq('id', orderId);

    if (updateErr) {
      console.error('[AdminController] Error verifying payment in DB:', updateErr);
      res.status(500).json({ error: `Failed to update order: ${updateErr.message}` });
      return;
    }

    res.json({ success: true, message: 'Payment verified successfully' });
  } catch (error: any) {
    console.error('[AdminController] Payment verification error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to verify payment.' });
  }
};

export const rejectOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orderId = req.params.orderId || req.body.orderId;
    const reason = req.body.reason || req.body.reject_reason || 'Rejected by Admin';

    if (!orderId) {
      res.status(400).json({ error: 'Order ID is required' });
      return;
    }

    // 1. Fetch order from Supabase using service role client
    let { data: order, error: fetchErr } = await supabaseAdmin.from('orders').select('*').eq('id', orderId).maybeSingle();
    if (!order) {
      const { data: qOrder } = await supabaseAdmin.from('orders').select('*').eq('order_id', orderId).maybeSingle();
      order = qOrder;
    }

    if (!order) {
      res.status(404).json({ error: `Order '${orderId}' not found.` });
      return;
    }

    // 2. Update order status to rejected and payment_status to Cancelled
    const rejectPayload = {
      status: 'rejected',
      payment_status: 'Cancelled',
      updated_at: new Date().toISOString()
    };

    const { error: updateErr } = await supabaseAdmin.from('orders').update(rejectPayload).eq('id', order.id);
    if (updateErr) {
      console.error('[AdminController] Error rejecting order in DB:', updateErr);
      res.status(500).json({ error: `Failed to update order: ${updateErr.message}` });
      return;
    }

    // 3. Create customer notification
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
        if (isTrial) {
          sendTrialRejectedEmail({
            userEmail: order.email,
            orderId: order.id,
            packageName: order.package_name || 'Free Trial',
            reason: reason,
            userId: order.customer_id
          }).catch(e => console.warn('[AdminController] Trial rejected email warning:', e));
        } else {
          sendPaymentRejectedEmail({
            userEmail: order.email,
            orderId: order.order_id || order.id,
            packageName: order.package_name || 'VPN Plan',
            reason: reason,
            userId: order.customer_id
          }).catch(e => console.warn('[AdminController] Payment rejected email warning:', e));
        }
      }
    } catch (notifErr: any) {
      console.error('[AdminController] CRITICAL: Customer notification creation failed during rejection:', notifErr.message || notifErr);
    }

    // 4. Send Telegram notification
    try {
      await sendOrderRejectedNotification({
        customerEmail: order.email || 'N/A',
        reason: reason
      });
    } catch (tgErr) {
      console.warn('[AdminController] Telegram rejection notification warning:', tgErr);
    }

    res.json({ success: true, message: 'Order rejected successfully' });
  } catch (error: any) {
    console.error('[AdminController] Order rejection error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to reject order.' });
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
    console.error('[AdminController] Announcement notification error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to send announcement notifications.' });
  }
};

export const getEmailSettingsHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settings = await getEmailSettings();
    res.json({ success: true, settings });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const saveEmailSettingsHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { settings } = req.body;
    if (!settings) {
      res.status(400).json({ error: 'Settings object is required' });
      return;
    }

    await supabaseAdmin.from('settings').upsert({
      id: 'email',
      data: settings,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });

    res.json({ success: true, message: 'Email settings saved successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ success: true, logs: data || [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const sendTestEmailHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { toEmail } = req.body;
    const recipient = toEmail || req.user?.email;

    if (!recipient) {
      res.status(400).json({ error: 'Target email address is required' });
      return;
    }

    const result = await sendEmail({
      to: recipient,
      subject: '🔥 FIREVPNs Email System Test',
      html: `
        <h1 style="color: #38bdf8;">FIREVPNs Email Notification System</h1>
        <p>This is a test email sent from your FIREVPNs Admin Panel.</p>
        <p>If you are receiving this message, your Resend API configuration is <strong>100% active and working!</strong></p>
      `,
      eventType: 'test_email',
      referenceId: `test_${Date.now()}`,
      userId: req.user?.uid
    });

    if (!result.success) {
      res.status(400).json({ error: result.error || 'Failed to send test email' });
      return;
    }

    res.json({ success: true, message: `Test email sent successfully to ${recipient}` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};


