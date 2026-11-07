import { Request, Response, NextFunction } from 'express';
import {
  extractTurnstileToken,
  extractClientIp,
  verifyTurnstileToken,
} from '../services/turnstileService.js';

export const turnstileMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // Guard against verifying the same request twice if middleware is ever chained twice
  if ((req as any).turnstileVerified === true) {
    next();
    return;
  }

  const token = extractTurnstileToken(req);
  const clientIp = extractClientIp(req);

  const result = await verifyTurnstileToken(token, clientIp);

  if (!result.valid) {
    res.status(result.statusCode).json({
      success: false,
      error: result.error || 'Security verification (CAPTCHA) failed.',
      code: result.code || 'TURNSTILE_VERIFICATION_FAILED',
      errorCodes: result.errorCodes,
    });
    return;
  }

  (req as any).turnstileVerified = true;
  (req as any).turnstileResult = result;
  next();
};
