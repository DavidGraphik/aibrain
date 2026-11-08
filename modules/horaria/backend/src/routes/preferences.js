import { Router } from 'express';
import multer from '../integration/upload.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireEstablishmentAccess} from '../middleware/roles.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPreferences, updatePreference, getPaperSheets, getPaperSheetImage, uploadPaperSheet } from '../controllers/preferences.js';

const router = Router();

// La foto d'un full: una foto de mòbil no arriba a 10 MB ni fent-la de prop.
const uploadFull = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAuth);

router.get('/', requireEstablishmentAccess, asyncHandler(getPreferences));
router.get('/sheets', requireEstablishmentAccess, asyncHandler(getPaperSheets));
router.get('/sheets/:id/image', asyncHandler(getPaperSheetImage));
// Sense requireEstablishmentAccess a posta: la botiga la diu el full, i no se
// sap fins que la IA n'ha llegit la capçalera. Es comprova a dins.
router.post('/sheets', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), uploadFull.single('imagen'), asyncHandler(uploadPaperSheet));
router.put('/:empleadoId', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(updatePreference));

export default router;
