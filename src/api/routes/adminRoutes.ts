import { Router } from 'express';
import { getStats, getUsers, approveOrder } from '../controllers/adminController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';

const router = Router();

router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/stats', getStats);
router.get('/users', getUsers);
router.post('/approve-order', approveOrder);
router.post('/orders/:orderId/approve', approveOrder);

export default router;
