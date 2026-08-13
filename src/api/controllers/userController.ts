import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as userService from '../services/userService.js';
import * as notificationService from '../services/notificationService.js';
import { sendNewSupportTicketNotification, sendLiveChatNotification } from '../services/telegramService.js';
import { sendSupportReplyEmail, sendLiveChatReplyEmail } from '../services/emailService.js';

export const getProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(400).json({ error: 'No uid found' });
      return;
    }
    const profile = await userService.getUserProfile(uid);
    res.json({ success: true, profile });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(400).json({ error: 'No uid found' });
      return;
    }
    await userService.updateUserProfile(uid, req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getNotifications = async (req: AuthRequest, res: Response): Promise<void> => {
  const reqStart = Date.now();
  console.log(`[API Performance] [GET /api/user/notifications] Request started for UID: ${req.user?.uid || 'none'}`);
  try {
    const uid = req.user?.uid;
    const email = req.user?.email;

    const dbStart = Date.now();
    const notifications = await notificationService.getUserNotifications(uid, email);
    const dbTime = Date.now() - dbStart;

    const totalTime = Date.now() - reqStart;
    console.log(`[API Performance] [GET /api/user/notifications] Request finished | Total Execution: ${totalTime}ms | Database Time: ${dbTime}ms | 3X-UI Time: 0ms`);
    res.json({ success: true, notifications });
  } catch (error: any) {
    const totalTime = Date.now() - reqStart;
    console.error(`[API Performance] [GET /api/user/notifications] Request failed after ${totalTime}ms:`, error);
    res.status(500).json({ error: error.message });
  }
};

export const readNotification = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Notification ID required' });
      return;
    }
    await notificationService.markNotificationAsRead(id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const notifySupportTicket = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = req.body || {};
    
    const notificationData = {
      ticketId: data.ticketId || data.id || 'N/A',
      customerName: data.customerName || req.user?.email || 'N/A',
      email: data.email || req.user?.email || 'N/A',
      category: data.category || 'N/A',
      priority: data.priority || 'N/A',
      subject: data.subject || 'N/A',
      message: data.message || 'N/A',
      time: data.time || new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC',
    };

    try {
      await notificationService.createCustomerNotification({
        userId: req.user?.uid || data.userId || null,
        userEmail: notificationData.email,
        title: 'Support Ticket Created',
        message: `Your support ticket #${notificationData.ticketId} ("${notificationData.subject}") has been created.`,
        type: 'support_ticket_created'
      });
    } catch (notifErr: any) {
      console.error('[UserController] Support ticket customer notification error:', notifErr?.message || notifErr);
    }

    sendNewSupportTicketNotification(notificationData).catch((err) => {
      console.error('[UserController] Telegram support ticket notification error:', err?.message || err);
    });

    res.json({
      success: true,
      message: 'Support ticket notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[UserController] Error processing support ticket notification:', error.message);
    res.status(500).json({ error: error.message });
  }
};

export const notifySupportTicketReply = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = req.body || {};
    const ticketId = data.ticketId || data.id || 'N/A';
    const email = data.email || data.userEmail || req.user?.email || 'N/A';
    const replyMessage = data.reply || data.message || 'An update was posted to your support ticket.';

    try {
      await notificationService.createCustomerNotification({
        userId: data.userId || req.user?.uid || null,
        userEmail: email,
        title: 'Support Ticket Replied',
        message: `Your support ticket #${ticketId} has a new reply: "${replyMessage}"`,
        type: 'support_ticket_replied'
      });
    } catch (notifErr: any) {
      console.error('[UserController] Support ticket reply customer notification error:', notifErr?.message || notifErr);
    }

    if (email && email !== 'N/A') {
      sendSupportReplyEmail({
        userEmail: email,
        ticketId: ticketId,
        subject: data.subject || 'Support Ticket Update',
        replyMessage: replyMessage,
        userId: data.userId || req.user?.uid
      }).catch(e => console.warn('[UserController] Support ticket reply email warning:', e));
    }

    res.json({
      success: true,
      message: 'Support ticket reply notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[UserController] Error processing support ticket reply notification:', error.message);
    res.status(500).json({ error: error.message });
  }
};



export const notifyLiveChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = req.body || {};
    const email = data.customerEmail || req.user?.email || 'N/A';
    
    sendLiveChatNotification({
      customerEmail: email,
      customerName: data.customerName,
      message: data.message
    }).catch((err) => {
      console.error('[UserController] Telegram live chat notification error:', err?.message || err);
    });

    if (email && email !== 'N/A' && data.isAdmin) {
      sendLiveChatReplyEmail({
        userEmail: email,
        customerName: data.customerName,
        chatMessage: data.message,
        userId: data.userId
      }).catch(e => console.warn('[UserController] Live chat reply email warning:', e));
    }

    res.json({
      success: true,
      message: 'Live chat notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[UserController] Error processing live chat notification:', error.message);
    res.status(500).json({ error: error.message });
  }
};
