import { Router } from 'express';
import { approveRenewRequest, createRenewRequest, createOrderNotification, notifyOrderApprove, notifyOrderReject } from '../controllers/renewController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';

const router = Router();

// Protect renewal endpoints with authentication
router.use(authMiddleware);

// Endpoint for customers to submit / notify new renewal request
router.post('/request', createRenewRequest);

// Endpoint for customers to send new order notification
router.post('/order-notify', createOrderNotification);

// Admin-only endpoints
router.use(adminMiddleware);

router.post('/approve/:requestId', approveRenewRequest);
router.post('/order-approve', notifyOrderApprove);
router.post('/order-reject', notifyOrderReject);

export default router;
