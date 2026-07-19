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
import { errorMiddleware } from './src/api/middleware/errorMiddleware.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
});
