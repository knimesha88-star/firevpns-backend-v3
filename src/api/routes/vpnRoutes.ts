import { Router } from 'express';
import { getMyConfigs } from '../controllers/vpnController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authMiddleware);

router.get('/my-configs', getMyConfigs);

export default router;
