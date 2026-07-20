import { Router } from 'express';
import { getStatus, getSubscription } from '../controllers/clientController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authMiddleware);

router.get('/status', getStatus);
router.get('/subscription', getSubscription);

export default router;
