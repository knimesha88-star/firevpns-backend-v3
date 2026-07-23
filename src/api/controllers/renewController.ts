import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as xuiService from '../services/xuiService.js';
import { supabase } from '../../lib/supabase.js';
import { sendRenewNotification, sendRenewApprovedNotification, sendNewOrderNotification, sendOrderApprovedNotification, sendOrderRejectedNotification } from '../services/telegramService.js';

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
    
    // Read the renewRequests/renew_requests record from Supabase
    let { data, error: fetchErr } = await supabase
      .from('renew_requests')
      .select('*')
      .eq('id', requestId)
      .single();
    
    if (fetchErr || !data) {
      const fallback = await supabase
        .from('renewRequests')
        .select('*')
        .eq('id', requestId)
        .single();
      data = fallback.data;
      fetchErr = fallback.error;
    }
    
    if (fetchErr || !data) {
      res.status(404).json({ error: 'Renewal request not found' });
      return;
    }
    
    console.log("Renew request loaded:", data);
    
    // Validate status must equal "pending" (case-insensitive)
    const currentStatus = data.status?.toLowerCase();
    if (currentStatus !== 'pending') {
      res.status(400).json({ error: `Cannot approve request with status '${data.status}'. Status must be 'pending'.` });
      return;
    }
    
    const email = data.user_email || data.userEmail || data.email;
    if (!email) {
      res.status(400).json({ error: 'Client email is missing in the renewal request.' });
      return;
    }
    
    let durationMonths = Number(data.durationMonths || data.duration || 1);
    if (data.notes) {
      try {
        const parsedNotes = typeof data.notes === 'string' ? JSON.parse(data.notes) : data.notes;
        if (parsedNotes && parsedNotes.durationMonths) {
          durationMonths = Number(parsedNotes.durationMonths);
        } else if (parsedNotes && parsedNotes.duration) {
          durationMonths = Number(parsedNotes.duration);
        }
      } catch (e) {
        console.warn('[RenewController] Error parsing notes JSON for duration:', e);
      }
    }
    
    console.log(`[RenewController] Approving renewal request ${requestId} for ${email} with duration of ${durationMonths} months.`);
    
    // Call the service to update client's expiry time in 3X-UI
    const newExpiryTime = await xuiService.updateClientExpiry(email, durationMonths);
    
    console.log(`[RenewController] 3X-UI update successful. New expiry time is: ${newExpiryTime}. Updating Supabase...`);
    
    const nowIso = new Date().toISOString();
    // Update Supabase document upon success with lowercase 'approved'
    const { error: updateErr } = await supabase.from('renew_requests').update({
      status: 'approved',
      approvedAt: nowIso,
      approved_at: nowIso,
      processedAt: nowIso,
      processed_at: nowIso,
      newExpiry: newExpiryTime,
      new_expiry: newExpiryTime
    }).eq('id', requestId);

    if (updateErr) {
      await supabase.from('renewRequests').update({
        status: 'approved',
        approvedAt: nowIso,
        processedAt: nowIso,
        newExpiry: newExpiryTime
      }).eq('id', requestId);
    }
    
    console.log(`[RenewController] Supabase record ${requestId} updated successfully.`);
    
    // Trigger Telegram approved notification asynchronously
    const approvedAtNow = new Date();
    sendRenewApprovedNotification({
      email: email,
      userEmail: email,
      planName: data.planName || data.plan || 'N/A',
      durationMonths: durationMonths,
      newExpiry: newExpiryTime,
      approvedAt: approvedAtNow,
    }).catch((telegramErr) => {
      console.error('[RenewController] Telegram approved notification error:', telegramErr?.message || telegramErr);
    });
    
    res.json({
      success: true,
      message: 'Renewal request approved and 3X-UI client updated successfully.',
      data: {
        requestId,
        newExpiry: newExpiryTime,
        status: 'approved'
      }
    });
  } catch (error: any) {
    console.error(`[RenewController] Error approving renewal request ${requestId}:`, error.message);
    res.status(500).json({ error: error.message });
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
