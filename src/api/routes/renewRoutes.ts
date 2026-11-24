import { Router } from 'express';
import {
  approveRenewRequest,
  rejectRenewRequest,
  createRenewRequest,
  validateRenewPrice,
  createOrder,
  createOrderNotification,
  notifyOrderApprove,
  notifyOrderReject
} from '../controllers/renewController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';
import { orderRateLimit } from '../middleware/rateLimitMiddleware.js';
import { turnstileMiddleware } from '../middleware/turnstileMiddleware.js';

const router = Router();

// Protect renewal and order endpoints with authentication
router.use(authMiddleware);

// Endpoint for customers to authoritatively validate renewal duration & Special Offer pricing
router.post('/validate-price', validateRenewPrice);

// Authoritative server-side order creation endpoint (computes verified prices and enforces pending status)
router.post('/orders', orderRateLimit, turnstileMiddleware, createOrder);

// Endpoint for customers to submit / notify new renewal request (authoritative server-side insert/sync)
router.post('/request', orderRateLimit, createRenewRequest);

// Endpoint for customers to send new order notification (ownership-verified)
router.post('/order-notify', orderRateLimit, createOrderNotification);

// Admin-only endpoints
router.use(adminMiddleware);

router.post('/approve/:requestId', approveRenewRequest);
router.post('/reject/:requestId', rejectRenewRequest);
router.post('/order-approve', notifyOrderApprove);
router.post('/order-reject', notifyOrderReject);

export default router;


