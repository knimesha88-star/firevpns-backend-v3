import { Router } from 'express';
import { getStats, getUsers } from '../controllers/adminController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';

const router = Router();

router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/stats', getStats);
router.get('/users', getUsers);

export default router;
