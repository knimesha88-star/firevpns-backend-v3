import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as userService from '../services/userService.js';
import * as notificationService from '../services/notificationService.js';
import { isUserAdminInDb } from '../middleware/authMiddleware.js';
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
    res.status(500).json({ error: 'Failed to load profile.' });
  }
};

export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(400).json({ error: 'No uid found' });
      return;
    }
    const profile = await userService.updateUserProfile(uid, req.body);
    res.json({ success: true, profile });
  } catch (error: any) {
    if (error?.statusCode === 400) {
      res.status(400).json({ error: error.message || 'Invalid profile input.' });
      return;
    }
    res.status(500).json({ error: 'Failed to update profile.' });
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
    res.status(500).json({ error: 'Failed to fetch notifications.' });
  }
};

export const readNotification = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Notification ID required' });
      return;
    }
    const userId = req.user?.uid || req.user?.id || '';
    const success = await notificationService.markNotificationAsRead(id, userId);
    if (!success) {
      res.status(404).json({ error: 'Notification not found or already read.' });
      return;
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update notification.' });
  }
};

export const deleteAllNotifications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid || req.user?.id || '';
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized: User not authenticated' });
      return;
    }
    const success = await notificationService.deleteAllCustomerNotifications(userId);
    if (!success) {
      res.status(500).json({ error: 'Failed to delete notifications from database' });
      return;
    }
    res.json({ success: true, message: 'All notifications deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete notifications.' });
  }
};

export const notifySupportTicket = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = req.body || {};
    const authenticatedUid = req.user?.uid || null;
    const authenticatedEmail = req.user?.email || '';

    // Bind identity to authenticated session when logged in; on public Turnstile form, never inject notifications into arbitrary userIds
    const resolvedEmail = authenticatedEmail || String(data.email || '').trim().slice(0, 160) || 'N/A';
    const notificationData = {
      ticketId: String(data.ticketId || data.id || 'N/A').slice(0, 80),
      customerName: String(data.customerName || authenticatedEmail || 'Customer').slice(0, 120),
      email: resolvedEmail,
      category: String(data.category || 'General').slice(0, 80),
      priority: String(data.priority || 'Normal').slice(0, 40),
      subject: String(data.subject || 'Support Request').slice(0, 200),
      message: String(data.message || '').slice(0, 2000) || 'N/A',
      time: new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC',
    };

    if (authenticatedUid) {
      try {
        await notificationService.createCustomerNotification({
          userId: authenticatedUid,
          userEmail: authenticatedEmail,
          title: 'Support Ticket Created',
          message: `Your support ticket #${notificationData.ticketId} ("${notificationData.subject}") has been created.`,
          type: 'support_ticket_created'
        });
      } catch (notifErr: any) {
        console.error('[UserController] Support ticket customer notification error:', notifErr?.message || notifErr);
      }
    }

    sendNewSupportTicketNotification(notificationData).catch((err) => {
      console.error('[UserController] Telegram support ticket notification error:', err?.message || err);
    });

    res.json({
      success: true,
      message: 'Support ticket notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[UserController] Error processing support ticket notification:', error?.message || error);
    res.status(500).json({ error: 'Failed to send support notification.' });
  }
};

export const notifySupportTicketReply = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const callerUid = req.user?.uid;
    if (!callerUid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Only verified admins may dispatch support ticket reply emails & notifications to customers
    const callerIsAdmin = await isUserAdminInDb(callerUid);
    if (!callerIsAdmin) {
      res.status(403).json({ error: 'Forbidden: Only administrators can send support reply notifications.' });
      return;
    }

    const data = req.body || {};
    const ticketId = String(data.ticketId || data.id || 'N/A').slice(0, 80);
    const email = String(data.email || data.userEmail || '').trim().slice(0, 160);
    const targetUserId = data.userId ? String(data.userId).trim() : null;
    const replyMessage = String(data.reply || data.message || 'An update was posted to your support ticket.').slice(0, 2000);

    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Valid recipient email is required.' });
      return;
    }

    try {
      await notificationService.createCustomerNotification({
        userId: targetUserId,
        userEmail: email,
        title: 'Support Ticket Replied',
        message: `Your support ticket #${ticketId} has a new reply: "${replyMessage}"`,
        type: 'support_ticket_replied'
      });
    } catch (notifErr: any) {
      console.error('[UserController] Support ticket reply customer notification error:', notifErr?.message || notifErr);
    }

    sendSupportReplyEmail({
      userEmail: email,
      ticketId: ticketId,
      subject: String(data.subject || 'Support Ticket Update').slice(0, 200),
      replyMessage: replyMessage,
      userId: targetUserId || undefined
    }).catch(e => console.warn('[UserController] Support ticket reply email warning:', e));

    res.json({
      success: true,
      message: 'Support ticket reply notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[UserController] Error processing support ticket reply notification:', error?.message || error);
    res.status(500).json({ error: 'Failed to send support reply notification.' });
  }
};

export const notifyLiveChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const callerUid = req.user?.uid;
    if (!callerUid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const data = req.body || {};
    const message = String(data.message || '').trim().slice(0, 2000);
    if (!message) {
      res.status(400).json({ error: 'Message content is required.' });
      return;
    }

    // NEVER trust client-supplied data.isAdmin — verify admin role strictly from DB
    const callerIsAdmin = await isUserAdminInDb(callerUid);

    if (callerIsAdmin && data.isAdmin) {
      const targetEmail = String(data.customerEmail || '').trim().slice(0, 160);
      if (targetEmail && targetEmail.includes('@')) {
        sendLiveChatReplyEmail({
          userEmail: targetEmail,
          customerName: String(data.customerName || 'Customer').slice(0, 120),
          chatMessage: message,
          userId: data.userId ? String(data.userId).trim() : undefined
        }).catch(e => console.warn('[UserController] Live chat reply email warning:', e));
      }
    } else {
      // Customer-sent live chat message -> alert admins via Telegram using authenticated user's real email
      const senderEmail = req.user?.email || 'N/A';
      sendLiveChatNotification({
        customerEmail: senderEmail,
        customerName: String(data.customerName || senderEmail.split('@')[0] || 'Customer').slice(0, 120),
        message
      }).catch((err) => {
        console.error('[UserController] Telegram live chat notification error:', err?.message || err);
      });
    }

    res.json({
      success: true,
      message: 'Live chat notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[UserController] Error processing live chat notification:', error?.message || error);
    res.status(500).json({ error: 'Failed to send live chat notification.' });
  }
};

