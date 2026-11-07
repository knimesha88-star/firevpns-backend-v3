import { Request, Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import { getAllowedHostnames } from '../services/turnstileService.js';
import { sendCustomerRegistrationEmail } from '../services/emailService.js';
import { createCustomerNotification } from '../services/notificationService.js';

export const verifySession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, user: req.user });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getTurnstilePublicConfig = (_req: Request, res: Response): void => {
  const rawSiteKey = process.env.VITE_TURNSTILE_SITE_KEY || process.env.TURNSTILE_SITE_KEY || '';
  const siteKey = rawSiteKey.replace(/^['"]+|['"]+$/g, '').trim();
  const allowedHostnames = getAllowedHostnames();
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

export const notifyCustomerRegistration = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, fullName, name, userId } = req.body || {};
    const cleanEmail = String(email || '').trim();
    const customerName = String(fullName || name || cleanEmail.split('@')[0] || 'Valued Customer').trim();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      res.status(400).json({ success: false, error: 'Valid customer email is required' });
      return;
    }

    if (userId) {
      createCustomerNotification({
        userId,
        userEmail: cleanEmail,
        title: 'Welcome to FIREVPNs!',
        message: 'Your FIREVPNs account has been created. You can claim up to 2 free trials or activate a VPN package anytime.',
        type: 'welcome'
      }).catch((err) => {
        console.warn('[AuthController] Welcome notification warning:', err?.message || err);
      });
    }

    sendCustomerRegistrationEmail({
      userEmail: cleanEmail,
      customerName,
      userId: userId || undefined
    }).catch((err) => {
      console.warn('[AuthController] Registration welcome email warning:', err?.message || err);
    });

    res.json({ success: true, message: 'Registration welcome notification queued' });
  } catch (error: any) {
    console.warn('[AuthController] Non-blocking registration notification error:', error?.message || error);
    res.json({ success: true, message: 'Registration completed' });
  }
};

