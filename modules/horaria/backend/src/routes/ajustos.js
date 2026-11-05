import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireEstablishmentAccess } from '../middleware/roles.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getAjustos, putAjustos } from '../controllers/ajustos.js';

const router = Router();
router.use(requireAuth);
router.get('/', requireEstablishmentAccess, asyncHandler(getAjustos));
router.put('/', requireRole('MANAGER_GENERAL'), requireEstablishmentAccess, asyncHandler(putAjustos));
export default router;
