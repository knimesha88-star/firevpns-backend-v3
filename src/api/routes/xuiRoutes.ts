import { Router } from 'express';
import { getInbounds } from '../controllers/xuiController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';

const router = Router();

router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/inbounds', getInbounds);

export default router;
