import { Router } from 'express';
import {
  listMicroUnits,
  createMicroUnit,
  getMicroUnit,
  updateMicroUnit,
  assignPoc,
  deleteMicroUnit,
} from '../controllers/microUnitController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/', listMicroUnits);
router.post('/', authorize('admin', 'manager'), createMicroUnit);
router.get('/:id', getMicroUnit);
router.put('/:id', authorize('admin', 'manager'), updateMicroUnit);
router.put('/:id/poc', authorize('admin', 'manager'), assignPoc);
router.delete('/:id', authorize('admin', 'manager'), deleteMicroUnit);

export default router;
