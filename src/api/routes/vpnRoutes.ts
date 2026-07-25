import { Router } from 'express';
import { getMyConfigs, claimTrial, getClaimedTrials } from '../controllers/vpnController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authMiddleware);

router.get('/my-configs', getMyConfigs);
router.get('/claimed-trials', getClaimedTrials);
router.post('/claim-trial', claimTrial);

export default router;
