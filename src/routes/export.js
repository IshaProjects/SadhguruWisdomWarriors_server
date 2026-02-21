import { Router } from 'express';
import { exportChannelsCSV, reportChannels, reportVideos } from '../controllers/exportController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// Legacy endpoint (backward compat)
router.get('/channels', exportChannelsCSV);

// Report endpoints (JSON preview + CSV + Excel)
router.get('/report/channels', reportChannels);
router.get('/report/videos',   reportVideos);

export default router;
