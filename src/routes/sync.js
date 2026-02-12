import { Router } from 'express';
import { getStatus, getLogs } from '../controllers/syncController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/status', getStatus);
router.get('/logs', getLogs);

export default router;
