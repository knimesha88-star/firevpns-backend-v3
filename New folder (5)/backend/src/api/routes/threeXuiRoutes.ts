import { Router } from 'express';
import { getServerStatus, testConnection, saveSettings, deleteSettings } from '../controllers/xuiController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';

const router = Router();

router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/status', getServerStatus);
router.post('/test', testConnection);
router.post('/settings', saveSettings);
router.delete('/settings', deleteSettings);

export default router;
