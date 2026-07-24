import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import { supabase } from '../../lib/supabase.js';

export const adminMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user || !req.user.uid) {
      res.status(401).json({ error: 'Unauthorized: No user found' });
      return;
    }

    if (req.user.email?.toLowerCase() === 'madushannimesha16@gmail.com') {
      req.admin = true;
      next();
      return;
    }

    const { data: profileData } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', req.user.uid)
      .maybeSingle();

    let role = profileData?.role;

    if (!role) {
      const { data: userData } = await supabase
        .from('users')
        .select('role')
        .or(`id.eq.${req.user.uid},uid.eq.${req.user.uid}`)
        .maybeSingle();
      role = userData?.role;
    }

    if (role !== 'admin' && role !== 'super_admin') {
      res.status(403).json({ error: 'Forbidden: Admin access required' });
      return;
    }

    req.admin = true;
    next();
  } catch (error) {
    res.status(403).json({ error: 'Forbidden' });
  }
};
