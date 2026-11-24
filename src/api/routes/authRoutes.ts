import { Router } from 'express';
import {
  verifySession,
  getTurnstilePublicConfig,
  verifyTurnstileHandler,
  notifyCustomerRegistration,
} from '../controllers/authController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { turnstileMiddleware } from '../middleware/turnstileMiddleware.js';
import { authRateLimit } from '../middleware/rateLimitMiddleware.js';

const router = Router();

router.get('/turnstile-config', getTurnstilePublicConfig);
router.post('/verify-turnstile', authRateLimit, turnstileMiddleware, verifyTurnstileHandler);
router.post('/register-notify', authRateLimit, notifyCustomerRegistration);
router.get('/session', authMiddleware, verifySession);

export default router;

