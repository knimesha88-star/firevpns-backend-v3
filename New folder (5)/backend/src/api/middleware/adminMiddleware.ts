import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import { adminDb } from '../../config/firebaseAdmin.js';

export const adminMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user || !req.user.uid) {
      res.status(401).json({ error: 'Unauthorized: No user found' });
      return;
    }
    
    const userDoc = await adminDb.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) {
      res.status(403).json({ error: 'Forbidden: Admin access required' });
      return;
    }

    const userData = userDoc.data();
    if (userData?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden: Admin access required' });
      return;
    }
    
    req.admin = true;
    next();
  } catch (error) {
    res.status(403).json({ error: 'Forbidden' });
  }
};
