import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireEstablishmentParam } from '../middleware/roles.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getAll,
  getOne,
  create,
  update,
} from '../controllers/establishments.js';

const router = Router();

router.use(requireAuth);

router.get('/', asyncHandler(getAll));
router.get('/:id', requireEstablishmentParam, asyncHandler(getOne));
router.post('/', requireRole('MANAGER_GENERAL'), asyncHandler(create));
router.put('/:id', requireRole('MANAGER_GENERAL'), asyncHandler(update));

export default router;
