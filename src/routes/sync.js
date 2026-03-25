import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import {
  getStatus,
  getLogs,
  triggerChannelSync,
  triggerVideoSync,
  triggerIhiIngest,
  triggerIhiSadhguruStats,
  getConfig,
  updateConfig,
} from '../controllers/syncController.js';

const router = Router();
router.use(authenticate);

router.get('/status', getStatus);
router.get('/logs', getLogs);
router.post('/channels/trigger', authorize('admin', 'manager'), triggerChannelSync);
router.post('/videos/trigger', authorize('admin', 'manager'), triggerVideoSync);
router.post(
  '/ihi/ingest/trigger',
  authorize('admin', 'manager'),
  triggerIhiIngest
);
router.post(
  '/ihi/sadhguru-stats/trigger',
  authorize('admin', 'manager'),
  triggerIhiSadhguruStats
);
router.get('/config', getConfig);
router.put('/config', authorize('admin'), updateConfig);

export default router;
