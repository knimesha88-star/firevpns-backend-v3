import { Router } from 'express';
import { 
  getMyConfigs, 
  claimTrial, 
  getClaimedTrials,
  resetTraffic,
  getResetTrafficStatus,
  getTrafficResetPolicyHandler,
  trackOrder
} from '../controllers/vpnController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { turnstileMiddleware } from '../middleware/turnstileMiddleware.js';
import {
  getPublicActiveDiscountsHandler,
  validateOrderPriceHandler,
} from '../controllers/discountController.js';
import {
  getPublicActiveSpecialOffersHandler,
  validateSpecialOfferPriceHandler,
} from '../controllers/specialOfferController.js';
import {
  getPaymentSlipSignedUrlHandler,
  uploadPaymentSlipHandler,
} from '../controllers/paymentSlipController.js';

const router = Router();

// Publicly accessible store discount, special offer & price verification routes
router.get('/discounts/active', getPublicActiveDiscountsHandler);
router.get('/special-offers/active', getPublicActiveSpecialOffersHandler);
router.post('/special-offers/validate-price', validateSpecialOfferPriceHandler);
router.post('/validate-order-price', validateOrderPriceHandler);

router.use(authMiddleware);

router.get('/my-configs', getMyConfigs);
router.get('/claimed-trials', getClaimedTrials);
router.post('/claim-trial', turnstileMiddleware, claimTrial);

// Track Order Provisioning Status
router.get('/track-order/:orderId', trackOrder);
router.get('/track-order', trackOrder);

// Customer Self-Service Traffic Reset
router.post('/reset-traffic', resetTraffic);
router.post('/reset-data', resetTraffic);
router.get('/reset-traffic-status/:uuid', getResetTrafficStatus);
router.get('/reset-policy', getTrafficResetPolicyHandler);

// Private Payment Slips Signed URL & Upload routes
router.get('/payment-slips/signed-url', getPaymentSlipSignedUrlHandler);
router.post('/payment-slips/signed-url', getPaymentSlipSignedUrlHandler);
router.post('/payment-slips/upload', uploadPaymentSlipHandler);

export default router;


