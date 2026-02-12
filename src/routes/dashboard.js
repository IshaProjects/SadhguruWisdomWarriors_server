import { Router } from 'express';
import {
  getSummary,
  getGrowthData,
  getTopChannels,
  getTopVideos,
  getCategoryBreakdown,
  getPublishingFrequency,
} from '../controllers/dashboardController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/summary', getSummary);
router.get('/growth', getGrowthData);
router.get('/top-channels', getTopChannels);
router.get('/top-videos', getTopVideos);
router.get('/categories', getCategoryBreakdown);
router.get('/publishing', getPublishingFrequency);

export default router;
