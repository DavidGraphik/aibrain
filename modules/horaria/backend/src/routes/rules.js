import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireEstablishmentAccess} from '../middleware/roles.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getRules, createRule, updateRule, deleteRule } from '../controllers/rules.js';

const router = Router();

router.use(requireAuth);

router.get('/', requireEstablishmentAccess, asyncHandler(getRules));
router.post('/', requireEstablishmentAccess, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(createRule));
router.put('/:id', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(updateRule));
router.delete('/:id', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(deleteRule));

export default router;
