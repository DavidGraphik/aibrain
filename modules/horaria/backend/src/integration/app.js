import '../utils/zonaHoraria.js';
import express from 'express';
import helmet from 'helmet';
import { MetaInbox, metaMessages } from './meta-inbox.js';
import { processCloudMessage } from '../controllers/whatsapp.js';
import { stateDirectory } from './durable-state.js';
import { aiIdentity, authorizeWhatsApp } from './providers.js';
import rateLimit from 'express-rate-limit';
import { requireEstablishmentAccess, requireRole } from '../middleware/roles.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { previewHandler, publishHandler } from './preview.js';
import { draftHandler } from './draft.js';
import { createReadinessHandler } from './readiness.js';
import { createReviewedScheduleHandlers } from './reviewed-schedules.js';
import { collectionTemplateHandler, collectionResponseHandler, collectionExportHandler } from './collection.js';
import { verifyInbound } from './webhook.js';
import { createVerifier } from './signature.js';
import { prisma } from '../services/prisma.js';
import establishments from '../routes/establishments.js';
import employees from '../routes/employees.js';
import preferences from '../routes/preferences.js';
import rules from '../routes/rules.js';
import freeRules from '../routes/freeRules.js';
import schedules from '../routes/schedules.js';
import whatsapp from '../routes/whatsapp.js';
import absences from '../routes/absences.js';
import summary from '../routes/summary.js';
import ajustes from '../routes/ajustos.js';
import errors from '../routes/errors.js';

export function createHorariaApp({ secret, installationId, database = prisma, messageHandler = processCloudMessage, authorizeEventIdentity = authorizeWhatsApp }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));
  const verify = createVerifier({ secret, installationId });
  let writes = Promise.resolve();
  const lockWrite = async () => {
    const previous = writes;
    let release;
    writes = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  };
  const authorizeEvent = async identity => {
    if (!identity.actorId || !Number.isSafeInteger(identity.employeeId)) throw new Error('Missing event identity');
    const employee = await database.employee.findUnique({ where: { id: identity.employeeId } });
    if (!employee?.activo || employee.rol !== 'MANAGER_GENERAL') throw new Error('WhatsApp needs an active general manager');
    await authorizeEventIdentity(identity);
  };
  let inbox;
  if (process.env.HORARIA_ALLOW_DELIVERY === '1' && (process.env.WHATSAPP_PROVIDER || 'meta') === 'meta' && process.env.HORARIA_STATE_ROOT) {
    inbox = new MetaInbox({ root: stateDirectory(), installationId, authorize: authorizeEvent,
      processMessage: async (message, identity) => {
        const release = await lockWrite();
        try {
          await authorizeEvent(identity);
          return await aiIdentity.run({ ...identity, kind: 'user', source: 'whatsapp' }, () => messageHandler(message));
        }
        finally { release(); }
      },
      onError: reason => console.error('[WhatsApp inbox]', reason),
    });
    // Resume only after the HTTP service can answer the authorization callback.
  }
  app.locals.startInbox = () => inbox?.kick();
  app.locals.stopInbox = () => inbox?.stop();

  app.get('/health', (_req, res) => res.json({ ok: true, installationId }));
  app.get('/health/ready', async (_req, res) => {
    try { await database.$queryRaw`SELECT 1`; res.json({ ok: true, installationId }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.use(express.raw({ type: () => true, limit: '16mb' }));
  app.use(async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const contentType = req.get('content-type') || '';
      const claims = verify(req.get('x-aibrain-authorization'), { method: req.method, target: req.originalUrl, contentType, body: bytes });
      req.horariaClaims = claims;
      req.rawBody = bytes;
      req.body = {};
      if (bytes.length) {
        if (contentType.startsWith('application/json')) req.body = JSON.parse(bytes.toString());
        else if (contentType.startsWith('application/x-www-form-urlencoded')) req.body = Object.fromEntries(new URLSearchParams(bytes.toString()));
        else if (contentType.startsWith('multipart/form-data;')) {
          const form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
          req.horariaUploads = [];
          for (const [field, value] of form) {
            if (typeof value === 'string') req.body[field] = value;
            else req.horariaUploads.push({ fieldname: field, originalname: value.name, mimetype: value.type, size: value.size, buffer: Buffer.from(await value.arrayBuffer()) });
          }
        } else return res.status(415).json({ error: 'Unsupported request body' });
      }
      if (claims.kind === 'event') {
        const webhook = req.path === '/api/whatsapp/webhook';
        const media = /^\/api\/schedules\/published-pdf\/[a-zA-Z0-9_-]+$/.test(req.path) && ['GET', 'HEAD'].includes(req.method);
        if ((!webhook && !media) || process.env.HORARIA_ALLOW_DELIVERY !== '1') return res.sendStatus(403);
        if (webhook && req.method === 'POST') {
          if (!verifyInbound(req)) return res.sendStatus(403);
          if ((process.env.WHATSAPP_PROVIDER || 'meta') === 'meta') {
            if (!inbox) return res.sendStatus(503);
            let messages;
            try { messages = metaMessages(req.body, { wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID, phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID }); }
            catch { return res.sendStatus(403); }
            if (!claims.actorId || !Number.isSafeInteger(claims.employeeId)) return res.sendStatus(403);
            try { inbox.enqueue(messages, claims); }
            catch { return res.sendStatus(503); }
            return res.sendStatus(200);
          }
        }
        return next();
      }
      if (claims.kind === 'scheduler') {
        if (req.path !== '/api/whatsapp/heartbeat' || req.method !== 'POST' || process.env.HORARIA_ALLOW_DELIVERY !== '1') return res.sendStatus(403);
        req.headers['x-reminder-secret'] = process.env.WEEKLY_REMINDER_SECRET;
        return next();
      }
      if (/^\/api\/whatsapp\/(webhook|mock|weekly-reminder|health-check|auto-broadcast|auto-reminders|heartbeat|watchdog)(\/|$)/.test(req.path)) return res.sendStatus(403);
      const employee = await database.employee.findUnique({ where: { id: claims.employeeId } });
      if (!employee?.activo || !['MANAGER_GENERAL', 'MANAGER_LOCAL'].includes(employee.rol)) return res.sendStatus(403);
      const managed = employee.rol === 'MANAGER_LOCAL' ? await database.establishment.findMany({ where: { managerLocalId: employee.id }, select: { id: true } }) : [];
      req.user = { id: employee.id, nombre: employee.nombre, apellidos: employee.apellidos, email: employee.email, rol: employee.rol, establecimientos: managed.map(e => e.id) };
      aiIdentity.run(claims, next);
    } catch {
      res.status(401).json({ error: 'No s’ha pogut validar l’accés a horarIA.' });
    }
  });
  app.get('/api/integration/whatsapp-inbox', requireRole('MANAGER_GENERAL'), (_req, res) => res.json({ enabled: !!inbox, counts: inbox?.summary() || {} }));
  // Serialize foreground writes so a reviewed publish cannot race a manual edit.
  app.use((req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method) || ['/api/integration/draft', '/api/integration/collection-preview'].includes(req.path)) return next();
    lockWrite().then(release => {
      if (res.destroyed) return release();
      res.once('finish', release); res.once('close', release);
      next();
    });
  });
  app.use('/api/schedules/generate-async', rateLimit({ windowMs: 3_600_000, limit: 20, keyGenerator: req => String(req.user?.id || 'anonymous'), standardHeaders: 'draft-7', legacyHeaders: false }));
  app.get('/api/session', (req, res) => res.json({ user: req.user, capabilities: { ai: process.env.HORARIA_ALLOW_AI === '1', delivery: process.env.HORARIA_ALLOW_DELIVERY === '1' } }));
  app.get('/api/integration/preview', requireEstablishmentAccess, asyncHandler(previewHandler));
  app.get('/api/integration/readiness', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess, asyncHandler(createReadinessHandler({ database })));
  const reviewed = createReviewedScheduleHandlers({ database });
  for (const [route, handler] of [['review-source', reviewed.source], ['reviewed-excel', reviewed.review], ['reviewed-excel-send', reviewed.send]]) {
    app.post(`/api/integration/${route}`, requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess, asyncHandler(handler));
  }
  app.get('/api/integration/reviewed-excel/:id', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess, asyncHandler(reviewed.status));
  app.get('/api/integration/collection-template', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess, asyncHandler(collectionTemplateHandler));
  app.get('/api/integration/collection-export', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess, asyncHandler(collectionExportHandler));
  app.post('/api/integration/collection-preview', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess, asyncHandler(collectionResponseHandler));
  app.post('/api/integration/draft', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess,
    rateLimit({ windowMs: 3_600_000, limit: 20, keyGenerator: req => String(req.user.id), standardHeaders: 'draft-7', legacyHeaders: false }), asyncHandler(draftHandler));
  app.post('/api/integration/publish', requireRole('MANAGER_GENERAL', 'MANAGER_LOCAL'), requireEstablishmentAccess, asyncHandler(publishHandler));
  const routes = { establishments, employees, preferences, rules, 'free-rules': freeRules, schedules, whatsapp, absences, summary, ajustes, errors };
  for (const [name, router] of Object.entries(routes)) app.use(`/api/${name}`, router);
  app.use('/api', (_req, res) => res.sendStatus(404));
  app.use((_req, res) => res.sendStatus(404));
  app.use((error, _req, res, _next) => {
    res.status(error.status === 413 ? 413 : 500).json({ error: 'No s’ha pogut completar l’operació d’horaris.' });
  });
  return app;
}
