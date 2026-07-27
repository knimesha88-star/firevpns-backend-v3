import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as clientService from '../services/clientService.js';

export const getStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const reqStart = Date.now();
  console.log(`[API Performance] [GET /api/client/status] Request started for UID: ${req.user?.uid || 'none'}`);
  try {
    const email = req.user?.email || '';
    const uid = req.user?.uid || '';
    const targetUuid = (req.query.uuid as string) || undefined;

    if (!email && !uid) {
      const totalTime = Date.now() - reqStart;
      console.log(`[API Performance] [GET /api/client/status] Request finished (400) | Total Execution: ${totalTime}ms | Database Time: 0ms | 3X-UI Time: 0ms`);
      res.status(400).json({ error: 'No email or uid found in token' });
      return;
    }

    const dbStart = Date.now();
    const client = await clientService.getClientStatus(email, targetUuid, uid);
    const dbTime = Date.now() - dbStart;

    const totalTime = Date.now() - reqStart;
    console.log(`[API Performance] [GET /api/client/status] Request finished | Total Execution: ${totalTime}ms | Database Time: ${dbTime}ms | 3X-UI Time: 0ms`);
    res.json({ success: true, data: client });
  } catch (error: any) {
    const totalTime = Date.now() - reqStart;
    console.error(`[API Performance] [GET /api/client/status] Request failed after ${totalTime}ms:`, error);
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
