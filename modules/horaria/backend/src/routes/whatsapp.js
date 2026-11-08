import { Router } from 'express';
import multer from '../integration/upload.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireEstablishmentAccess } from '../middleware/roles.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { verifyWebhook, receiveMessage, broadcast, getStatus, sendRemindersHandler, mockIncoming, mockAudioIncoming, mockPaperIncoming, mockLog, mockConfig, mockResetHandler, getConversationByPhoneHandler, weeklyReminderHandler, healthCheckHandler, autoBroadcastHandler, autoRemindersHandler, watchdogHandler, heartbeatHandler, configCheck, unblockConversation } from '../controllers/whatsapp.js';

const router = Router();

// Multipart audio uploads (max 5 MB ≈ a few minutes of voice)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
// Multipart image uploads (paper-sheet photos can be larger)
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

// Public — Meta verification & incoming messages
router.get('/webhook', verifyWebhook);
// Amb asyncHandler com la resta. Avui no pot tombar el procés perquè tot el que
// fa `await` ja està dins dels seus propis try/catch, però era l'únic handler
// async del projecte que depenia d'això — i per aquí entra cada missatge dels
// treballadors. Un `await` afegit fora d'aquells blocs tornaria a deixar una
// promesa rebutjada sense capturar, que des de Node 15 tomba el servidor.
router.post('/webhook', asyncHandler(receiveMessage));

// Protected — manager actions
router.post('/broadcast', requireAuth, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess, asyncHandler(broadcast));
router.post('/reminders', requireAuth, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess, asyncHandler(sendRemindersHandler));
router.get('/status', requireAuth, requireEstablishmentAccess, asyncHandler(getStatus));
router.get('/config-check', requireAuth, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(configCheck));
router.post('/unblock', requireAuth, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), asyncHandler(unblockConversation));

// Conversation detail for managers (used by the simulator and viewer)
router.get('/conversation', requireAuth, asyncHandler(getConversationByPhoneHandler));

// Called by an external scheduler (GitHub Actions), authenticated with a shared
// secret rather than a session — there is no logged-in user behind it.
router.post('/weekly-reminder', asyncHandler(weeklyReminderHandler));

// Daily, from the same scheduler. Answers 503 when something is broken so the
// scheduler's own failure email becomes a second, WhatsApp-independent alarm.
router.post('/health-check', asyncHandler(healthCheckHandler));
router.post('/auto-broadcast', asyncHandler(autoBroadcastHandler));
router.post('/auto-reminders', asyncHandler(autoRemindersHandler));
// El batec: cada hora, i decideix ell mateix si toca enviar res.
router.post('/heartbeat', asyncHandler(heartbeatHandler));
// El vigilant: corre un dia després del broadcast i comprova que va sortir.
router.post('/watchdog', asyncHandler(watchdogHandler));

// Both jobs above must be POST. A GET falls through to the frontend and comes
// back as 200 with the app's HTML, so a cron configured with the wrong method
// reports success forever while nothing runs — which already cost us hours
// once. Fail loudly instead.
const soloPost = (req, res) => res.status(405).json({
  error: 'Aquest endpoint només accepta POST. Revisa el mètode del cron.',
});
router.get('/weekly-reminder', soloPost);
router.get('/health-check', soloPost);
router.get('/auto-broadcast', soloPost);
router.get('/auto-reminders', soloPost);
router.get('/heartbeat', soloPost);
router.get('/watchdog', soloPost);

// Mock/dev endpoints
router.get('/mock/config', mockConfig);
router.post('/mock/incoming', asyncHandler(mockIncoming));
router.post('/mock/audio', upload.single('audio'), asyncHandler(mockAudioIncoming));
router.post('/mock/paper', uploadImage.single('imagen'), asyncHandler(mockPaperIncoming));
router.get('/mock/log', asyncHandler(mockLog));
router.post('/mock/reset', asyncHandler(mockResetHandler));

export default router;
