import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

import authRoutes from './backend/src/api/routes/authRoutes.js';
import adminRoutes from './backend/src/api/routes/adminRoutes.js';
import clientRoutes from './backend/src/api/routes/clientRoutes.js';
import userRoutes from './backend/src/api/routes/userRoutes.js';
import xuiRoutes from './backend/src/api/routes/xuiRoutes.js';
import threeXuiRoutes from './backend/src/api/routes/threeXuiRoutes.js';
import { errorMiddleware } from './backend/src/api/middleware/errorMiddleware.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  // API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/client', clientRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/xui', xuiRoutes);
  app.use('/api/3xui', threeXuiRoutes);
  
  app.use(errorMiddleware);

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch(console.error);
