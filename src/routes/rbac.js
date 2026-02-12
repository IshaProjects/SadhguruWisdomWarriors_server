import { Router } from 'express';
import { getRbacConfig, updateRbacConfig } from '../controllers/rbacController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// Any authenticated user can read the config (client needs it to show/hide UI)
router.get('/', getRbacConfig);

// Only admins can update it
router.put('/', authorize('admin'), updateRbacConfig);

export default router;
