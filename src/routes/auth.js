import { Router } from 'express';
import {
  register,
  login,
  refresh,
  getMe,
  getTeamMembers,
  getPocUsers,
  inviteUser,
  updateTeamMember,
  deleteTeamMember,
} from '../controllers/authController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.get('/me', authenticate, getMe);
router.get('/team', authenticate, authorize('admin', 'manager'), getTeamMembers);
router.get('/pocs', authenticate, getPocUsers);
router.post('/invite', authenticate, authorize('admin'), inviteUser);
router.put('/team/:id', authenticate, authorize('admin'), updateTeamMember);
router.delete('/team/:id', authenticate, authorize('admin'), deleteTeamMember);

export default router;
