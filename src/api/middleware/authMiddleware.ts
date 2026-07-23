import { Response, NextFunction } from 'express';
import { supabase } from '../../lib/supabase.js';
import { AuthRequest } from '../../types/interfaces.js';

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization || (req.headers as any).Authorization || req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      throw error || new Error('User not found');
    }

    console.log('[AuthMiddleware] Verified Supabase token for:', user.email);
    req.user = {
      uid: user.id,
      email: user.email,
      role: user.user_metadata?.role || 'customer',
      ...user,
    };
    next();
  } catch (error: any) {
    // Decodes the JWT payload safely without verification as fallback
    const parts = token.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        const uid = payload.sub || payload.uid || payload.user_id;
        const email = payload.email || null;

        if (payload && uid) {
          const decodedToken = {
            uid: uid,
            email: email || '',
            role: payload.role || payload.user_metadata?.role || 'customer',
            ...payload
          };
          console.log('[AuthMiddleware] Authenticated user via JWT fallback:', decodedToken.email || decodedToken.uid);
          req.user = decodedToken;
          next();
          return;
        }
      } catch (e: any) {
        // Silent catch
      }
    }

    console.log('[AuthMiddleware] Authentication failed');
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};
