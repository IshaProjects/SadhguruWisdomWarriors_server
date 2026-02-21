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
  syncSingleChannel,
  syncAllChannels,
  getChannelVideos,
} from '../controllers/channelController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticate);

router.get('/', listChannels);
router.post('/', authorize('admin', 'manager'), addChannel);
router.post('/bulk', authorize('admin', 'manager'), upload.single('file'), bulkImport);
router.delete('/bulk', authorize('admin'), bulkDeleteChannels);
router.post('/sync-all', authorize('admin', 'manager'), syncAllChannels);

router.get('/:id', getChannel);
router.put('/:id', authorize('admin', 'manager'), updateChannel);
router.delete('/:id', authorize('admin'), deleteChannel);
router.post('/:id/sync', authorize('admin', 'manager'), syncSingleChannel);
router.get('/:id/videos', getChannelVideos);

export default router;
