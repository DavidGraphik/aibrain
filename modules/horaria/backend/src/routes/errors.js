import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { apuntaError, errorsRecents } from '../controllers/errors.js';

const router = Router();
router.use(requireAuth);
// Qualsevol que hagi entrat pot informar d'un error: l'error el pateix ell.
router.post('/', asyncHandler(apuntaError));
// Llegir-los és una altra cosa: les piles d'error ensenyen com és el sistema
// per dins, i això només ho ha de veure qui el porta.
router.get('/', requireRole('MANAGER_GENERAL'), asyncHandler(errorsRecents));
export default router;
