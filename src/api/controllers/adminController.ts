import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as adminService from '../services/adminService.js';
import * as xuiService from '../services/xuiService.js';

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
    const result = await xuiService.provisionOrderClient(orderId);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[AdminController] Order approval provisioning error:', error.message);
    res.status(400).json({ error: error.message || 'Provisioning template not found.' });
  }
};
