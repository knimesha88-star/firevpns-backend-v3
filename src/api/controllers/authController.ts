import { Request, Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import { getAllowedHostnames } from '../services/turnstileService.js';

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
