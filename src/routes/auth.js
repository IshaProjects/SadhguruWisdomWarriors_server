import { Router } from 'express';
import { register, login, refresh, getMe, getTeamMembers, inviteUser } from '../controllers/authController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.get('/me', authenticate, getMe);
router.get('/team', authenticate, authorize('admin', 'manager'), getTeamMembers);
router.post('/invite', authenticate, authorize('admin'), inviteUser);

export default router;
