import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { handleTelegramUpdate } from '../services/telegramService.js';

const router = Router();

function safeCompareSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const telegramWebhookHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    // Validate webhook secret header if TELEGRAM_WEBHOOK_SECRET is configured
    const expectedSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    if (expectedSecret) {
      const providedRaw = req.headers['x-telegram-bot-api-secret-token'];
      const providedSecret = typeof providedRaw === 'string' ? providedRaw.trim() : '';
      if (!providedSecret || !safeCompareSecret(providedSecret, expectedSecret)) {
        console.warn('[TelegramRoutes] Rejected webhook request with invalid secret token.');
        res.status(401).json({ ok: false, error: 'Unauthorized webhook secret' });
        return;
      }
    }

    const update = req.body;
    // Process callback_query / update asynchronously and acknowledge Telegram webhook promptly
    await handleTelegramUpdate(update);
    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('[TelegramRoutes] Error processing Telegram webhook update:', err?.message || err);
    // Always return 200 to Telegram so it does not retry a bad payload infinitely
    res.status(200).json({ ok: true });
  }
};

router.post('/webhook', telegramWebhookHandler);
router.post('/callback', telegramWebhookHandler);

export default router;
