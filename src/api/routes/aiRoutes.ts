import { Router } from 'express';
import {
  getPublicAiConfigHandler,
  postAiChatHandler,
  getAdminAiSettingsHandler,
  saveAdminAiSettingsHandler,
} from '../controllers/aiController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';

const router = Router();

// Public / Customer endpoints
router.get('/config', getPublicAiConfigHandler);
router.post('/chat', postAiChatHandler);

// Admin-only endpoints
router.get('/settings', authMiddleware, adminMiddleware, getAdminAiSettingsHandler);
router.post('/settings', authMiddleware, adminMiddleware, saveAdminAiSettingsHandler);

export default router;
