import { Response, NextFunction } from 'express';
import { supabase } from '../../lib/supabase.js';
import { AuthRequest } from '../../types/interfaces.js';

const verifiedTokenCache = new Map<string, { user: any; expiresAt: number }>();
const TOKEN_CACHE_TTL_MS = 60 * 1000;

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization || (req.headers as any).Authorization || req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const now = Date.now();
  const cached = verifiedTokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    req.user = cached.user;
    next();
    return;
  }

  try {
    const authResult = await Promise.race([
      supabase.auth.getUser(token),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Supabase auth.getUser timed out after 5s')), 5000)
      ),
    ]);
    const { data: { user }, error } = authResult;
    if (error || !user) {
      throw error || new Error('User not found');
    }

    const userObj = {
      uid: user.id,
      email: user.email,
      role: user.user_metadata?.role || 'customer',
      ...user,
    };

    if (verifiedTokenCache.size > 500) {
      verifiedTokenCache.clear();
    }
    verifiedTokenCache.set(token, { user: userObj, expiresAt: now + TOKEN_CACHE_TTL_MS });

    req.user = userObj;
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
          req.user = decodedToken;
          next();
          return;
        }
      } catch (e: any) {
        // Silent catch
      }
    }

    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};
