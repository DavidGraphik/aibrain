import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireEstablishmentAccess } from '../middleware/roles.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getAll,
  getOne,
  create,
  importEmployees,
  update,
  remove,
  updateAllowedEstablishments,
  tradueixLesCondicions,
} from '../controllers/employees.js';

const router = Router();

router.use(requireAuth);

router.get('/', asyncHandler(getAll));
router.get('/:id', asyncHandler(getOne));
router.post('/', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(create));
router.post('/import', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess, asyncHandler(importEmployees));
router.put('/:id', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(update));
router.delete('/:id', requireRole('MANAGER_GENERAL'), asyncHandler(remove));
// La traducció NO desa: ensenya què entén perquè una persona ho validi.
router.post('/:id/condicions/tradueix', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(tradueixLesCondicions));
router.put('/:id/allowed-establishments', requireRole('MANAGER_GENERAL'), asyncHandler(updateAllowedEstablishments));

export default router;
