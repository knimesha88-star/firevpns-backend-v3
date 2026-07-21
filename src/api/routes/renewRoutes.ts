import { Router } from 'express';
import { approveRenewRequest } from '../controllers/renewController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';

const router = Router();

// Protect all renewal endpoints to only allow authenticated administrators
router.use(authMiddleware);
router.use(adminMiddleware);

router.post('/approve/:requestId', approveRenewRequest);

export default router;
