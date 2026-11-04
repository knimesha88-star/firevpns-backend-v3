import { Router } from 'express';
import { 
  getMyConfigs, 
  claimTrial, 
  getClaimedTrials,
  resetTraffic,
  getResetTrafficStatus,
  getTrafficResetPolicyHandler
} from '../controllers/vpnController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authMiddleware);

router.get('/my-configs', getMyConfigs);
router.get('/claimed-trials', getClaimedTrials);
router.post('/claim-trial', claimTrial);

// Customer Self-Service Traffic Reset
router.post('/reset-traffic', resetTraffic);
router.post('/reset-data', resetTraffic);
router.get('/reset-traffic-status/:uuid', getResetTrafficStatus);
router.get('/reset-policy', getTrafficResetPolicyHandler);

export default router;
