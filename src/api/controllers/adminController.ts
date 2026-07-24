import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as adminService from '../services/adminService.js';
import * as xuiService from '../services/xuiService.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createCustomerNotification } from '../services/notificationService.js';
import { sendOrderRejectedNotification } from '../services/telegramService.js';

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
  try {
    const orderId = req.params.orderId || req.body.orderId;
    if (!orderId) {
      res.status(400).json({ error: 'Order ID is required' });
      return;
    }
    const authHeader = req.headers.authorization || (req.headers as any)?.Authorization;
    const token = authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;
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
      reject_reason: reason,
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
      await createCustomerNotification({
        userId: order.customer_id || null,
        userEmail: order.email,
        title: 'Order Rejected',
        message: reason,
        type: 'rejection',
        orderId: order.id
      });
    } catch (notifErr) {
      console.warn('[AdminController] Customer notification creation warning:', notifErr);
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


