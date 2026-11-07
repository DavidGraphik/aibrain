import {
  handleIncomingMessage,
  handleNonTextMessage,
  handleAudioMessage,
  handlePaperImage,
  downloadTwilioMedia,
  startReplyCapture,
  endReplyCapture,
  broadcastPreferenceRequest,
  getConversationStatus,
  sendReminders,
  sendWeeklyBroadcastReminder,
  sendHealthAlert,
  getMockMessages,
  isMockMode, whatsappProvider,
  sendWhatsappMessage,
  mockReset,
  getConversationByPhone,
  broadcastAutomatic,
  recordatorisAutomatics,
  informaLaResponsable,
} from '../services/whatsapp.js';
import { revisaElCicleSetmanal, textAvis } from '../services/vigilant.js';
import { verifyMetaSignature } from '../utils/verifyMetaSignature.js';
import { prisma } from '../services/prisma.js';
import { nomIIdioma } from '../services/whatsapp.js';
import { readMetaTemplates } from '../integration/meta-templates.js';

// ─────────────────────────────────────────────
// WEBHOOK — Meta verification (GET)
// ─────────────────────────────────────────────
export function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && typeof token === 'string' && token === process.env.WHATSAPP_VERIFY_TOKEN && typeof challenge === 'string' && challenge.length <= 256) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'Token de verificación incorrecto' });
}

// ─────────────────────────────────────────────
// WEBHOOK — Receive incoming messages (POST)
// Deduplicate Meta webhook retries: Meta re-delivers the same message (same
// message.id) if our 200 is slow. Process each id once. In-memory is fine for a
// single server instance; entries older than the TTL are evicted.
const seenMessageIds = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000;
function alreadyProcessed(id) {
  if (!id) return false;
  const now = Date.now();
  if (seenMessageIds.size > 1000) {
    for (const [k, t] of seenMessageIds) if (now - t > DEDUP_TTL_MS) seenMessageIds.delete(k);
  }
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.set(id, now);
  return false;
}

// ─────────────────────────────────────────────
// Escape text for safe inclusion in a TwiML XML body
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export async function receiveMessage(req, res) {
  const body = req.body;

  // ── Twilio webhook (form-encoded, flat shape) ────────────────────────────
  // Twilio posts MessageSid/From/Body/NumMedia instead of Meta's nested JSON.
  // Replies must be returned as TwiML: answering via the REST API requires an
  // approved template (error 21654 "ContentSid Required").
  if (body?.MessageSid && body?.From) {
    console.log(`[Webhook] Twilio inbound sid=${body.MessageSid} from=${body.From} media=${body.NumMedia || 0} body="${(body.Body || '').slice(0, 40)}"`);
    const telefono = String(body.From).replace(/^whatsapp:/, '');
    const respondTwiml = (messages) => {
      const parts = (messages || []).map((m) => `<Message>${xmlEscape(m)}</Message>`).join('');
      res.set('Content-Type', 'text/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response>${parts}</Response>`);
    };

    if (alreadyProcessed(body.MessageSid)) {
      console.log('[Webhook] duplicate, ignored');
      return respondTwiml([]);
    }

    startReplyCapture(telefono);
    try {
      const numMedia = parseInt(body.NumMedia || '0', 10);
      if (numMedia > 0) {
        const mediaUrl = body.MediaUrl0;
        const mediaType = (body.MediaContentType0 || '').toLowerCase();
        const media = mediaUrl ? await downloadTwilioMedia(mediaUrl) : null;
        if (media) {
          if (mediaType.startsWith('audio')) {
            await handleAudioMessage(telefono, { buffer: media.buffer, mimeType: media.mimeType || mediaType });
          } else if (mediaType.startsWith('image')) {
            await handlePaperImage(telefono, { buffer: media.buffer, mimeType: media.mimeType || mediaType });
          } else {
            await handleNonTextMessage(telefono, mediaType.split('/')[0] || 'archivo');
          }
        }
      } else if (body.Body) {
        await handleIncomingMessage(telefono, body.Body);
      }
    } catch (err) {
      console.error('Error processing Twilio webhook:', err);
    }
    const replies = endReplyCapture();
    console.log(`[Webhook] responding with ${replies.length} TwiML message(s)`);
    return respondTwiml(replies);
  }

  // ── Cloud API webhook (Meta and 360dialog share this nested shape) ────────
  // Reject anything Meta did not sign. Without this the endpoint takes messages
  // from anyone who knows the URL — enough to impersonate the manager and file
  // absences, or to burn Anthropic credits one fake message at a time.
  const firma = verifyMetaSignature(req);
  if (!firma.ok) {
    console.warn(`[Webhook] rebutjat: ${firma.reason}`);
    return res.sendStatus(403);
  }
  if (firma.reason === 'not_configured') {
    console.warn('[Webhook] META_APP_SECRET sense configurar: no es verifica la signatura');
  }

  // Return 200 immediately — they retry on timeout.
  res.sendStatus(200);

  try {
    // Real WhatsApp webhook payload parsing
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    // Logged unconditionally: without this there is no way to tell "Meta never
    // delivered" from "delivered and the handler failed" — the two look
    // identical from the outside, and they have completely different fixes.
    console.log(`[Webhook] Cloud API object=${body?.object} field=${change?.field} `
      + `messages=${change?.value?.messages?.length ?? 0} statuses=${change?.value?.statuses?.length ?? 0}`);

    if (!message) return; // Not a message event (could be status update)

    console.log(`[Webhook] inbound from=${message.from} type=${message.type} id=${message.id}`);

    // Ignore Meta's retry of a message we already handled
    if (alreadyProcessed(message.id)) return;

    const telefono = message.from; // phone number with country code
    const messageType = message.type; // text, image, audio, video, sticker, etc.

    if (messageType === 'text') {
      const texto = message.text?.body || '';
      if (texto) await handleIncomingMessage(telefono, texto);
    } else if (messageType === 'audio' || messageType === 'voice') {
      // Voice note → download from Meta, transcribe, run through normal flow
      const mediaId = message.audio?.id || message.voice?.id;
      if (mediaId) await handleAudioMessage(telefono, { mediaId });
    } else if (messageType === 'image') {
      // Photo of the weekly preference paper (managers only — the handler
      // politely refuses images from regular employees)
      const mediaId = message.image?.id;
      if (mediaId) await handlePaperImage(telefono, { mediaId });
    } else {
      // Other non-text (video, sticker, etc.)
      await handleNonTextMessage(telefono, messageType);
    }
  } catch (err) {
    console.error('Error processing WhatsApp webhook:', err);
  }
}

// The integrated Meta inbox owns durability, batching and execution identity.
export async function processCloudMessage(message) {
  const telefono = message.from;
  if (message.type === 'text') {
    if (message.text?.body) await handleIncomingMessage(telefono, message.text.body);
  } else if (message.type === 'audio' || message.type === 'voice') {
    const mediaId = message.audio?.id || message.voice?.id;
    if (mediaId) await handleAudioMessage(telefono, { mediaId });
  } else if (message.type === 'image') {
    if (message.image?.id) await handlePaperImage(telefono, { mediaId: message.image.id });
  } else await handleNonTextMessage(telefono, message.type);
}

// ─────────────────────────────────────────────
// BROADCAST — Send preference requests to all employees
// ─────────────────────────────────────────────
export async function broadcast(req, res) {
  const { establecimientoId, semana, forcar, employeeIds } = req.body;
  if (!establecimientoId) {
    return res.status(400).json({ error: 'establecimientoId requerido' });
  }

  try {
    // `forcar` només arriba per aquí, mai des dels crons: reenviar esborra el
    // que la gent ja hagi contestat, i això només ho pot decidir una persona
    // que sap què està fent i a qui se li ha advertit.
    const result = await broadcastPreferenceRequest(parseInt(establecimientoId), semana, { forcar: forcar === true, employeeIds });
    return res.json(result);
  } catch (err) {
    console.error('Error en broadcast:', err);
    return res.status(500).json({ error: err.message || 'Error al enviar mensajes' });
  }
}

// ─────────────────────────────────────────────
// STATUS — Get conversation status for an establishment
// ─────────────────────────────────────────────
export async function getStatus(req, res) {
  const { establecimiento, semana } = req.query;
  if (!establecimiento) {
    return res.status(400).json({ error: 'Parámetro establecimiento requerido' });
  }

  const result = await getConversationStatus(parseInt(establecimiento), semana);
  return res.json(result);
}

// ─────────────────────────────────────────────
// REMINDERS — Send reminders to employees who haven't responded
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// WEEKLY REMINDER — called by an external scheduler, not by a logged-in user,
// so it authenticates with a shared secret instead of a session. Without the
// secret configured the endpoint stays closed: an open endpoint here would let
// anyone make the company's phone buzz.
// ─────────────────────────────────────────────
// El mateix secret compartit que el recordatori setmanal: aquests dos els
// dispara el mateix cron i afegir un secret més només és una cosa més a perdre.
export function secretOk(req, res) {
  const secret = process.env.WEEKLY_REMINDER_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'WEEKLY_REMINDER_SECRET no configurado' });
    return false;
  }
  const provided = req.get('x-reminder-secret') || req.query.secret;
  if (provided !== secret) {
    res.status(403).json({ error: 'Secreto incorrecto' });
    return false;
  }
  return true;
}

export async function autoBroadcastHandler(req, res) {
  if (!secretOk(req, res)) return;
  try {
    const result = await broadcastAutomatic(req.body?.semana);
    // 503 quan alguna botiga ha petat: el correu de job fallit de cron-job.org
    // és el segon canal, i serveix precisament per als dies que WhatsApp és
    // justament la cosa que no funciona.
    if (result.falla) return res.status(503).json({ estado: 'problema', ...result });
    return res.json({ estado: 'ok', ...result });
  } catch (err) {
    console.error('Error en el broadcast automàtic:', err);
    return res.status(500).json({ error: err.message || 'Error al enviar el broadcast' });
  }
}

export async function autoRemindersHandler(req, res) {
  if (!secretOk(req, res)) return;
  try {
    const result = await recordatorisAutomatics(req.body?.semana);
    // Mateix tracte que el broadcast: si ha fallat res, 503, perquè el correu
    // de job fallit del cron és el segon canal d'avís.
    if (result.falla) return res.status(503).json({ estado: 'problema', ...result });
    return res.json({ estado: 'ok', ...result });
  } catch (err) {
    console.error('Error en els recordatoris automàtics:', err);
    return res.status(500).json({ error: err.message || 'Error al enviar los recordatorios' });
  }
}

/**
 * El batec. Es dispara cada hora i decideix ell mateix si toca fer res.
 *
 * Abans l'hora d'enviar vivia a cron-job.org: diumenge a les 09:00, escrit
 * allà. Això volia dir que moure la finestra des de la pantalla d'ajustos no
 * movia l'enviament, i que si algú l'obria per a un dia que el cron no toca, el
 * broadcast no sortia mai i tot plegat contestava 200. La configuració deia una
 * cosa i el sistema en feia una altra, en silenci.
 *
 * Ara el cron només diu «mira si toca». Qui decideix és la finestra, o sigui la
 * pantalla d'ajustos. Cridar-lo de més és inofensiu: el broadcast salta qui ja
 * té la petició d'aquesta setmana i els recordatoris només surten a prop del
 * termini, un cop per persona.
 */
export async function heartbeatHandler(req, res) {
  if (!secretOk(req, res)) return;
  try {
    const enviament = await broadcastAutomatic(req.body?.semana);
    const recordatoris = await recordatorisAutomatics(req.body?.semana);
    const cos = { enviament, recordatoris };
    if (enviament.falla || recordatoris.falla) return res.status(503).json({ estado: 'problema', ...cos });
    return res.json({ estado: 'ok', ...cos });
  } catch (err) {
    console.error('Error al batec:', err);
    return res.status(500).json({ error: err.message || 'Error al batec' });
  }
}

/**
 * El vigilant. Corre un dia després del broadcast i comprova que va sortir.
 *
 * Torna 503 quan no ha sortit, que és el que fa que cron-job.org enviï el
 * correu de tasca fallida; i a més avisa per WhatsApp, perquè un correu es pot
 * perdre entre cinquanta. Els dos canals fallen de maneres diferents, i per
 * això n'hi ha dos.
 */
export async function watchdogHandler(req, res) {
  if (!secretOk(req, res)) return;
  try {
    const r = await revisaElCicleSetmanal();
    if (r.problemes.length === 0) return res.json({ estado: 'ok', ...r });
    const avisat = await informaLaResponsable(textAvis(r));
    return res.status(503).json({ estado: 'problema', avisat, ...r });
  } catch (err) {
    console.error('Error al vigilant del cicle setmanal:', err);
    return res.status(500).json({ error: err.message || 'Error al revisar el cicle' });
  }
}

export async function weeklyReminderHandler(req, res) {
  const secret = process.env.WEEKLY_REMINDER_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'WEEKLY_REMINDER_SECRET no configurado' });
  }
  const provided = req.get('x-reminder-secret') || req.query.secret;
  if (provided !== secret) {
    return res.status(403).json({ error: 'Secreto incorrecto' });
  }
  try {
    const result = await sendWeeklyBroadcastReminder();
    return res.json(result);
  } catch (err) {
    console.error('Error en recordatorio semanal:', err);
    return res.status(500).json({ error: err.message || 'Error al enviar el recordatorio' });
  }
}

// Same shared secret as the weekly reminder: one more secret to lose is a cost,
// and both endpoints are the same external scheduler doing the same kind of job.
//
// Answers 503 when something is wrong, on purpose. The scheduler treats a
// non-2xx as a failed job and emails about it, which gives us an alerting path
// that does not depend on WhatsApp working — the case a WhatsApp alert can
// never cover — and that also fires when this service is down altogether.
export async function healthCheckHandler(req, res) {
  const secret = process.env.WEEKLY_REMINDER_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'WEEKLY_REMINDER_SECRET no configurado' });
  }
  const provided = req.get('x-reminder-secret') || req.query.secret;
  if (provided !== secret) {
    return res.status(403).json({ error: 'Secreto incorrecto' });
  }
  try {
    const result = await sendHealthAlert();
    if (result.problemas.length > 0) {
      return res.status(503).json({ estado: 'problema', ...result });
    }
    return res.json({ estado: 'ok', ...result });
  } catch (err) {
    console.error('Error en la comprobación de salud:', err);
    return res.status(500).json({ error: err.message || 'Error al comprobar el estado' });
  }
}

export async function sendRemindersHandler(req, res) {
  const { establecimientoId, semana, employeeIds } = req.body;
  if (!establecimientoId) {
    return res.status(400).json({ error: 'establecimientoId requerido' });
  }

  try {
    const result = await sendReminders(parseInt(establecimientoId), semana, { employeeIds });
    return res.json(result);
  } catch (err) {
    console.error('Error enviando recordatorios:', err);
    return res.status(500).json({ error: err.message || 'Error al enviar recordatorios' });
  }
}

// ─────────────────────────────────────────────
// MOCK — Simulate an incoming message (dev/testing only)
// ─────────────────────────────────────────────
export async function mockIncoming(req, res) {
  if (!isMockMode()) {
    return res.status(403).json({ error: 'Mock mode no está activado' });
  }

  const { telefono, texto } = req.body;
  if (!telefono || !texto) {
    return res.status(400).json({ error: 'telefono y texto requeridos' });
  }

  try {
    const result = await handleIncomingMessage(telefono, texto);
    return res.json({ ...result, mockLog: getMockMessages().slice(-5) });
  } catch (err) {
    console.error('Error en mock incoming:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────
// MOCK — Simulate a voice note (multipart audio upload)
// ─────────────────────────────────────────────
export async function mockAudioIncoming(req, res) {
  if (!isMockMode()) {
    return res.status(403).json({ error: 'Mock mode no está activado' });
  }
  const telefono = req.body?.telefono || req.query?.telefono;
  if (!telefono || !req.file) {
    return res.status(400).json({ error: 'telefono y archivo de audio requeridos' });
  }
  try {
    const result = await handleAudioMessage(telefono, {
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
    });
    return res.json({ ...result, mockLog: getMockMessages().slice(-5) });
  } catch (err) {
    console.error('Error en mock audio:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────
// MOCK — Simulate a paper-sheet photo (multipart image upload)
// ─────────────────────────────────────────────
export async function mockPaperIncoming(req, res) {
  if (!isMockMode()) {
    return res.status(403).json({ error: 'Mock mode no está activado' });
  }
  const telefono = req.body?.telefono || req.query?.telefono;
  if (!telefono || !req.file) {
    return res.status(400).json({ error: 'telefono y archivo de imagen requeridos' });
  }
  try {
    const result = await handlePaperImage(telefono, {
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
    });
    return res.json({ ...result, mockLog: getMockMessages().slice(-5) });
  } catch (err) {
    console.error('Error en mock paper:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────
// MOCK — Get all mock messages sent (dev/testing only)
// ─────────────────────────────────────────────
export async function mockLog(_req, res) {
  if (!isMockMode()) {
    return res.status(403).json({ error: 'Mock mode no está activado' });
  }
  return res.json({ mock: true, messages: getMockMessages() });
}

// ─────────────────────────────────────────────
// MOCK — Config (is mock mode active?)
// ─────────────────────────────────────────────
export function mockConfig(_req, res) {
  return res.json({ mockMode: isMockMode() });
}

// ─────────────────────────────────────────────
// MOCK — Reset conversations (dev/testing only)
// ─────────────────────────────────────────────
export async function mockResetHandler(req, res) {
  if (!isMockMode()) {
    return res.status(403).json({ error: 'Mock mode no está activado' });
  }
  const { telefono, establecimientoId, semana } = req.body || {};
  try {
    const result = await mockReset({
      telefono,
      establecimientoId: establecimientoId ? parseInt(establecimientoId) : undefined,
      semana,
    });
    return res.json(result);
  } catch (err) {
    console.error('Error resetting mock:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────
// Get full conversation by phone (messages + preference)
// ─────────────────────────────────────────────
export async function getConversationByPhoneHandler(req, res) {
  const { telefono } = req.query;
  if (!telefono) return res.status(400).json({ error: 'telefono requerido' });
  const result = await getConversationByPhone(telefono);
  if (!result) return res.json({ conversacion: null, empleado: null, preferencia: null });
  return res.json(result);
}

// ─────────────────────────────────────────────
// GET /whatsapp/config-check
//
// Which WhatsApp settings are configured on this server — names and yes/no,
// never values. There is no other way to answer "did we ever add that
// variable?" without reading the production environment by hand, and the one
// that was missing (the schedule template) cost a week's schedule that never
// reached the shop.
//
// Managers only, and deliberately no secrets: knowing that WHATSAPP_TOKEN is
// set tells you nothing about what it is.
// ─────────────────────────────────────────────
export async function readWhatsappConfiguration() {
  let providerTemplates = null, providerVerificationError = null;
  if (!isMockMode() && whatsappProvider() === 'meta') {
    try { providerTemplates = await readMetaTemplates(); }
    catch (error) { providerVerificationError = error instanceof Error && !/Bearer|https?:|token/i.test(error.message) ? error.message : 'No s’han pogut verificar les plantilles a Meta.'; }
  }
  const hi = (k) => !!(process.env[k] && String(process.env[k]).trim());
  const descriuPlantilla = (clau, variables, per) => {
    const brut = String(process.env[clau] || '').trim();
    if (!brut) return { posada: false, per };
    const { name, language } = nomIIdioma(brut);
    const actual = providerTemplates?.find(t => t.name === name && t.language === language);
    const supported = clau === 'WHATSAPP_TEMPLATE_BROADCAST' ? [3, 4] : clau === 'WHATSAPP_TEMPLATE_REMINDER' ? [2, 4] : [variables];
    return { posada: true, nom: name, idioma: language, variablesQueSEnvien: actual && supported.includes(actual.bodyParameters) ? actual.bodyParameters : variables, per,
      providerStatus: actual?.status || null, fieldsMatch: actual ? supported.includes(actual.bodyParameters) && (clau !== 'WHATSAPP_TEMPLATE_HORARIO' || actual.headerFormat === 'DOCUMENT') : null };
  };
  return {
    modo: isMockMode() ? 'simulacio' : 'real',
    deliveryEnabled: process.env.HORARIA_ALLOW_DELIVERY === '1' && !isMockMode(),
    providerApprovalVerified: providerTemplates !== null,
    providerTemplates,
    providerVerificationError,
    automaticEnabled: process.env.HORARIA_ALLOW_AUTOMATIC === '1',
    managerNotificationsEnabled: process.env.HORARIA_MANAGER_NOTIFICATIONS !== '0',
    proveidor: whatsappProvider(),
    credencials: {
      WHATSAPP_TOKEN: hi('WHATSAPP_TOKEN'),
      WHATSAPP_PHONE_NUMBER_ID: hi('WHATSAPP_PHONE_NUMBER_ID') || hi('WHATSAPP_PHONE_ID'),
      META_APP_SECRET: hi('META_APP_SECRET'),
    },
    // The names themselves, not just yes/no. A template name is not a secret,
    // and "all four are set" was never the question — the failure that cost a
    // morning was the right names in the wrong variables, which only the values
    // can show. Each carries how many body variables the code will send it, so
    // a mismatch with Meta is visible before it is sent.
    plantilles: {
      WHATSAPP_TEMPLATE_BROADCAST: descriuPlantilla('WHATSAPP_TEMPLATE_BROADCAST', 3, 'petició de preferències als treballadors'),
      WHATSAPP_TEMPLATE_REMINDER: descriuPlantilla('WHATSAPP_TEMPLATE_REMINDER', 2, 'recordatori als que no han contestat'),
      WHATSAPP_TEMPLATE_MANAGER_REMINDER: descriuPlantilla('WHATSAPP_TEMPLATE_MANAGER_REMINDER', 2, 'avís del dilluns a la responsable general'),
      WHATSAPP_TEMPLATE_HORARIO: descriuPlantilla('WHATSAPP_TEMPLATE_HORARIO', 3, "l'horari en PDF a l'encarregada (capçalera DOCUMENT)"),
      WHATSAPP_TEMPLATE_LANG: process.env.WHATSAPP_TEMPLATE_LANG || 'es (per defecte)',
    },
  };
}

export async function configCheck(_req, res) {
  return res.json(await readWhatsappConfiguration());
}

// ─────────────────────────────────────────────
// POST /whatsapp/unblock { telefono }
//
// Three places set `bloqueada` and, until now, nothing cleared it: a locked
// employee stayed locked until the next week's broadcast reset them. The lock
// is also silent by design — no reply is sent — so somebody wrongly locked
// gets no answer and no explanation, and the manager has no way to help.
//
// It happened on the first real test run: a valid request was read as a third
// troll message.
// ─────────────────────────────────────────────
export async function unblockConversation(req, res) {
  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ error: 'telefono requerido' });

  const conv = await prisma.whatsappConversation.findUnique({ where: { telefono } });
  if (!conv) return res.status(404).json({ error: 'No hi ha cap conversa amb aquest telèfon' });

  await prisma.whatsappConversation.update({
    where: { id: conv.id },
    data: { bloqueada: false, intentosIrrelevantes: 0 },
  });
  return res.json({ telefono, desbloquejada: true, estado: conv.estado, semana: conv.semana });
}
