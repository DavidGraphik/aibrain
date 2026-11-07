import { requireEstablishmentAccess } from '../middleware/roles.js';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getWeekSummary } from '../controllers/summary.js';

const router = Router();

router.use(requireAuth);
router.get('/', requireEstablishmentAccess, asyncHandler(getWeekSummary));

export default router;
