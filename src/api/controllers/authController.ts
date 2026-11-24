import { Request, Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { getAllowedHostnames } from '../services/turnstileService.js';
import { sendCustomerRegistrationEmail } from '../services/emailService.js';
import { createCustomerNotification } from '../services/notificationService.js';

export const verifySession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, user: req.user });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to verify session.' });
  }
};

export const getTurnstilePublicConfig = (_req: Request, res: Response): void => {
  const rawSiteKey = process.env.VITE_TURNSTILE_SITE_KEY || process.env.TURNSTILE_SITE_KEY || '';
  const siteKey = rawSiteKey.replace(/^['"]+|['"]+$/g, '').trim();
  const allowedHostnames = getAllowedHostnames();
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    success: true,
    siteKey,
    allowedHostname: allowedHostnames[0] || 'firevpnsvip.qzz.io',
    allowedHostnames,
  });
};

export const verifyTurnstileHandler = (req: Request, res: Response): void => {
  const result = (req as any).turnstileResult || {};
  res.json({
    success: true,
    verified: true,
    hostname: result.hostname,
    challengeTs: result.challengeTs,
    action: result.action,
  });
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGISTRATION_NOTIFY_WINDOW_MS = 15 * 60 * 1000;

export const notifyCustomerRegistration = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, fullName, name, userId } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanUserId = String(userId || '').trim();
    const customerName = String(fullName || name || cleanEmail.split('@')[0] || 'Valued Customer')
      .trim()
      .slice(0, 120);

    if (!cleanEmail || !cleanEmail.includes('@') || !UUID_REGEX.test(cleanUserId)) {
      res.status(400).json({ success: false, error: 'Valid registration details are required.' });
      return;
    }

    // Verify the registration actually belongs to a newly created Supabase user matching this email
    const { data: profileRow } = await supabaseAdmin
      .from('profiles')
      .select('id, email, created_at')
      .eq('id', cleanUserId)
      .maybeSingle();

    if (!profileRow || String(profileRow.email || '').trim().toLowerCase() !== cleanEmail) {
      res.status(403).json({ success: false, error: 'Registration record could not be verified.' });
      return;
    }

    if (profileRow.created_at) {
      const createdAtMs = new Date(profileRow.created_at).getTime();
      if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > REGISTRATION_NOTIFY_WINDOW_MS) {
        // Silently ignore replay attempts for older accounts
        res.json({ success: true, message: 'Registration notification already processed.' });
        return;
      }
    }

    createCustomerNotification({
      userId: cleanUserId,
      userEmail: cleanEmail,
      title: 'Welcome to FIREVPNs!',
      message: 'Your FIREVPNs account has been created. You can claim up to 2 free trials or activate a VPN package anytime.',
      type: 'welcome'
    }).catch((err) => {
      console.warn('[AuthController] Welcome notification warning:', err?.message || err);
    });

    sendCustomerRegistrationEmail({
      userEmail: cleanEmail,
      customerName,
      userId: cleanUserId
    }).catch((err) => {
      console.warn('[AuthController] Registration welcome email warning:', err?.message || err);
    });

    res.json({ success: true, message: 'Registration welcome notification queued' });
  } catch (error: any) {
    console.warn('[AuthController] Non-blocking registration notification error:', error?.message || error);
    res.json({ success: true, message: 'Registration completed' });
  }
};


