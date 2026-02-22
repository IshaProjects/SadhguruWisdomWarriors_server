import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import {
  listQueue,
  addToQueue,
  removeFromQueue,
  updateStatus,
  processQueue,
  chatProxy,
} from '../controllers/videoQueueController.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Queue management
router.get('/',              listQueue);
router.post('/',             authorize('admin', 'manager'), addToQueue);
router.delete('/:id',        authorize('admin', 'manager'), removeFromQueue);
router.patch('/:id/status',  authorize('admin', 'manager'), updateStatus);

// Trigger sequential ingestion
router.post('/process',      authorize('admin'), processQueue);

// RAG chat proxy
router.post('/chat',         chatProxy);

export default router;
