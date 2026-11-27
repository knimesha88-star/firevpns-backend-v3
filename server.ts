import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

import authRoutes from './src/api/routes/authRoutes.js';
import adminRoutes from './src/api/routes/adminRoutes.js';
import clientRoutes from './src/api/routes/clientRoutes.js';
import userRoutes from './src/api/routes/userRoutes.js';
import xuiRoutes from './src/api/routes/xuiRoutes.js';
import threeXuiRoutes from './src/api/routes/threeXuiRoutes.js';
import renewRoutes from './src/api/routes/renewRoutes.js';
import vpnRoutes from './src/api/routes/vpnRoutes.js';
import aiRoutes from './src/api/routes/aiRoutes.js';
import telegramRoutes from './src/api/routes/telegramRoutes.js';
import { errorMiddleware } from './src/api/middleware/errorMiddleware.js';
import {
  generalApiRateLimit,
  webhookRateLimit,
} from './src/api/middleware/rateLimitMiddleware.js';
import {
  startBackgroundSyncScheduler,
  triggerBackgroundSyncIfNeeded,
  triggerPanelDeletionSyncIfNeeded,
} from './src/api/services/xuiService.js';
import { startTelegramBotPolling } from './src/api/services/telegramService.js';
import { getBackendApiTimeoutMs } from './src/utils/apiTimeoutRoutes.js';

dotenv.config();

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err);
});

function buildAllowedOrigins(): Set<string> {
  const origins = new Set<string>([
    'https://firevpnsvip.qzz.io',
    'https://www.firevpnsvip.qzz.io',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);
  for (const raw of [
    process.env.ALLOWED_ORIGINS || '',
    process.env.CORS_ORIGINS || '',
    process.env.APP_URL || '',
    process.env.VITE_APP_URL || '',
  ]) {
    for (const part of raw.split(',')) {
      const cleaned = part.trim().replace(/\/+$/, '');
      if (cleaned) {
        try {
          const parsed = new URL(cleaned);
          origins.add(`${parsed.protocol}//${parsed.host}`);
        } catch {
          // ignore malformed origin
        }
      }
    }
  }
  return origins;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const PORT = parseInt(process.env.PORT || '3000', 10);
const allowedOrigins = buildAllowedOrigins();

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.get(['/api/health', '/health'], (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const normalized = origin.trim().replace(/\/+$/, '');
      if (allowedOrigins.has(normalized)) return callback(null, true);
      try {
        const parsed = new URL(normalized);
        const host = parsed.hostname.toLowerCase();
        if (
          parsed.protocol === 'https:' &&
          (host === 'firevpnsvip.qzz.io' || host.endsWith('.firevpnsvip.qzz.io') || host.endsWith('.run.app'))
        ) {
          return callback(null, true);
        }
      } catch {
        // reject
      }
      console.warn(`[CORS] Blocked request from untrusted origin: ${origin}`);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'cf-turnstile-response'],
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

app.use('/api', (req, res, next) => {
  const timeoutMs = getBackendApiTimeoutMs(req.method, req.path);
  const timeoutController = new AbortController();
  (req as any).timeoutSignal = timeoutController.signal;

  const timer = setTimeout(() => {
    if (!timeoutController.signal.aborted) {
      timeoutController.abort(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }
    if (!res.headersSent) {
      console.error(`[API Timeout] ${req.method} ${req.originalUrl} timed out after ${timeoutMs}ms`);
      res.status(504).json({
        success: false,
        error: `Request timed out after ${Math.round(timeoutMs / 1000)} seconds`
      });
    }
  }, timeoutMs);

  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

app.use('/api', generalApiRateLimit);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/users', userRoutes);
app.use('/api/user', userRoutes);
app.use('/api/xui', xuiRoutes);
app.use('/api/3xui', threeXuiRoutes);
app.use('/api/renew', renewRoutes);
app.use('/api/vpn', vpnRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/telegram', webhookRateLimit, telegramRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use(errorMiddleware);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);

  const globalRef = global as any;
  if (!globalRef.__bgSyncSchedulerInitialized) {
    globalRef.__bgSyncSchedulerInitialized = true;
    startTelegramBotPolling().catch((err) => {
      console.warn('[TelegramService] Polling startup warning:', err?.message || err);
    });
    startBackgroundSyncScheduler({
      triggerBackgroundSyncFn: triggerBackgroundSyncIfNeeded,
      triggerPanelDeletionSyncFn: triggerPanelDeletionSyncIfNeeded,
    });
  }
});


