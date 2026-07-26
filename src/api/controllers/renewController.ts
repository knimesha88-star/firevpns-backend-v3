import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as xuiService from '../services/xuiService.js';
import { supabase } from '../../lib/supabase.js';
import { sendRenewNotification, sendRenewApprovedNotification, sendNewOrderNotification, sendOrderApprovedNotification, sendOrderRejectedNotification } from '../services/telegramService.js';
import { createCustomerNotification } from '../services/notificationService.js';

export const createRenewRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = req.body || {};
    const customerEmail = data.email || data.userEmail || req.user?.email || '';

    const notificationData = {
      email: customerEmail,
      userEmail: customerEmail,
      planName: data.planName || data.plan || '',
      durationMonths: data.durationMonths || data.duration || 1,
      amount: data.amount ?? 0,
      receiptNumber: data.receiptNumber || '',
      message: data.message || '',
      paymentDate: data.paymentDate || '',
      status: 'Pending'
    };

    // Create customer notification
    try {
      console.log('[RenewController] Creating Payment Submitted notification for renewal request');
      await createCustomerNotification({
        userId: req.user?.uid || data.userId || null,
        userEmail: customerEmail,
        title: 'Payment Submitted',
        message: `Your payment of LKR ${notificationData.amount} for "${notificationData.planName || 'VPN Package'}" has been submitted for verification.`,
        type: 'payment_submitted'
      });
    } catch (notifErr: any) {
      console.error('[RenewController] CRITICAL: Error creating Payment Submitted notification in createRenewRequest:', notifErr.message || notifErr);
    }

    // Send Telegram Notification safely without crashing or rejecting request
    sendRenewNotification(notificationData).catch((err) => {
      console.error('[RenewController] Telegram notification error:', err?.message || err);
    });

    res.json({
      success: true,
      message: 'Renewal request notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[RenewController] Error processing renewal notification request:', error.message);
    res.status(500).json({ error: error.message });
  }
};

export const approveRenewRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  const { requestId } = req.params;
  
  try {
    if (!requestId) {
      res.status(400).json({ error: 'Request ID is required' });
      return;
    }
    
    // Read the renew_requests record from Supabase
    const { data, error: fetchErr } = await supabase
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
    const parsedNotes = data.notes ? (typeof data.notes === 'string' ? JSON.parse(data.notes) : data.notes) : null;
    if (parsedNotes) {
      if (parsedNotes.durationMonths) {
        durationMonths = Number(parsedNotes.durationMonths);
      } else if (parsedNotes.duration) {
        durationMonths = Number(parsedNotes.duration);
      }
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

    if (!targetVpnAcc && (data.user_id || email)) {
      const { data: vAcc } = await supabase
        .from('vpn_accounts')
        .select('*')
        .or(`email.eq.${email},user_id.eq.${data.user_id || 'N/A'}`)
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
    
    // 2. Extend client expiry in 3X-UI using UUID
    const new_expiryMs = await xuiService.updateClientExpiry(targetUuid, durationMonths);
    const new_expiryIso = new Date(new_expiryMs).toISOString();

    console.log(`[RenewController] 3X-UI update successful. New expiry time: ${new_expiryIso}. Executing atomic database updates...`);
    
    const nowIso = new Date().toISOString();
    const adminEmail = req.user?.email || req.user?.uid || 'Admin';

    // 3. Update renew_requests table
    const { data: updatedRow, error: updateErr } = await supabase
      .from('renew_requests')
      .update({
        status: 'approved',
        updated_at: nowIso,
      })
      .eq('id', requestId)
      .select()
      .maybeSingle();

    if (updateErr) {
      console.error('[RenewController] Error updating renew_requests table:', updateErr);
      throw updateErr;
    }
    
    // 4. Update vpn_accounts
    try {
      let updatedSpecific = false;

      if (targetVpnAcc?.id) {
        const { error: vErr } = await supabase
          .from('vpn_accounts')
          .update({
            expiry_date: new_expiryIso,
            expiry_time: new_expiryMs,
            updated_at: nowIso
          })
          .eq('id', targetVpnAcc.id);
        if (!vErr) {
          updatedSpecific = true;
          console.log(`[RenewController] Successfully renewed vpn_account by ID: ${targetVpnAcc.id}`);
        } else {
          console.warn(`[RenewController] Failed to renew vpn_account by ID: ${targetVpnAcc.id}`, vErr);
        }
      } else if (targetUuid) {
        const { error: vErr } = await supabase
          .from('vpn_accounts')
          .update({
            expiry_date: new_expiryIso,
            expiry_time: new_expiryMs,
            updated_at: nowIso
          })
          .eq('uuid', targetUuid);
        if (!vErr) {
          updatedSpecific = true;
          console.log(`[RenewController] Successfully renewed vpn_account by UUID: ${targetUuid}`);
        } else {
          console.warn(`[RenewController] Failed to renew vpn_account by UUID: ${targetUuid}`, vErr);
        }
      }

      if (!updatedSpecific && targetUuid) {
        console.log(`[RenewController] Fallback: Renewing vpn_accounts by UUID: ${targetUuid}`);
        await supabase
          .from('vpn_accounts')
          .update({
            expiry_date: new_expiryIso,
            expiry_time: new_expiryMs,
            updated_at: nowIso
          })
          .eq('uuid', targetUuid);
      }
    } catch (vErr) {
      console.warn('[RenewController] vpn_accounts update warning:', vErr);
    }

    // 5. Update vpn_configs
    try {
      if (targetUuid) {
        const { error: cErr } = await supabase
          .from('vpn_configs')
          .update({
            expiry_date: new_expiryIso,
          })
          .eq('uuid', targetUuid);
        if (!cErr) {
          console.log(`[RenewController] Successfully renewed vpn_configs by UUID: ${targetUuid}`);
        } else {
          console.warn(`[RenewController] Failed to renew vpn_configs by UUID: ${targetUuid}`, cErr);
        }
      }
    } catch (cErr) {
      console.warn('[RenewController] vpn_configs update warning:', cErr);
    }
    
    // 6. Create customer notification
    try {
      console.log('[RenewController] Creating VPN Renewed notification');
      await createCustomerNotification({
        userId: data.user_id || data.userId || null,
        userEmail: email,
        title: 'VPN Renewed',
        message: `Your VPN renewal request for "${data.plan_name || data.planName || 'Plan'}" was approved successfully. Expiry extended to ${new Date(new_expiryMs).toLocaleDateString()}.`,
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
    
    res.json({
      success: true,
      message: 'Renewal request approved and client subscription extended successfully.',
      data: updatedRow
    });
  } catch (error: any) {
    console.error(`[RenewController] Error approving renewal request ${requestId}:`, error.message);
    res.status(500).json({ error: error.message || 'Failed to approve renewal request' });
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

    const { data, error: fetchErr } = await supabase
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

export const createOrderNotification = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = req.body || {};
    
    const notificationData = {
      orderId: data.orderId || 'N/A',
      email: data.email || req.user?.email || 'N/A',
      plan: data.plan || 'N/A',
      server: data.server || 'N/A',
      duration: data.duration || 'N/A',
      packageType: data.packageType || 'N/A',
      amount: data.amount !== undefined && data.amount !== null ? data.amount : '0',
      transactionRef: data.transactionRef || 'N/A',
      paymentDate: data.paymentDate || 'N/A',
      notes: data.notes || '',
    };

    // Create customer notifications
    try {
      console.log('[RenewController] Creating Order Placed and Payment Submitted notifications for order');
      await createCustomerNotification({
        userId: req.user?.uid || data.userId || null,
        userEmail: notificationData.email,
        title: 'Order Placed',
        message: `Your order #${notificationData.orderId} for "${notificationData.plan}" has been placed successfully.`,
        type: 'order_placed',
        orderId: notificationData.orderId
      });
      await createCustomerNotification({
        userId: req.user?.uid || data.userId || null,
        userEmail: notificationData.email,
        title: 'Payment Submitted',
        message: `Your payment of LKR ${notificationData.amount} for "${notificationData.plan}" has been submitted for verification.`,
        type: 'payment_submitted',
        orderId: notificationData.orderId
      });
    } catch (notifErr: any) {
      console.error('[RenewController] CRITICAL: Error creating Order Placed/Payment Submitted notifications in createOrderNotification:', notifErr.message || notifErr);
    }

    sendNewOrderNotification(notificationData).catch((err) => {
      console.error('[RenewController] Telegram new order notification error:', err?.message || err);
    });

    res.json({
      success: true,
      message: 'New order Telegram notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[RenewController] Error processing order notification:', error.message);
    res.status(500).json({ error: error.message });
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
