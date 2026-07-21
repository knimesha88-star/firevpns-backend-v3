import { Router } from 'express';
import { approveRenewRequest, createRenewRequest } from '../controllers/renewController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';

const router = Router();

// Protect renewal endpoints with authentication
router.use(authMiddleware);

// Endpoint for customers to submit / notify new renewal request
router.post('/request', createRenewRequest);

// Admin-only endpoints
router.use(adminMiddleware);

router.post('/approve/:requestId', approveRenewRequest);

export default router;
