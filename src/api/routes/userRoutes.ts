import { Router } from 'express';
import { getProfile, updateProfile } from '../controllers/userController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authMiddleware);

router.get('/profile', getProfile);
router.put('/profile', updateProfile);

router.get('/downloads', (req, res) => {
  res.json({
    windows: { version: '2.1.0', url: '#' },
    mac: { version: '2.0.5', url: '#' },
    android: { version: '3.1.2', url: '#' },
    ios: { version: '3.1.0', url: '#' },
    linux: { version: '1.5.0', url: '#' },
    router: { version: '1.0.0', url: '#' }
  });
});

router.get('/support', (req, res) => {
  res.json({
    tickets: []
  });
});

export default router;
