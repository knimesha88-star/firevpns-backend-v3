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
import { errorMiddleware } from './src/api/middleware/errorMiddleware.js';
import { triggerBackgroundSyncIfNeeded } from './src/api/services/xuiService.js';

dotenv.config();

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err);
});

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.get(['/api/health', '/health'], (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

app.use('/api', (req, res, next) => {
  const isLongRunning =
    req.path.includes('claim-trial') ||
    req.path.includes('approve');
  const timeoutMs = isLongRunning ? 70000 : 25000;

  const timer = setTimeout(() => {
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

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/users', userRoutes);
app.use('/api/user', userRoutes);
app.use('/api/xui', xuiRoutes);
app.use('/api/3xui', threeXuiRoutes);
app.use('/api/renew', renewRoutes);
app.use('/api/vpn', vpnRoutes);

app.use(errorMiddleware);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);

  const globalRef = global as any;
  if (!globalRef.__bgSyncSchedulerInitialized) {
    globalRef.__bgSyncSchedulerInitialized = true;
    setTimeout(() => {
      try {
        triggerBackgroundSyncIfNeeded('Server Start', true);
      } catch (err) {
        console.error('[Scheduler] Initial background sync error:', err);
      }
    }, 5000);

    setInterval(() => {
      try {
        triggerBackgroundSyncIfNeeded('Scheduled', false);
      } catch (err) {
        console.error('[Scheduler] Scheduled background sync error:', err);
      }
    }, 60000);
  }
});

