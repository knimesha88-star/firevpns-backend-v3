import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as clientService from '../services/clientService.js';

export const getStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const email = req.user?.email;
    if (!email) {
      res.status(400).json({ error: 'No email found in token' });
      return;
    }
    const status = await clientService.getClientStatus(email);
    res.json({ success: true, data: status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getSubscription = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const email = req.user?.email;
    if (!email) {
      res.status(400).json({ error: 'No email found in token' });
      return;
    }
    const uri = await clientService.getSubscriptionUri(email);
    res.json({ success: true, subscriptionUri: uri });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
