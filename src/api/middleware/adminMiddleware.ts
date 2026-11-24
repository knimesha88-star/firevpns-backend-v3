import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import { isUserAdminInDb } from './authMiddleware.js';

export const adminMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user || !req.user.uid) {
      res.status(401).json({ error: 'Unauthorized: No user found' });
      return;
    }

    const isAdmin = await isUserAdminInDb(req.user.uid);
    if (!isAdmin) {
      res.status(403).json({ error: 'Forbidden: Admin access required' });
      return;
    }

    req.admin = true;
    next();
  } catch (error) {
    res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
};

