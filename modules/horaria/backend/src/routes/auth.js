import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { login, logout } from '../controllers/auth.js';

const router = Router();

router.post('/login', asyncHandler(login));
router.post('/logout', asyncHandler(logout));

export default router;
