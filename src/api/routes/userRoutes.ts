import { Router } from 'express';
import { 
  getProfile, 
  updateProfile, 
  getNotifications, 
  readNotification, 
  deleteAllNotifications,
  notifySupportTicket, 
  notifySupportTicketReply, 
  notifyLiveChat 
} from '../controllers/userController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';
import { turnstileMiddleware } from '../middleware/turnstileMiddleware.js';
import { supportRateLimit } from '../middleware/rateLimitMiddleware.js';

const router = Router();

// Public support submission endpoint protected by Cloudflare Turnstile and rate limiting
router.post('/support/public', supportRateLimit, turnstileMiddleware, notifySupportTicket);

router.use(authMiddleware);

router.get('/profile', getProfile);
router.put('/profile', updateProfile);

router.get('/notifications', getNotifications);
router.post('/notifications/:id/read', readNotification);
router.delete('/notifications', deleteAllNotifications);

router.get('/downloads', (_req, res) => {
  res.json({
    windows: { version: '2.1.0', url: '#' },
    mac: { version: '2.0.5', url: '#' },
    android: { version: '3.1.2', url: '#' },
    ios: { version: '3.1.0', url: '#' },
    linux: { version: '1.5.0', url: '#' },
    router: { version: '1.0.0', url: '#' }
  });
});

router.get('/support', (_req, res) => {
  res.json({
    tickets: []
  });
});

router.post('/support/notify', supportRateLimit, turnstileMiddleware, notifySupportTicket);
router.post('/support/reply', supportRateLimit, adminMiddleware, notifySupportTicketReply);
router.post('/livechat/notify', supportRateLimit, notifyLiveChat);

export default router;

