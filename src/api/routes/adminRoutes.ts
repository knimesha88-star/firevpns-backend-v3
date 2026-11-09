import { Router } from 'express';
import {
  getStats,
  getUsers,
  approveOrder,
  rejectOrder,
  verifyPayment,
  publishAnnouncementNotification,
  getEmailSettingsHandler,
  saveEmailSettingsHandler,
  getEmailLogsHandler,
  sendTestEmailHandler
} from '../controllers/adminController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';

const router = Router();

router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/stats', getStats);
router.get('/users', getUsers);
router.post('/approve-order', approveOrder);
router.post('/orders/:orderId/approve', approveOrder);
router.post('/verify-payment', verifyPayment);
router.post('/orders/:orderId/verify-payment', verifyPayment);
router.post('/reject-order', rejectOrder);
router.post('/orders/:orderId/reject', rejectOrder);
router.post('/announcements/notify', publishAnnouncementNotification);

// Email Notification routes
router.get('/email/settings', getEmailSettingsHandler);
router.post('/email/settings', saveEmailSettingsHandler);
router.get('/email/logs', getEmailLogsHandler);
router.post('/email/test', sendTestEmailHandler);

// Traffic Reset Policy routes
import { getTrafficResetPolicyHandler, saveTrafficResetPolicyHandler } from '../controllers/vpnController.js';
router.get('/traffic-reset-policy', getTrafficResetPolicyHandler);
router.post('/traffic-reset-policy', saveTrafficResetPolicyHandler);

// Discount & Package Pricing Management routes
import {
  getAdminDiscountsHandler,
  createAdminDiscountHandler,
  updateAdminDiscountHandler,
  toggleAdminDiscountHandler,
  deleteAdminDiscountHandler,
  saveAdminPricingHandler,
  invalidateAdminPricingHandler,
} from '../controllers/discountController.js';
router.get('/discounts', getAdminDiscountsHandler);
router.post('/discounts', createAdminDiscountHandler);
router.put('/discounts/:id', updateAdminDiscountHandler);
router.put('/discounts/:id/status', toggleAdminDiscountHandler);
router.post('/discounts/:id/status', toggleAdminDiscountHandler);
router.patch('/discounts/:id/status', toggleAdminDiscountHandler);
router.delete('/discounts/:id', deleteAdminDiscountHandler);
router.post('/pricing', saveAdminPricingHandler);
router.post('/pricing/invalidate', invalidateAdminPricingHandler);

// Special Offers Management routes (Admin only)
import {
  getAdminSpecialOffersHandler,
  createAdminSpecialOfferHandler,
  updateAdminSpecialOfferHandler,
  toggleAdminSpecialOfferHandler,
  deleteAdminSpecialOfferHandler,
} from '../controllers/specialOfferController.js';
import { getPaymentSlipSignedUrlHandler } from '../controllers/paymentSlipController.js';
router.get('/special-offers', getAdminSpecialOffersHandler);
router.post('/special-offers', createAdminSpecialOfferHandler);
router.put('/special-offers/:id', updateAdminSpecialOfferHandler);
router.put('/special-offers/:id/status', toggleAdminSpecialOfferHandler);
router.post('/special-offers/:id/status', toggleAdminSpecialOfferHandler);
router.patch('/special-offers/:id/status', toggleAdminSpecialOfferHandler);
router.delete('/special-offers/:id', deleteAdminSpecialOfferHandler);

// Admin Payment Slips Signed URL routes
router.get('/payment-slips/signed-url', getPaymentSlipSignedUrlHandler);
router.post('/payment-slips/signed-url', getPaymentSlipSignedUrlHandler);

export default router;





