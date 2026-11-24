import { Response, NextFunction } from 'express';
import { supabase, supabaseAdmin } from '../../lib/supabase.js';
import { AuthRequest } from '../../types/interfaces.js';

const verifiedTokenCache = new Map<string, { user: any; expiresAt: number }>();
const TOKEN_CACHE_TTL_MS = 45 * 1000;

const roleCache = new Map<string, { role: string; expiresAt: number }>();
const ROLE_CACHE_TTL_MS = 30 * 1000;

/**
 * Authoritatively resolves a user's role from the database (`profiles`, `user_roles`, or `users`).
 * NEVER trusts client-writable `user_metadata.role` or hardcoded emails.
 */
export const resolveUserRoleFromDb = async (uid: string): Promise<string> => {
  if (!uid) return 'customer';

  const now = Date.now();
  const cached = roleCache.get(uid);
  if (cached && cached.expiresAt > now) {
    return cached.role;
  }

  const db = supabaseAdmin || supabase;
  let resolvedRole = 'customer';

  try {
    const { data: profileData } = await db
      .from('profiles')
      .select('role')
      .eq('id', uid)
      .maybeSingle();

    if (profileData?.role) {
      resolvedRole = String(profileData.role).toLowerCase().trim();
    } else {
      const { data: userRoleData } = await db
        .from('user_roles')
        .select('role')
        .eq('user_id', uid)
        .maybeSingle();

      if (userRoleData?.role) {
        resolvedRole = String(userRoleData.role).toLowerCase().trim();
      } else {
        const { data: userData } = await db
          .from('users')
          .select('role')
          .or(`id.eq.${uid},uid.eq.${uid}`)
          .maybeSingle();

        if (userData?.role) {
          resolvedRole = String(userData.role).toLowerCase().trim();
        }
      }
    }
  } catch (err: any) {
    console.warn('[AuthMiddleware] Database role lookup warning:', err?.message || err);
  }

  if (roleCache.size > 1000) {
    roleCache.clear();
  }
  roleCache.set(uid, { role: resolvedRole, expiresAt: now + ROLE_CACHE_TTL_MS });
  return resolvedRole;
};

export const isUserAdminInDb = async (uid?: string): Promise<boolean> => {
  if (!uid) return false;
  const role = await resolveUserRoleFromDb(uid);
  return role === 'admin' || role === 'super_admin';
};

export const invalidateUserRoleCache = (uid?: string): void => {
  if (uid) {
    roleCache.delete(uid);
  } else {
    roleCache.clear();
  }
};

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization || (req.headers as any).Authorization || req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token || token.split('.').length !== 3) {
    res.status(401).json({ error: 'Unauthorized: Malformed token' });
    return;
  }

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
        setTimeout(() => reject(new Error('AUTH_SERVICE_TIMEOUT')), 5000)
      ),
    ]);

    const { data: { user }, error } = authResult;
    if (error || !user) {
      res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
      return;
    }

    const dbRole = await resolveUserRoleFromDb(user.id);

    const userObj = {
      ...user,
      uid: user.id,
      email: user.email || '',
      role: dbRole,
    };

    if (verifiedTokenCache.size > 500) {
      verifiedTokenCache.clear();
    }
    verifiedTokenCache.set(token, { user: userObj, expiresAt: now + TOKEN_CACHE_TTL_MS });

    req.user = userObj;
    next();
  } catch (error: any) {
    if (error?.message === 'AUTH_SERVICE_TIMEOUT') {
      console.error('[AuthMiddleware] Supabase token verification timed out.');
      res.status(503).json({ error: 'Authentication service temporarily unavailable. Please retry.' });
      return;
    }

    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};

