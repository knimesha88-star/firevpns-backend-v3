import { Router } from 'express';
import { verifySession } from '../controllers/authController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/session', authMiddleware, verifySession);

export default router;
