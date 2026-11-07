import { Router } from 'express';
import multer from '../integration/upload.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireEstablishmentAccess} from '../middleware/roles.js';
import { getCorrecciones, saveCorreccionMotivo } from '../controllers/correccions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getSchedules,
  createShift,
  updateShift,
  publishSchedule,
  generateSchedule,
  generateScheduleAsync,
  generateScheduleStatus,
  getGenerationReport,
  getWeekIntensity,
  setWeekIntensity,
  getClosedDays,
  getPublishedPdf,
  checkEstablishmentConflicts,
  historialCanvis,
  getOtherEstablishmentHours,
  getFairness,
  getLearnedPatterns,
} from '../controllers/schedules.js';

const router = Router();

// Schedule PDF upload when publishing (a week's PDF is well under 5 MB)
const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Public: WhatsApp/Twilio fetches the published PDF by unguessable token.
// Declared BEFORE requireAuth so the media server can reach it.
router.get('/published-pdf/:token', getPublishedPdf);

router.use(requireAuth);

router.get('/', requireEstablishmentAccess, asyncHandler(getSchedules));
router.get('/conflicts', requireEstablishmentAccess, asyncHandler(checkEstablishmentConflicts));
router.get('/other-hours', requireEstablishmentAccess, asyncHandler(getOtherEstablishmentHours));
router.get('/fairness', requireEstablishmentAccess, asyncHandler(getFairness));
router.get('/edit-patterns', requireEstablishmentAccess, asyncHandler(getLearnedPatterns));
router.get('/correcciones', requireEstablishmentAccess, asyncHandler(getCorrecciones));
// Qui va canviar què: les dades ja es desaven des del primer dia, el que
// faltava era poder-les mirar.
router.get('/historial', requireEstablishmentAccess, asyncHandler(historialCanvis));
router.post('/correcciones', requireEstablishmentAccess, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(saveCorreccionMotivo));
router.post('/', requireEstablishmentAccess, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(createShift));
router.post('/generate', requireEstablishmentAccess, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(generateSchedule));
// Async generation: start a background job and poll its status (avoids browser/proxy timeouts)
router.post('/generate-async', requireEstablishmentAccess, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(generateScheduleAsync));
router.get('/generate-status/:jobId', asyncHandler(generateScheduleStatus));
router.get('/report', requireEstablishmentAccess, asyncHandler(getGenerationReport));
router.get('/intensity', requireEstablishmentAccess, asyncHandler(getWeekIntensity));
router.get('/closed-days', requireEstablishmentAccess, asyncHandler(getClosedDays));
router.post('/intensity', requireEstablishmentAccess, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(setWeekIntensity));
router.put('/:id', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(updateShift));
// El guard va DESPRÉS de llegir el fitxer, i no abans com a la resta: aquesta
// ruta envia les dades dins d'un multipart, i fins que multer no l'ha llegit el
// cos de la petició és buit. Posat abans, la botiga no hi era, la guarda no
// trobava cap botiga i tancava — donant un 403 a l'encarregada en publicar.
router.post('/publish', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), uploadPdf.single('pdf'), requireEstablishmentAccess, asyncHandler(publishSchedule));

export default router;
