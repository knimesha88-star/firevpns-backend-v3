import { Response, NextFunction } from 'express';
import { adminAuth } from '../../config/firebaseAdmin.js';
import { AuthRequest } from '../../types/interfaces.js';

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization || (req.headers as any).Authorization || req.header('Authorization');
  console.log(req.headers.authorization);

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    console.log(decodedToken.email);
    req.user = decodedToken;
    next();
  } catch (error: any) {
    console.error('[AuthMiddleware] Firebase verifyIdToken error:', error);
    res.status(401).json({ error: 'Unauthorized: Invalid token', details: error.message });
  }
};
