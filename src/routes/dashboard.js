import { Router } from 'express';
import {
  getSummary,
  getGrowthData,
  getTopChannels,
  getTopVideos,
  getCategoryBreakdown,
  getMicroUnitsReport,
  getPublishingFrequency,
  getChannelMetrics,
  getGradeGrid,
  getLayout,
  saveLayout,
} from '../controllers/dashboardController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/summary', getSummary);
router.get('/growth', getGrowthData);
router.get('/top-channels', getTopChannels);
router.get('/top-videos', getTopVideos);
router.get('/categories', getCategoryBreakdown);
router.get('/micro-units-report', getMicroUnitsReport);
router.get('/publishing', getPublishingFrequency);
router.get('/channel-metrics', getChannelMetrics);
router.get('/grade-grid', getGradeGrid);
router.get('/layout', getLayout);
router.put('/layout', authorize('admin', 'manager'), saveLayout);

export default router;
