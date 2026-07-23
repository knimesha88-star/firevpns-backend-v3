import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as vpnService from '../services/vpnService.js';

export const getMyConfigs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const email = req.user?.email;
    const authHeader = req.headers.authorization || (req.headers as any)?.Authorization;
    const token = authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;

    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthorized: No UID found' });
      return;
    }

    const configs = await vpnService.getMyConfigs(uid, email, token);
    res.json({ success: true, configs });
  } catch (error: any) {
    console.error('[vpnController] Error fetching configs:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
  }
};
