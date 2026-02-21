import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  getVideoSnapshots,
  getChannelVideoTrends,
} from '../controllers/videoSnapshotController.js';

const router = Router();

// All endpoints require authentication
router.use(authenticate);

// GET /api/video-snapshots/video/:videoId
router.get('/video/:videoId', getVideoSnapshots);

// GET /api/video-snapshots/channel/:channelId
router.get('/channel/:channelId', getChannelVideoTrends);

export default router;
