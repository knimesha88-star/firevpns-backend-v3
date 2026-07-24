import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as userService from '../services/userService.js';
import * as notificationService from '../services/notificationService.js';

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

