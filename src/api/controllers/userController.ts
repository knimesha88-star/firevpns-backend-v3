import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as userService from '../services/userService.js';
import * as notificationService from '../services/notificationService.js';
import { sendNewSupportTicketNotification } from '../services/telegramService.js';

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
  try {
    const uid = req.user?.uid;
    const email = req.user?.email;
    const notifications = await notificationService.getUserNotifications(uid, email);
    res.json({ success: true, notifications });
  } catch (error: any) {
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

    sendNewSupportTicketNotification(notificationData).catch((err) => {
      console.error('[UserController] Telegram support ticket notification error:', err?.message || err);
    });

    res.json({
      success: true,
      message: 'Support ticket Telegram notification triggered successfully.'
    });
  } catch (error: any) {
    console.error('[UserController] Error processing support ticket notification:', error.message);
    res.status(500).json({ error: error.message });
  }
};

