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
    const client = await clientService.getClientStatus(email);
    console.log("VPN DATA:", JSON.stringify(client, null, 2));
    res.json({ success: true, data: client });
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
