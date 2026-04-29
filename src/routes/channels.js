import { Router } from 'express';
import multer from 'multer';
import {
  listChannels,
  addChannel,
  bulkImport,
  getChannel,
  updateChannel,
  deleteChannel,
  bulkDeleteChannels,
  bulkReclassifyChannelVideos,
  syncSingleChannel,
  syncAllChannels,
  pullAllChannelsVideosHandler,
  classifyAllChannelsVideos,
  getChannelVideos,
  classifyChannelVideos,
  reclassifyChannelVideos,
  pullChannelVideos,
} from '../controllers/channelController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticate);

router.get('/', listChannels);
router.post('/', authorize('admin', 'manager'), addChannel);
router.post('/bulk', authorize('admin', 'manager'), upload.single('file'), bulkImport);
router.delete('/bulk', authorize('admin'), bulkDeleteChannels);
router.post('/reclassify-bulk', authorize('admin'), bulkReclassifyChannelVideos);
router.post('/sync-all', authorize('admin', 'manager'), syncAllChannels);
router.post('/pull-all-videos', authorize('admin', 'manager'), pullAllChannelsVideosHandler);
router.post('/classify-all', authorize('admin', 'manager'), classifyAllChannelsVideos);

router.get('/:id', getChannel);
router.put('/:id', authorize('admin', 'manager'), updateChannel);
router.delete('/:id', authorize('admin'), deleteChannel);
router.post('/:id/sync', authorize('admin', 'manager'), syncSingleChannel);
router.post('/:id/pull-videos', authorize('admin', 'manager'), pullChannelVideos);
router.post('/:id/classify-videos', authorize('admin', 'manager'), classifyChannelVideos);
router.post('/:id/reclassify-videos', authorize('admin'), reclassifyChannelVideos);
router.get('/:id/videos', getChannelVideos);

export default router;
