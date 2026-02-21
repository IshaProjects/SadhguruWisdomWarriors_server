import { Router } from 'express';
import {
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
} from '../controllers/categoryController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/',         listCategories);
router.post('/',        authorize('admin', 'manager'), createCategory);
router.put('/:name',    authorize('admin', 'manager'), renameCategory);
router.delete('/:name', authorize('admin', 'manager'), deleteCategory);

export default router;
