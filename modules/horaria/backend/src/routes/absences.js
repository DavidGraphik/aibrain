import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getAbsences, createAbsence, updateAbsence, deleteAbsence, getAbsencesForWeek, getVacationBalance, importHolidays, getMunicipis } from '../controllers/absences.js';

const router = Router();

// All absence endpoints require an authenticated user (mirrors employees/schedules routers)
router.use(requireAuth);

// Amb asyncHandler, com la resta de routers. Aquest era l'únic fitxer de rutes
// del projecte que no el portava: qualsevol error dins d'un handler async
// —Prisma rebutjant un id que no és un número, per exemple— quedava com una
// promesa rebutjada sense capturar, i des de Node 15 això no tomba la petició
// sinó el procés sencer. Una encarregada, o simplement un formulari que envia
// un camp buit, podia deixar tota l'app sense servei.
router.get('/', asyncHandler(getAbsences));
router.get('/week', asyncHandler(getAbsencesForWeek));
router.get('/balance', asyncHandler(getVacationBalance));
router.get('/municipis', asyncHandler(getMunicipis));
router.post('/', asyncHandler(createAbsence));
router.post('/import-holidays', asyncHandler(importHolidays));
router.put('/:id', asyncHandler(updateAbsence));
router.delete('/:id', asyncHandler(deleteAbsence));

export default router;
