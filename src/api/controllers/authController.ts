import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';

export const verifySession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, user: req.user });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
