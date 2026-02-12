import { Router } from 'express';
import { exportChannelsCSV } from '../controllers/exportController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/channels', exportChannelsCSV);

export default router;
