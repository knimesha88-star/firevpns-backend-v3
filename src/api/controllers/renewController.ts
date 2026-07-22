import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as xuiService from '../services/xuiService.js';
import { adminDb } from '../../config/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';
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
    
    // Read the renewRequests document from Firestore
    const requestDocRef = adminDb.collection('renewRequests').doc(requestId);
    const docSnap = await requestDocRef.get();
    
    if (!docSnap.exists) {
      res.status(404).json({ error: 'Renewal request not found' });
      return;
    }
    
    const data = docSnap.data();
    if (!data) {
      res.status(404).json({ error: 'Renewal request data is empty' });
      return;
    }
    
    // Validate status must equal "Pending"
    if (data.status !== 'Pending') {
      res.status(400).json({ error: `Cannot approve request with status '${data.status}'. Status must be 'Pending'.` });
      return;
    }
    
    const email = data.email || data.userEmail;
    if (!email) {
      res.status(400).json({ error: 'Client email is missing in the renewal request.' });
      return;
    }
    
    const durationMonths = Number(data.durationMonths || data.duration || 1);
    
    console.log(`[RenewController] Approving renewal request ${requestId} for ${email} with duration of ${durationMonths} months.`);
    
    // Call the service to update client's expiry time in 3X-UI
    const newExpiryTime = await xuiService.updateClientExpiry(email, durationMonths);
    
    console.log(`[RenewController] 3X-UI update successful. New expiry time is: ${newExpiryTime}. Updating Firestore...`);
    
    // Update Firestore document upon success
    await requestDocRef.update({
      status: 'Approved',
      approvedAt: FieldValue.serverTimestamp(),
      processedAt: FieldValue.serverTimestamp(),
      newExpiry: newExpiryTime
    });
    
    console.log(`[RenewController] Firestore document ${requestId} updated successfully.`);
    
    // Trigger Telegram approved notification asynchronously without breaking approval flow if it fails
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
        status: 'Approved'
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

    // Send Telegram Notification safely without crashing or rejecting request
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
