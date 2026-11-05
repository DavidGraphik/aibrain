import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireEstablishmentAccess} from '../middleware/roles.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getFreeRules, createFreeRule, updateFreeRule, deleteFreeRule } from '../controllers/freeRules.js';

const router = Router();

router.use(requireAuth);

router.get('/', requireEstablishmentAccess, asyncHandler(getFreeRules));
router.post('/', requireEstablishmentAccess, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(createFreeRule));
router.put('/:id', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(updateFreeRule));
router.delete('/:id', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(deleteFreeRule));

export default router;
