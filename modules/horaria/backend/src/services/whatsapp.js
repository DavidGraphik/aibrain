import { createAiClient, requireDelivery } from '../integration/providers.js';
import { readMetaTemplates, requireApprovedTemplate, selectedRecipients, verifySelectedRecipients, templateDeadlineMatches } from '../integration/meta-templates.js';
import { findOverlappingAbsence, describeOverlap } from '../utils/absenceOverlap.js';
import { fusionaPaperIWhatsapp, marquesDelFull, TORN_DE_LA_MARCA } from '../utils/fusioPaper.js';
// The long form — "del 17 al 23 d'agost". The local weekLabel below writes
// "Ago 17 – 23", which is fine inside a table and reads like a database row in
// a WhatsApp message the model has already been answering in plain Catalan.
import { weekLabel as weekLabelLlarg, calendariDeLaSetmana } from '../utils/isoWeek.js';
import { createClient as createDeepgramClient } from '@deepgram/sdk';
import { prisma } from './prisma.js';
import {
  ultimDissabteTreballat, avisAlDemanar, textAlternancaSi, textAlternancaNo,
  alternancaCompleix,
} from './saturdayRotation.js';
import { esComiat } from '../utils/comiats.js';
import { ajustos, ajust } from '../utils/ajustos.js';

const anthropic = createAiClient();

// Model is env-configurable so we can move versions without code changes.
// (The old pinned snapshot claude-sonnet-4-20250514 was retired and started returning 404.)
const CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL || 'claude-sonnet-4-6';
// Paper reading is one call per week — use the strongest model for handwriting accuracy.
const PAPER_MODEL = process.env.ANTHROPIC_PAPER_MODEL || 'claude-opus-4-8';

// Deepgram is initialized lazily so the server still boots without the key
// (the chatbot still works, voice notes will just fail gracefully).
let deepgram = null;
function getDeepgram() {
  if (process.env.HORARIA_ALLOW_AI !== '1') return null;
  if (!process.env.DEEPGRAM_API_KEY) return null;
  if (!deepgram) deepgram = createDeepgramClient(process.env.DEEPGRAM_API_KEY);
  return deepgram;
}

// ─────────────────────────────────────────────
// AUDIO TRANSCRIPTION (Deepgram)
// ─────────────────────────────────────────────
// Accepts a Buffer of audio bytes (any common format: ogg/mp3/wav/m4a/webm)
// Returns the transcribed string, or null if transcription failed/empty.
export async function transcribeAudio(buffer, mimeType) {
  const dg = getDeepgram();
  if (!dg) {
    console.warn('[WhatsApp] DEEPGRAM_API_KEY not set — cannot transcribe audio');
    return null;
  }
  try {
    const { result, error } = await dg.listen.prerecorded.transcribeFile(buffer, {
      model: 'nova-2',
      language: 'multi', // auto-detects ES/EN/CA among others
      smart_format: true,
      punctuate: true,
    });
    if (error) {
      console.error('[Deepgram] transcription error:', error);
      return null;
    }
    const text = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    return text.trim() || null;
  } catch (err) {
    console.error('[Deepgram] unexpected error:', err);
    return null;
  }
}

// Downloads any WhatsApp media file by mediaId (real-mode only).
// Returns { buffer, mimeType } or null.
async function downloadWhatsappMedia(mediaId) {
  if (!WHATSAPP_TOKEN && !D360_API_KEY) return null;
  // Step 1: get media URL
  const lookupUrl = USE_D360 ? `${D360_BASE_URL}/${mediaId}` : `https://graph.facebook.com/v23.0/${mediaId}`;
  const metaRes = await fetch(lookupUrl, { headers: cloudApiAuth() });
  if (!metaRes.ok) return null;
  const meta = await metaRes.json();
  if (!meta?.url) return null;

  // Step 2: download bytes. 360dialog returns a graph.facebook.com URL that must
  // be fetched through their host instead — the Meta token is not ours to use.
  const bytesUrl = USE_D360
    ? meta.url.replace(/^https:\/\/lookaside\.fbsbx\.com|^https:\/\/graph\.facebook\.com\/v\d+\.\d+/, D360_BASE_URL)
    : meta.url;
  const mediaRes = await fetch(bytesUrl, { headers: cloudApiAuth() });
  if (!mediaRes.ok) return null;
  const arrayBuffer = await mediaRes.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type };
}

// Downloads a WhatsApp audio media file by mediaId (real-mode only) and transcribes it.
export async function transcribeWhatsappMedia(mediaId) {
  const media = await downloadWhatsappMedia(mediaId);
  if (!media) return null;
  return transcribeAudio(media.buffer, media.mimeType);
}

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
// Provider: 'meta' (Cloud API), '360dialog' or 'twilio'.
//  · meta      — needs a Meta for Developers app (blocked for us: SMS verification).
//  · 360dialog — a Meta Business Solution Provider that proxies the Cloud API, so
//                the payloads below are identical; only the base URL and the auth
//                header differ. Onboarding goes through Business Manager, never
//                Meta for Developers, and there is a free sandbox key.
//  · twilio    — has its own Trust Hub compliance layer on top of Meta's.
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
// Twilio WhatsApp sender, e.g. "whatsapp:+14155238886" (Sandbox) or your own number.
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
// 360dialog: the API key identifies the sending number, so there is no phone ID.
// Sandbox base is https://waba-sandbox.360dialog.io — production waba-v2.
const D360_API_KEY = process.env.D360_API_KEY;
const D360_BASE_URL = (process.env.D360_BASE_URL || 'https://waba-v2.360dialog.io').replace(/\/$/, '');

// An explicit WHATSAPP_PROVIDER always wins; otherwise infer from the credentials
// present, so adding a key is enough to switch provider.
const PROVIDER = (() => {
  const explicit = (process.env.WHATSAPP_PROVIDER || '').toLowerCase();
  if (['meta', '360dialog', 'twilio'].includes(explicit)) return explicit;
  if (D360_API_KEY) return '360dialog';
  if (!WHATSAPP_TOKEN && TWILIO_SID && TWILIO_TOKEN) return 'twilio';
  return 'meta';
})();
const USE_TWILIO = PROVIDER === 'twilio';
const USE_D360 = PROVIDER === '360dialog';

// Missing credentials for the selected provider fall back to mock rather than
// failing at send time.
const MOCK_MODE = process.env.WHATSAPP_MOCK === 'true'
  || (USE_TWILIO ? !(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM)
    : USE_D360 ? !D360_API_KEY
      : !WHATSAPP_TOKEN);
// Meta calls this the "Phone number ID". Accept both names so a mismatch between
// render.yaml and the code can never silently break real mode.
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID;

// Approved Meta message-template names for BUSINESS-INITIATED messages (broadcast
// and reminders). Free-form text is only allowed within 24h of the employee's last
// message, so these first-contact messages must use pre-approved templates.
// When unset, we fall back to free-form text (mock mode + test number).
const BROADCAST_TEMPLATE = process.env.WHATSAPP_TEMPLATE_BROADCAST;
const REMINDER_TEMPLATE = process.env.WHATSAPP_TEMPLATE_REMINDER;
// Template for the Monday reminder to the general manager. The reminder is a
// business-initiated message like any other, so outside the 24h window it is
// silently dropped without one. Unset → free-form, which is fine in mock mode
// and whenever the manager has written recently.
const MANAGER_REMINDER_TEMPLATE = process.env.WHATSAPP_TEMPLATE_MANAGER_REMINDER;
// Template for the published schedule sent to the shop manager. This was the
// one business-initiated message that never got one, so it went out as a
// free-form document — which Meta only delivers within 24h of the recipient's
// last message. It worked in testing against a number that had just written,
// and silently failed for Neus Sala, who had never written at all. The template
// needs a DOCUMENT header so the PDF can ride along.
const SCHEDULE_TEMPLATE = process.env.WHATSAPP_TEMPLATE_HORARIO;
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'es';

export function requireBusinessTemplate(kind) {
  if (MOCK_MODE || USE_TWILIO) return;
  const templates = { broadcast: BROADCAST_TEMPLATE, reminder: REMINDER_TEMPLATE, manager: MANAGER_REMINDER_TEMPLATE, schedule: SCHEDULE_TEMPLATE };
  const keys = { broadcast: 'WHATSAPP_TEMPLATE_BROADCAST', reminder: 'WHATSAPP_TEMPLATE_REMINDER', manager: 'WHATSAPP_TEMPLATE_MANAGER_REMINDER', schedule: 'WHATSAPP_TEMPLATE_HORARIO' };
  if (!Object.hasOwn(templates, kind)) throw new Error('Tipo de plantilla no válido.');
  if (!templates[kind]) throw new Error(`Falta ${keys[kind]}: configura una plantilla aprobada antes del envío automático. No se ha enviado el mensaje.`);
}

export async function approvedBusinessTemplate(kind) {
  requireBusinessTemplate(kind);
  if (MOCK_MODE || USE_TWILIO || USE_D360) return null;
  const binding = { broadcast: BROADCAST_TEMPLATE, reminder: REMINDER_TEMPLATE, manager: MANAGER_REMINDER_TEMPLATE, schedule: SCHEDULE_TEMPLATE }[kind];
  const { name, language } = nomIIdioma(binding);
  return requireApprovedTemplate(await readMetaTemplates(), name, language,
    kind === 'broadcast' ? [3, 4] : kind === 'reminder' ? [2, 4] : kind === 'schedule' ? [3] : [2], kind === 'schedule');
}

// One language for every template is one language too few.
//
// The first broadcast failed with "template name (recordatori_broadcast) does
// not exist in es": the name was right and the language was not. Approving
// them all in one language is the tidy answer, but it means a single template
// approved in Catalan while the others are in Spanish blocks everything, and
// you find out one send at a time.
//
// So a template may carry its own: WHATSAPP_TEMPLATE_BROADCAST=nom:ca. Without
// a suffix it uses WHATSAPP_TEMPLATE_LANG, which is what everything did before.
export function nomIIdioma(valor) {
  const text = String(valor || '').trim();
  const tall = text.lastIndexOf(':');
  // A Twilio Content SID (HX…) never carries a language and never has a colon.
  if (tall > 0 && /^[a-z]{2}(_[A-Z]{2})?$/.test(text.slice(tall + 1))) {
    return { name: text.slice(0, tall), language: text.slice(tall + 1) };
  }
  return { name: text, language: TEMPLATE_LANG };
}

// In-memory mock log (only used in mock mode)
const mockMessages = [];

// ─────────────────────────────────────────────
// CLOUD API HELPERS (Meta and 360dialog)
// Both speak the same message payloads, so everything below is shared; they
// differ only in where the request goes and how it is authenticated.
// ─────────────────────────────────────────────
function cloudApiUrl(path = 'messages') {
  return USE_D360
    ? `${D360_BASE_URL}/${path}`
    : `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_ID}/${path}`;
}

function cloudApiAuth() {
  return USE_D360
    ? { 'D360-API-KEY': D360_API_KEY }
    : { Authorization: `Bearer ${WHATSAPP_TOKEN}` };
}

async function cloudApiSend(payload, label = 'WhatsApp API') {
  const res = await fetch(cloudApiUrl(), {
    method: 'POST',
    headers: { ...cloudApiAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${label} error: ${res.status} — ${err}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────
// TWILIO HELPERS
// ─────────────────────────────────────────────
// Twilio addresses WhatsApp numbers as "whatsapp:+34…"
function twilioAddr(phone) {
  const p = normalizePhone(phone);
  return p.startsWith('whatsapp:') ? p : `whatsapp:${p}`;
}

// POST to Twilio's Messages API (form-encoded, Basic auth).
async function twilioSend(telefono, { body, contentSid, contentVariables }) {
  const form = new URLSearchParams();
  form.set('From', twilioAddr(TWILIO_FROM));
  form.set('To', twilioAddr(telefono));
  if (contentSid) {
    // Approved template (Content API) for business-initiated messages
    form.set('ContentSid', contentSid);
    if (contentVariables) form.set('ContentVariables', JSON.stringify(contentVariables));
  } else {
    form.set('Body', body || '');
  }

  console.log(`[Twilio] → ${form.get('To')} (from ${form.get('From')})`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`[Twilio] SEND FAILED ${res.status}: ${err}`);
    throw new Error(`Twilio API error: ${res.status} — ${err}`);
  }
  const json = await res.json();
  console.log(`[Twilio] sent OK sid=${json.sid} status=${json.status}`);
  return json;
}

// Download media Twilio received (voice notes, paper photos). Twilio media URLs
// need the same Basic auth as the API.
export async function downloadTwilioMedia(mediaUrl) {
  const res = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')}` },
  });
  if (!res.ok) return null;
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: res.headers.get('content-type') || '' };
}

// ─────────────────────────────────────────────
// SEND A DOCUMENT (e.g. the schedule PDF) with a caption.
// The file must be reachable at a public URL — WhatsApp/Twilio fetch it.
// ─────────────────────────────────────────────
export async function sendWhatsappMedia(telefono, { texto, mediaUrl, filename, bodyParams = [] }) {
  requireDelivery();
  await approvedBusinessTemplate('schedule');
  if (MOCK_MODE) {
    const entry = { to: telefono, text: `${texto} [adjunto: ${filename}]`, mediaUrl, timestamp: new Date().toISOString() };
    mockMessages.push(entry);
    console.log(`[WhatsApp MOCK] → ${telefono}: ${texto} (PDF: ${mediaUrl})`);
    return { mock: true, ...entry };
  }

  if (USE_TWILIO) {
    const form = new URLSearchParams();
    form.set('From', twilioAddr(TWILIO_FROM));
    form.set('To', twilioAddr(telefono));
    form.set('Body', texto || '');
    form.set('MediaUrl', mediaUrl);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[Twilio] media send failed ${res.status}: ${err}`);
      throw new Error(`Twilio media error: ${res.status} — ${err}`);
    }
    return res.json();
  }

  // With an approved template the message is allowed whenever; the PDF travels
  // in the header and the {{1}}, {{2}}… of the body carry the rest.
  if (SCHEDULE_TEMPLATE) {
    const { name: nomPlantilla, language: idioma } = nomIIdioma(SCHEDULE_TEMPLATE);
    return cloudApiSend({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'template',
      template: {
        name: nomPlantilla,
        language: { code: idioma },
        components: [
          { type: 'header', parameters: [{ type: 'document', document: { link: mediaUrl, filename } }] },
          ...(bodyParams.length
            ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }]
            : []),
        ],
      },
    }, 'WhatsApp media template');
  }

  // No template configured: free-form, which only reaches somebody who has
  // written to us in the last 24 hours. Fine in testing, not in production.
  return cloudApiSend({
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'document',
    document: { link: mediaUrl, filename, caption: texto },
  }, 'WhatsApp media');
}

// Whether the published schedule can reach somebody who has not written to us
// recently. False means every send depends on an open 24h window.
export function hasScheduleTemplate() {
  return !!SCHEDULE_TEMPLATE;
}

export function isTwilioMode() {
  return USE_TWILIO;
}

// ─────────────────────────────────────────────
// TwiML REPLY CAPTURE
// Replying to an inbound Twilio message via the REST API requires an approved
// template (error 21654 "ContentSid Required"). The supported way to answer a
// message is to return TwiML in the webhook response. So while handling an
// inbound webhook we capture what the bot wants to say instead of calling the
// API, and the controller renders it as TwiML.
// ─────────────────────────────────────────────
let replyCapture = null; // { phone, messages: [] }

export function startReplyCapture(phone) {
  replyCapture = { phone: normalizePhone(phone), messages: [] };
}
export function endReplyCapture() {
  const captured = replyCapture ? replyCapture.messages : [];
  replyCapture = null;
  return captured;
}
function tryCaptureReply(telefono, texto) {
  if (!replyCapture) return false;
  if (normalizePhone(telefono) !== replyCapture.phone) return false; // to someone else → real send
  replyCapture.messages.push(texto);
  return true;
}

// ─────────────────────────────────────────────
// SEND MESSAGE (real or mock)
// ─────────────────────────────────────────────
export async function sendWhatsappMessage(telefono, texto) {
  requireDelivery();
  if (MOCK_MODE) {
    const entry = { to: telefono, text: texto, timestamp: new Date().toISOString() };
    mockMessages.push(entry);
    console.log(`[WhatsApp MOCK] → ${telefono}: ${texto.substring(0, 80)}...`);
    return { mock: true, ...entry };
  }

  if (USE_TWILIO) {
    // Inside an inbound webhook → answer via TwiML (no template needed)
    if (tryCaptureReply(telefono, texto)) {
      console.log(`[Twilio] reply captured for TwiML → ${telefono}`);
      return { twiml: true, to: telefono, text: texto };
    }
    return twilioSend(telefono, { body: texto });
  }

  // Real WhatsApp Business API call
  return cloudApiSend({
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'text',
    text: { body: texto },
  });
}

// ─────────────────────────────────────────────
// SEND TEMPLATE MESSAGE (business-initiated; required outside the 24h window)
// bodyParams fill the template's {{1}}, {{2}}, … variables in order.
// ─────────────────────────────────────────────
export async function sendWhatsappTemplate(telefono, { name, language, bodyParams = [] }) {
  requireDelivery();
  const tria = nomIIdioma(name);
  name = tria.name;
  language = language || tria.language;
  if (MOCK_MODE) {
    const text = `[plantilla:${name}] ${bodyParams.join(' · ')}`;
    const entry = { to: telefono, text, timestamp: new Date().toISOString(), template: name };
    mockMessages.push(entry);
    console.log(`[WhatsApp MOCK] → ${telefono}: template ${name}(${bodyParams.join(', ')})`);
    return { mock: true, ...entry };
  }

  if (USE_TWILIO) {
    // Twilio identifies approved templates by Content SID. `name` carries the SID
    // (set WHATSAPP_TEMPLATE_BROADCAST/_REMINDER to the HX… SIDs when using Twilio).
    // Sandbox has no templates: without a SID we fall back to a plain message.
    if (!name || !name.startsWith('HX')) {
      return twilioSend(telefono, { body: bodyParams.join(' · ') });
    }
    const contentVariables = {};
    bodyParams.forEach((v, i) => { contentVariables[String(i + 1)] = String(v); });
    return twilioSend(telefono, { contentSid: name, contentVariables });
  }

  const components = bodyParams.length
    ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }]
    : [];
  return cloudApiSend({
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'template',
    template: { name, language: { code: language }, components },
  }, 'WhatsApp template API');
}

export function getMockMessages() {
  return mockMessages;
}

export function whatsappProvider() { return PROVIDER; }

export function isMockMode() {
  return MOCK_MODE;
}

// ─────────────────────────────────────────────
// EXTRACT THE PREFERENCES MARKER FROM THE MODEL'S REPLY
//
// The marker is a literal label the model appends after its message. Matching
// the exact Spanish string was too brittle: once we started telling the model
// firmly to answer in Catalan it translated the label too ("PREFERÈNCIES_JSON"),
// so the regex missed it — the preferences were silently lost AND the raw JSON
// was delivered to the employee as part of the WhatsApp message.
//
// So: accept any PREFER…_JSON spelling, fall back to any object carrying our
// own "completo" flag, and strip anything marker-shaped from the outgoing text
// no matter what. A lost preference is recoverable; showing an employee a wall
// of JSON is not.
// ─────────────────────────────────────────────
const MARKER_LABEL = /PREFER[A-ZÈÉÁÍÓÚÑÇ]*_JSON\s*:?/gi;

// ─────────────────────────────────────────────
// IS THIS MESSAGE ABOUT THE ROTA?
//
// A deterministic second opinion on the model's `irrelevant` flag, because the
// model is primed by its own earlier verdicts: two strikes in the history and
// it reads the next message as more of the same. That is how a valid request
// ("el miercoles solo puedo trabajar por la tarde") became the third strike
// and locked somebody out for a week, in silence.
//
// Deliberately generous. A false positive here costs one polite redirection
// too many; a false negative costs an employee their say in the rota.
// ─────────────────────────────────────────────
const PARAULES_HORARI = new RegExp([
  'dilluns', 'dimarts', 'dimecres', 'dijous', 'divendres', 'dissabte', 'diumenge',
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mati', 'matins', 'tarda', 'tardes', 'manana', 'mananas', 'tarde',
  'torn', 'torns', 'turno', 'turnos', 'horari', 'horario', 'shift',
  'festa', 'fiesta', 'lliure', 'libre', 'vacances', 'vacaciones',
  'disponib', 'puc', 'puedo', 'treballar', 'trabajar', 'work',
  'metge', 'medico', 'metges', 'visita', 'baixa', 'baja',
].map((w) => `\\b${w}`).join('|'), 'i');

export function esSobreLHorari(text, prefs) {
  // Anything the model actually extracted settles it: you cannot both report a
  // preference and be off-topic.
  if (prefs) {
    if ((prefs.diasNoDisponible || []).length > 0) return true;
    if (prefs.turnosPorDia && Object.keys(prefs.turnosPorDia).length > 0) return true;
    if (prefs.turnoPreferido) return true;
    if (prefs.notasAdicionales) return true;
  }
  const net = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  return PARAULES_HORARI.test(net);
}

// Reads a complete JSON object starting at `start`, tolerating trailing prose.
function readJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function extractPreferences(replyText) {
  const text = String(replyText || '');
  let start = -1;

  const labelled = text.match(/PREFER[A-ZÈÉÁÍÓÚÑÇ]*_JSON\s*:?\s*\{/i);
  if (labelled) {
    start = text.indexOf('{', labelled.index);
  } else {
    // No recognisable label — look for our own flag inside any object.
    const flag = text.search(/"(completo|irrelevant|contractMismatch)"\s*:/);
    if (flag !== -1) start = text.lastIndexOf('{', flag);
  }

  if (start === -1) return { prefs: {}, reply: text.trim() };

  const raw = readJsonObject(text, start);
  let prefs = {};
  if (raw) {
    try {
      prefs = JSON.parse(raw);
    } catch (e) {
      console.error('[Chatbot] no se pudo parsear el JSON de preferencias:', e.message);
    }
  }

  // Remove the object and any stray label, then tidy the blank lines left behind.
  const reply = (raw ? text.replace(raw, '') : text.slice(0, start))
    .replace(MARKER_LABEL, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { prefs, reply };
}

// ─────────────────────────────────────────────
// LANGUAGE DETECTION
// Asking the model to infer the language from the conversation does not work
// here: the broadcast that opens every conversation is written in Catalan and
// sits in the history as an `assistant` turn, which anchors the reply to
// Catalan no matter how firmly the prompt says to ignore it. So we decide the
// language ourselves from the employee's own words and tell the model outright.
// ─────────────────────────────────────────────
// High-signal tokens only, and deliberately including the everyday words this
// domain repeats (semana/setmana, puedes/pots) — without them a perfectly
// ordinary sentence can match nothing at all and fall back to the default.
const LANG_MARKERS = {
  ca: /\b(dilluns|dimarts|dimecres|dijous|divendres|dissabte|diumenge|matí|mati|tarda|tardes|puc|pots|pot|poden|podria|podries|gràcies|gracies|si us plau|d'acord|dacord|treballar|treballo|aquesta|aquest|però|amb|això|aixo|també|tambe|dies|vull|necessito|necessita|festa|festes|setmana|setmanes|propera|proper|següent|seguent|vacances|baixa|tinc|té|fer|faig|ara|avui|ahir|demà|dema|tots|tota|tot|molt bé|molt be|cap problema)\b/g,
  es: /\b(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|mañana|manana|tarde|tardes|puedo|puedes|puede|pueden|podría|podria|gracias|por favor|de acuerdo|trabajar|trabajo|esta|este|esto|pero|con|también|tambien|días|dias|quiero|necesito|necesita|fiesta|fiestas|semana|semanas|próxima|proxima|próximo|siguiente|vacaciones|baja|tengo|tiene|hacer|hago|ahora|hoy|ayer|todos|toda|todo|muy bien|vale|sin problema)\b/g,
  en: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|can't|cannot|thanks|thank you|please|work|working|week|weeks|day|days|need|want|holiday|weekend|okay|next|today|tomorrow|sick leave)\b/g,
};

// Returns 'ca' | 'es' | 'en'. Defaults to Catalan when the employee has not
// written anything distinctive yet.
export function detectIdioma(textos) {
  const texto = (Array.isArray(textos) ? textos : [textos]).filter(Boolean).join(' ').toLowerCase();
  if (!texto.trim()) return 'ca';
  let best = 'ca';
  let bestScore = 0;
  for (const [lang, re] of Object.entries(LANG_MARKERS)) {
    const score = (texto.match(re) || []).length;
    if (score > bestScore) { bestScore = score; best = lang; }
  }
  return bestScore === 0 ? 'ca' : best;
}

const LANG_NAME = { ca: 'CATALÁN', es: 'CASTELLANO', en: 'INGLÉS' };

// ─────────────────────────────────────────────
// PHONE NORMALIZATION
// ─────────────────────────────────────────────
// We store phones in E.164 with a leading "+" (e.g. "+34600000001"), but Meta's
// webhook delivers `message.from` WITHOUT the "+" (e.g. "34600000001"). Normalize
// every inbound phone to the stored format so lookups always match.
export function normalizePhone(telefono) {
  if (!telefono) return telefono;
  const cleaned = String(telefono).trim().replace(/[^\d+]/g, '');
  if (!cleaned) return cleaned;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

// ─────────────────────────────────────────────
// MOCK: reset conversations (wipes all or one phone)
// ─────────────────────────────────────────────
export async function mockReset({ telefono, establecimientoId, semana } = {}) {
  // If telefono given → reset only that phone
  if (telefono) {
    await prisma.whatsappMessage.deleteMany({ where: { conversacion: { telefono } } });
    await prisma.whatsappConversation.deleteMany({ where: { telefono } });
    // Also wipe any WhatsApp-sourced preference for the related employee, for current week
    const emp = await prisma.employee.findFirst({ where: { telefonoWhatsapp: telefono } });
    if (emp) {
      await prisma.shiftPreference.deleteMany({
        where: { empleadoId: emp.id, recogidoVia: 'WHATSAPP', ...(semana ? { semana } : {}) },
      });
    }
    // Clear in-memory log entries for this phone
    for (let i = mockMessages.length - 1; i >= 0; i--) {
      if (mockMessages[i].to === telefono) mockMessages.splice(i, 1);
    }
    return { reset: 'single', telefono };
  }

  // If establecimientoId → reset only phones of that establishment
  if (establecimientoId) {
    const emps = await prisma.employee.findMany({
      where: {
        OR: [
          { establecimientoId },
          { establecimientosPermitidos: { some: { establishmentId: establecimientoId } } },
        ],
        telefonoWhatsapp: { not: null },
      },
      select: { id: true, telefonoWhatsapp: true },
    });
    const phones = emps.map((e) => e.telefonoWhatsapp);
    await prisma.whatsappMessage.deleteMany({ where: { conversacion: { telefono: { in: phones } } } });
    await prisma.whatsappConversation.deleteMany({ where: { telefono: { in: phones } } });
    await prisma.shiftPreference.deleteMany({
      where: { empleadoId: { in: emps.map((e) => e.id) }, recogidoVia: 'WHATSAPP', ...(semana ? { semana } : {}) },
    });
    for (let i = mockMessages.length - 1; i >= 0; i--) {
      if (phones.includes(mockMessages[i].to)) mockMessages.splice(i, 1);
    }
    return { reset: 'establishment', establecimientoId, count: phones.length };
  }

  // Reset everything
  await prisma.whatsappMessage.deleteMany({});
  await prisma.whatsappConversation.deleteMany({});
  await prisma.shiftPreference.deleteMany({ where: { recogidoVia: 'WHATSAPP' } });
  mockMessages.length = 0;
  return { reset: 'all' };
}

// ─────────────────────────────────────────────
// Get full conversation (messages) for a phone
// ─────────────────────────────────────────────
export async function getConversationByPhone(telefono) {
  const conv = await prisma.whatsappConversation.findUnique({
    where: { telefono },
    include: { mensajes: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conv) return null;

  // Find employee + their preference for this week
  const employee = await prisma.employee.findFirst({
    where: { telefonoWhatsapp: telefono },
    select: { id: true, nombre: true, apellidos: true, establecimientoId: true },
  });
  const preference = employee
    ? await prisma.shiftPreference.findFirst({
        where: { empleadoId: employee.id, semana: conv.semana, activa: true },
      })
    : null;

  return { conversacion: conv, empleado: employee, preferencia: preference };
}

// ─────────────────────────────────────────────
// GET ISO WEEK STRING + human-readable label
// ─────────────────────────────────────────────
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function getCurrentWeek() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// Returns Monday/Sunday Date objects for an ISO week like "2026-W17"
function getWeekDates(semana) {
  const [year, week] = semana.split('-W');
  const jan4 = new Date(parseInt(year), 0, 4);
  const dayOfWeek = (jan4.getDay() + 6) % 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + (parseInt(week) - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { monday, sunday };
}

// Converts "2026-W17" → "Abr 20 – 26" or "Mar 31 – Abr 6" if it spans two months
function weekLabel(semana) {
  const { monday, sunday } = getWeekDates(semana);
  const mesInicio = MESES[monday.getMonth()];
  const mesFin = MESES[sunday.getMonth()];
  if (monday.getMonth() !== sunday.getMonth()) {
    return `${monday.getDate()} ${mesInicio} – ${sunday.getDate()} ${mesFin}`;
  }
  return `${mesInicio} ${monday.getDate()} – ${sunday.getDate()}`;
}

// Returns ISO date strings for the prompt (e.g. "2026-04-27" / "2026-05-03")
export function weekIsoRange(semana) {
  const { monday, sunday } = getWeekDates(semana);
  // Amb `toISOString()` la data es convertia a UTC abans de retallar-la, i
  // `getWeekDates` construeix dates en hora LOCAL: a Madrid, el dilluns 31
  // d'agost sortia com a «2026-08-30», que és diumenge. El Render va en UTC i
  // per això a producció mai s'ha vist, però aquesta data va al prompt del
  // xatbot i el mateix codi mentia depurant-lo en local.
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: iso(monday), end: iso(sunday) };
}

export function getNextWeek() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────
// RETENTION — drop personal data we no longer need.
//
// Active employees are already covered: every broadcast wipes the previous
// week's messages when it resets their conversation. What accumulates instead
// is (a) the conversation of anyone who stopped receiving broadcasts — someone
// who left, or was deactivated — and (b) the weekly preference rows, whose free
// text can carry personal detail ("tinc metge el dimarts").
//
// Deliberately NOT purged: absences and schedules. Spanish employment law
// generally requires keeping employment records for years, so auto-deleting a
// sick-leave record could destroy evidence the company is obliged to hold.
// That call belongs to Arnall's labour advisors, not to this function.
//
// Runs from the weekly broadcast rather than a scheduler: the broadcast IS the
// system's weekly heartbeat, so this needs no cron and no new infrastructure.
// ─────────────────────────────────────────────
const RETENTION_MONTHS = Number(process.env.RETENTION_MONTHS ?? 2);

export async function purgeOldPersonalData({ months = RETENTION_MONTHS } = {}) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  // (a) Conversations belonging to phones that no longer match an active
  // employee. Their messages go with them (cascade is not declared, so delete
  // them explicitly first).
  const activos = await prisma.employee.findMany({
    where: { activo: true, telefonoWhatsapp: { not: null } },
    select: { telefonoWhatsapp: true },
  });
  const vivos = activos.map((e) => e.telefonoWhatsapp);

  const huerfanas = await prisma.whatsappConversation.findMany({
    where: { telefono: { notIn: vivos.length > 0 ? vivos : ['__none__'] } },
    select: { id: true },
  });
  const idsHuerfanas = huerfanas.map((c) => c.id);
  if (idsHuerfanas.length > 0) {
    await prisma.whatsappMessage.deleteMany({ where: { conversacionId: { in: idsHuerfanas } } });
    await prisma.whatsappConversation.deleteMany({ where: { id: { in: idsHuerfanas } } });
  }

  // (b) Weekly preferences past the retention window.
  const prefs = await prisma.shiftPreference.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  // (b bis) Missatges de WhatsApp passat el mateix termini.
  //
  // Abans no calia: el broadcast de cada setmana esborrava els de l'anterior, o
  // sigui que mai n'hi havia més d'una. Ara que es guarden per poder mirar
  // enrere, s'acumulen — i el que es guarda són converses de persones sobre la
  // seva disponibilitat, que no s'han de tenir indefinidament pel sol fet que
  // ara sí que hi caben.
  const missatges = await prisma.whatsappMessage.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  // (b ter) Els errors del navegador. No són dades personals, però creixen sols
  // i un registre de diagnòstic de fa dos mesos no diagnostica res.
  const errors = await prisma.clientError.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  // (c) Photographed sheets, on the same clock as the preferences they produced.
  // The image only exists to check a reading against, so once the reading is
  // gone it is a photograph of somebody's handwriting kept for nothing.
  const fulls = await prisma.paperSheet.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  const resumen = {
    conversacionesEliminadas: idsHuerfanas.length,
    missatgesEliminats: missatges.count,
    errorsEliminats: errors.count,
    preferenciasEliminadas: prefs.count,
    fullsEliminados: fulls.count,
    anterioresA: cutoff.toISOString().slice(0, 10),
  };
  if (resumen.conversacionesEliminadas > 0 || resumen.missatgesEliminats > 0
    || resumen.preferenciasEliminadas > 0 || resumen.fullsEliminados > 0) {
    console.log(`[Retención] ${resumen.conversacionesEliminadas} conversaciones, `
      + `${resumen.missatgesEliminats} mensajes, `
      + `${resumen.preferenciasEliminadas} preferencias y ${resumen.fullsEliminados} hojas `
      + `anteriores a ${resumen.anterioresA} eliminadas`);
  }
  return resumen;
}

// ─────────────────────────────────────────────
// WEEKLY HEALTH CHECK
//
// Everything this system depends on can stop working without anybody being
// told: a Meta API version reaches its sunset, a token is revoked, the
// Anthropic model is retired. The providers do send warning emails months
// ahead, but that only helps if somebody reads them — and a silent failure
// otherwise surfaces on Thursday, when the manager has no preferences and no
// idea why.
//
// Runs alongside the Monday reminder, which is the right moment: a whole week
// to fix things before anyone needs the schedule.
// ─────────────────────────────────────────────
export async function checkSystemHealth() {
  const problemas = [];
  if (MOCK_MODE) return problemas; // nothing real to check
  requireDelivery();

  // WhatsApp: the cheapest call that proves the token, the number and the
  // API version are all still good.
  try {
    const res = await fetch(cloudApiUrl('').replace(/\/$/, '') + '?fields=id', {
      headers: cloudApiAuth(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const code = err?.error?.code;
      const msg = err?.error?.message || `HTTP ${res.status}`;
      problemas.push(code === 190
        ? `WhatsApp: el token ha caducat o s'ha revocat (${msg})`
        : `WhatsApp: ${msg}`);
    }
  } catch (err) {
    problemas.push(`WhatsApp: no s'ha pogut contactar amb Meta (${err.message})`);
  }

  if (process.env.HORARIA_ALLOW_AI !== '1') return [...problemas, 'La IA no està activada.'];

  // No extra paid/API health call: generation uses the user's connected Codex.
  if (!process.env.HORARIA_CODEX_URL) problemas.push('Falta la connexió interna amb Codex d’AiBrain.');

  if (problemas.length > 0) console.error(`[Salut] ${problemas.length} problema(es): ${problemas.join(' · ')}`);
  else console.log('[Salut] tot correcte');
  return problemas;
}

// ─────────────────────────────────────────────
// DAILY HEALTH ALERT
//
// The Monday check leaves a six-day hole: a token revoked on Tuesday goes
// unnoticed until the following Monday, by which time a whole week of
// preferences was never collected.
//
// Two independent channels on purpose, because the obvious one has a blind
// spot — if WhatsApp itself is what broke, a WhatsApp alert about WhatsApp
// cannot arrive:
//
//   1. A message to the general manager. Reaches Roger where he actually
//      looks, and covers a dead Anthropic key or a retired model.
//   2. HTTP 503 back to the scheduler. cron-job.org emails on a failed job,
//      through a route that touches neither WhatsApp nor Render — so it still
//      works when the token is dead, and it also covers the case nothing else
//      did: the whole service being down, where no code of ours runs at all.
//
// Silent when everything is fine. An alert that arrives daily regardless is an
// alert nobody reads.
// ─────────────────────────────────────────────

// Same problem, same day: no point repeating it. Kept in memory rather than in
// the database because the cost of forgetting is one extra message after a
// restart, which is not worth a migration to avoid.
const ultimaAlerta = new Map();
const FINESTRA_ALERTA_MS = 20 * 60 * 60 * 1000; // under a day, so a daily cron never doubles up

export async function sendHealthAlert() {
  const problemas = await checkSystemHealth();
  if (problemas.length === 0) return { problemas, avisado: false };

  const clau = problemas.join('|');
  const ara = Date.now();
  const previa = ultimaAlerta.get(clau);
  if (previa && ara - previa < FINESTRA_ALERTA_MS) {
    console.log('[Alerta] mateix problema que fa poc: no es repeteix el missatge');
    return { problemas, avisado: false, motivo: 'ja_avisat' };
  }

  const manager = await prisma.employee.findFirst({
    where: { rol: 'MANAGER_GENERAL', activo: true, telefonoWhatsapp: { not: null } },
    select: { nombre: true, telefonoWhatsapp: true },
    orderBy: { id: 'asc' },
  });
  if (!manager) {
    console.warn('[Alerta] cap responsable general amb telèfon: només queda l\'avís del programador');
    return { problemas, avisado: false, motivo: 'sin_manager' };
  }

  const texto = `⚠️ horarIA ha detectat un problema:\n\n${problemas.map((p) => `• ${p}`).join('\n')}\n\n`
    + 'Mentre no es resolgui, el bot pot deixar de respondre o els horaris no es podran generar.';

  try {
    await sendWhatsappMessage(manager.telefonoWhatsapp, texto);
    ultimaAlerta.set(clau, ara);
    console.log(`[Alerta] avisada ${manager.nombre} · ${problemas.length} problema(es)`);
    return { problemas, avisado: true };
  } catch (err) {
    // Expected when WhatsApp is the thing that broke. The 503 is what carries
    // the news in that case, so this is logged and not escalated.
    console.error(`[Alerta] no s'ha pogut enviar el missatge: ${err.message}`);
    return { problemas, avisado: false, motivo: 'envio_fallido' };
  }
}

// ─────────────────────────────────────────────
// WEEKLY REMINDER — tell the general manager the broadcast is due.
//
// Deliberately a reminder and not an automatic send: a broadcast is 15+ messages
// that cannot be recalled, and an odd week (holidays, a shop closed, a shift in
// the calendar) is exactly when nobody wants that happening unattended. What the
// reminder removes is the only real failure mode — forgetting.
//
// Reports which establishments have no conversations yet for the target week, so
// a partially-sent week is visible too.
// ─────────────────────────────────────────────
export async function sendWeeklyBroadcastReminder() {
  if (process.env.HORARIA_MANAGER_NOTIFICATIONS === '0') return { avisado: false, motivo: 'desactivado' };
  const targetWeek = getNextWeek();
  const establecimientos = await prisma.establishment.findMany({
    select: { id: true, nombre: true },
  });

  const pendientes = [];
  for (const est of establecimientos) {
    const telefonos = (await prisma.employee.findMany({
      where: quiRepLaPeticio(est.id),
      select: { telefonoWhatsapp: true },
    })).map((e) => e.telefonoWhatsapp);
    if (telefonos.length === 0) continue; // nothing to send anyway

    const yaEnviado = await prisma.whatsappConversation.count({
      where: { telefono: { in: telefonos }, semana: targetWeek },
    });
    if (yaEnviado === 0) pendientes.push(est.nombre);
  }

  // Health first: a broken token or a retired model matters even in a week
  // where every shop has already been contacted, so this must not sit behind
  // the "nothing pending" early return.
  const problemas = await checkSystemHealth();

  if (pendientes.length === 0 && problemas.length === 0) {
    console.log(`[Recordatori] broadcast de ${targetWeek} ja enviat a tots els establiments`);
    return { targetWeek, pendientes: [], problemas, avisado: false };
  }

  const manager = await prisma.employee.findFirst({
    where: { rol: 'MANAGER_GENERAL', activo: true, telefonoWhatsapp: { not: null } },
    select: { nombre: true, telefonoWhatsapp: true },
    orderBy: { id: 'asc' },
  });
  if (!manager) {
    console.warn('[Recordatori] cap responsable general amb telèfon: no s\'envia res');
    return { targetWeek, pendientes, problemas, avisado: false, motivo: 'sin_manager' };
  }

  requireBusinessTemplate('manager');
  const limite = deadlineLabel(await computeDeadline(targetWeek));
  // Problems go first: they are the part that needs acting on today.
  const aviso = problemas.length > 0
    ? `⚠️ ATENCIÓ — horarIA ha detectat un problema:\n\n${problemas.map((p) => `• ${p}`).join('\n')}\n\nCal revisar-ho abans de generar els horaris.\n\n───\n\n`
    : '';
  const cuerpo = pendientes.length > 0
    ? `Bon dia ${manager.nombre}. Avui toca enviar la petició de preferències per a la setmana del ${weekLabel(targetWeek)}.\n\n`
      + `Encara no s'ha enviat a: ${pendientes.join(', ')}.\n\n`
      + `Els treballadors tindran temps fins al ${limite}. Ho pots enviar des de la pestanya WhatsApp d'horarIA.`
    : `Bon dia ${manager.nombre}. El broadcast de la setmana del ${weekLabel(targetWeek)} ja està enviat a tots els establiments.`;
  const texto = aviso + cuerpo;

  try {
    if (!MOCK_MODE && MANAGER_REMINDER_TEMPLATE) {
      await sendWhatsappTemplate(manager.telefonoWhatsapp, {
        name: MANAGER_REMINDER_TEMPLATE,
        bodyParams: [manager.nombre, weekLabel(targetWeek)],
      });
    } else {
      await sendWhatsappMessage(manager.telefonoWhatsapp, texto);
    }
    console.log(`[Recordatori] avisada ${manager.nombre} · pendents: ${pendientes.join(', ') || 'cap'} · problemes: ${problemas.length}`);
    return { targetWeek, pendientes, problemas, avisado: true };
  } catch (err) {
    // Outside the 24h window a free-form message is silently dropped by
    // WhatsApp; that needs its own approved template to be reliable.
    console.error(`[Recordatori] no s'ha pogut avisar: ${err.message}`);
    return { targetWeek, pendientes, problemas, avisado: false, motivo: err.message };
  }
}

// ─────────────────────────────────────────────
// BROADCAST — send initial message to all employees
// ─────────────────────────────────────────────
/**
 * Envia la petició de preferències.
 *
 * `forcar` reenvia a tothom, esborrant el que ja haguessin contestat. Sense
 * ell, qui ja té conversa d'aquella setmana se salta: reenviar fa `deleteMany`
 * dels missatges i torna la conversa a PENDIENTE, i mentre ho clicava una
 * persona un cop això no passava mai. Amb un cron que es dispari dues vegades
 * — un reintent, un job duplicat, o algú clicant a mà el mateix dia — hauria
 * esborrat les preferències de tothom sense dir-ne res.
 */
/**
 * A qui va la petició de preferències d'una botiga: la seva gent i els
 * compartits que hi poden treballar.
 *
 * És una funció i no dues consultes bessones perquè el vigilant ha de comptar
 * exactament els mateixos: quan es va escriure a part, es va deixar els
 * compartits fora, i una botiga que només en tingui hauria quedat sense vigilar
 * justament el dia que el cron morís.
 */
export function quiRepLaPeticio(establecimientoId) {
  return {
    activo: true,
    telefonoWhatsapp: { not: null },
    OR: [
      { establecimientoId },
      { establecimientosPermitidos: { some: { establishmentId: establecimientoId } } },
    ],
  };
}

/**
 * L'últim dissabte que aquesta persona va treballar de debò, abans d'aquesta
 * setmana. `take: 26` és mig any: si en mig any no ha fet cap dissabte, no hi ha
 * cap alternança de la qual parlar.
 */
async function ultimDissabteDe(empleadoId, semana, establecimientoId) {
  const files = await prisma.schedule.findMany({
    // Per establiment: l'alternança és el repartiment dels dissabtes DINS d'una
    // botiga. Sense aquest filtre, a qui fa dissabtes a dues botigues se li
    // agafaria el més recent en el temps encara que fos de l'altra, i l'avís
    // sortiria quan no toca o no sortiria quan sí.
    where: { empleadoId, establecimientoId, dia: 'SABADO', semana: { lt: semana } },
    select: { semana: true, dia: true, turno: true },
    orderBy: { semana: 'desc' },
    take: 26,
  });
  return ultimDissabteTreballat(files, semana);
}

/**
 * Un dissabte que ve del full de paper, es pot donar?
 *
 * El dissabte no és una preferència personal sinó un repartiment entre
 * companys: si un pot reclamar el matí cada setmana, algú altre es queda sempre
 * la tarda. Per això, quan el demanen pel WhatsApp, se'ls avisa i decideix
 * l'encarregada.
 *
 * Del full no se'ls pot preguntar: el van escriure a la paret dies enrere. I
 * mentre les marques del full eren només text no importava, perquè no es
 * concedien. Des que van a `turnosPorDia`, un dissabte apuntat al paper entrava
 * sense passar per aquí — havíem canviat perdre les marques del full per perdre
 * el repartiment dels dissabtes, que és pitjor.
 *
 * O sigui que no es desa i es diu a l'encarregada, que el pot posar a mà si
 * troba que toca. És el mateix que fa la conversa, però amb qui pot decidir.
 */
async function dissabteDelFullPassa(empleadoId, establecimientoId, semana, demanat) {
  if (!demanat) return { passa: true };
  const ultim = await ultimDissabteDe(empleadoId, semana, establecimientoId);
  // Sense cap dissabte treballat abans no hi ha res del que alternar.
  if (alternancaCompleix(ultim?.turno, demanat)) return { passa: true };
  return { passa: false, ultim: ultim.turno };
}

export async function broadcastPreferenceRequest(establecimientoId, semana, { forcar = false, employeeIds } = {}) {
  const template = await approvedBusinessTemplate('broadcast');
  const targetWeek = semana || getNextWeek();
  const fechaLimite = await computeDeadline(targetWeek); // el dimecres anterior a les 13h
  const employees = await prisma.employee.findMany({
    where: selectedRecipients(quiRepLaPeticio(establecimientoId), employeeIds),
    select: { id: true, nombre: true, telefonoWhatsapp: true },
  });
  verifySelectedRecipients(employees, employeeIds);

  // Weekly heartbeat: clear personal data past its retention window. Never let
  // housekeeping stop the broadcast — the messages matter more than the cleanup.
  try {
    if (employeeIds === undefined) await purgeOldPersonalData();
  } catch (err) {
    console.error('[Retención] no se pudo purgar:', err.message);
  }
  const limiteLabel = deadlineLabel(fechaLimite);

  const results = [];

  const saltats = [];
  for (const emp of employees) {
    // Create or reset conversation
    const existing = await prisma.whatsappConversation.findUnique({
      where: { telefono: emp.telefonoWhatsapp },
    });

    // Ja té la petició d'aquesta setmana: no li tornem a enviar, perquè
    // reenviar-la esborraria el que hagi contestat.
    if (existing && existing.semana === targetWeek && !forcar) {
      saltats.push(emp.nombre);
      continue;
    }

    if (existing) {
      // Els missatges de les setmanes anteriors es queden: cadascun porta la
      // seva `semana` i el model només veurà els de la que es demana ara. Abans
      // s'esborraven aquí, i amb l'enviament automàtic això passava cada
      // diumenge sense que ningú ho veiés.
      await prisma.whatsappConversation.update({
        where: { id: existing.id },
        // `ultimoRecordatorio` també: sense reiniciar-lo, una conversa reutilitzada
        // per a la setmana nova s'endú el de la vella i pot silenciar el primer
        // recordatori d'aquesta setmana sense cap motiu.
        data: { semana: targetWeek, fechaApertura: null, estado: 'PENDIENTE', paso: 0, bloqueada: false, intentosIrrelevantes: 0, completedAt: null, ultimoRecordatorio: null, fechaLimite },
      });
    } else {
      await prisma.whatsappConversation.create({
        data: { telefono: emp.telefonoWhatsapp, semana: targetWeek, estado: 'PENDIENTE', paso: 0, fechaLimite },
      });
    }

    // Send greeting message. Business-initiated → use the approved template in
    // real mode; fall back to free-form text (mock mode / test number).
    const semanaLabel = weekLabel(targetWeek);
    const mensaje = `Hola ${emp.nombre}. Estem preparant l'horari de la setmana del ${semanaLabel} i necessitem conèixer la teva disponibilitat.\n\nSi us plau, indica'ns:\n1. Els dies en què NO pots treballar aquella setmana, i digue'ns també si necessites un torn concret (matí o tarda) algun dia en particular.\n2. Qualsevol altra observació que haguem de tenir en compte.\n\nTens fins al ${limiteLabel} (inclòs) per enviar-nos les teves preferències. Després d'aquesta data no les podrem recollir.\n\nPots respondre en l'idioma que prefereixis. Gràcies per la teva col·laboració.`;

    // One bad number must never abort the whole broadcast: record the failure
    // for this employee and keep going. (With Meta's test number this happens
    // constantly — any recipient outside the 5 registered ones is rejected with
    // error 131030 — but a mistyped or deactivated phone would do the same in
    // production and silently skip everyone after it.)
    try {
      if (!MOCK_MODE && BROADCAST_TEMPLATE) {
        // {{3}} = deadline. Without it the approved template cannot state how
        // long they have, and the whole point of the weekly cycle is the cut-off.
        const parts = deadlineParts(fechaLimite);
        await sendWhatsappTemplate(emp.telefonoWhatsapp, { name: BROADCAST_TEMPLATE, bodyParams: template?.bodyParameters === 4 ? [emp.nombre, semanaLabel, parts.date, parts.time] : [emp.nombre, semanaLabel, limiteLabel] });
      } else {
        await sendWhatsappMessage(emp.telefonoWhatsapp, mensaje);
      }
      // Dins del try, com l'enviament: una conversa que es queda en PENDIENTE
      // perquè ha petat l'escriptura fa que després se li torni a enviar el
      // broadcast, i reenviar-lo esborra el que hagi contestat.
      const conv = await prisma.whatsappConversation.findUnique({
        where: { telefono: emp.telefonoWhatsapp },
      });
      await prisma.whatsappMessage.create({
        data: { conversacionId: conv.id, direccion: 'saliente', contenido: mensaje, semana: targetWeek },
      });
      await prisma.whatsappConversation.update({
        where: { id: conv.id },
        data: { estado: 'EN_PROGRESO', paso: 1 },
      });
    } catch (err) {
      console.error(`[Broadcast] fallo con ${emp.nombre} (${emp.telefonoWhatsapp}): ${err.message}`);
      results.push({ empleadoId: emp.id, nombre: emp.nombre, telefono: emp.telefonoWhatsapp, enviado: false, error: err.message });
      continue;
    }

    results.push({ empleadoId: emp.id, nombre: emp.nombre, telefono: emp.telefonoWhatsapp, enviado: true });
  }

  const enviados = results.filter((r) => r.enviado);
  return {
    semana: targetWeek,
    empleadosContactados: enviados.length,
    fallidos: results.length - enviados.length,
    saltats,
    detalle: results,
  };
}

// ─────────────────────────────────────────────
// HANDLE NON-TEXT MESSAGES (images, stickers, etc. — audio handled separately)
// ─────────────────────────────────────────────
export async function handleNonTextMessage(telefono, messageType) {
  telefono = normalizePhone(telefono);
  const typeLabels = {
    image: 'imágenes',
    video: 'vídeos',
    sticker: 'stickers',
    document: 'documentos',
    location: 'ubicaciones',
    contacts: 'contactos',
  };

  const label = typeLabels[messageType] || messageType;

  await sendWhatsappMessage(
    telefono,
    `Disculpa, de moment només puc processar missatges de text o notes de veu, no ${label}. Em pots indicar les teves preferències per escrit?`
  );

  return { handled: true, reason: 'non_text_message', type: messageType };
}

// ─────────────────────────────────────────────
// HANDLE VOICE NOTE — transcribe and run through normal text flow
// `audioSource` is either { buffer, mimeType } (mock mode) or { mediaId } (real WhatsApp)
// ─────────────────────────────────────────────
export async function handleAudioMessage(telefono, audioSource) {
  telefono = normalizePhone(telefono);
  let texto = null;
  if (audioSource?.buffer) {
    texto = await transcribeAudio(audioSource.buffer, audioSource.mimeType);
  } else if (audioSource?.mediaId) {
    texto = await transcribeWhatsappMedia(audioSource.mediaId);
  }

  if (!texto) {
    // Whisper failed or empty — politely ask them to try again, no Claude call burned.
    const conv = await prisma.whatsappConversation.findUnique({ where: { telefono } });
    const msg = 'No he pogut entendre la teva nota de veu. Ho pots tornar a provar o escriure\'m un missatge de text?';
    await sendWhatsappMessage(telefono, msg);
    if (conv) {
      await prisma.whatsappMessage.create({
        data: { conversacionId: conv.id, direccion: 'saliente', contenido: msg, semana: conv.semana },
      });
    }
    return { handled: true, reason: 'transcription_failed' };
  }

  // Prefix the stored inbound message with 🎤 so managers can tell it was a voice note.
  // (handleIncomingMessage logs the inbound itself, so we update the message AFTER.)
  const result = await handleIncomingMessage(telefono, texto);
  const conv = await prisma.whatsappConversation.findUnique({
    where: { telefono },
    include: { mensajes: { orderBy: { createdAt: 'desc' }, take: 1, where: { direccion: 'entrante' } } },
  });
  const lastInbound = conv?.mensajes?.[0];
  if (lastInbound && lastInbound.contenido === texto) {
    await prisma.whatsappMessage.update({
      where: { id: lastInbound.id },
      data: { contenido: `🎤 ${texto}` },
    });
  }
  return { ...result, transcribed: texto };
}

// ─────────────────────────────────────────────
// PAPER SHEET IMPORT (transitional phase)
// A MANAGER sends a photo of the weekly preference paper. Claude (vision)
// reads the handwritten M/T marks per employee/day and saves them as
// ShiftPreferences (origin PAPEL). M = wants MAÑANA that day, T = wants TARDE.
// `imageSource` is { buffer, mimeType } (mock) or { mediaId } (real WhatsApp).
// ─────────────────────────────────────────────

// ISO week string ("2026-W26") for a given Date
function isoWeekOfDate(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// Només per escriure-ho en una frase que llegirà una persona. El valor que es
// DESA surt de TORN_DE_LA_MARCA, que és l'únic que el motor entén.
const TURNO_LABEL = { M: 'MAÑANA', T: 'TARDE' };

/** El nom de qui és, per dir-ho als avisos sense repetir el `find` cada cop. */
function emp0(roster, id) {
  const e = roster.find((x) => x.id === id);
  return e ? `${e.nombre} ${e.apellidos}` : `#${id}`;
}
const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Llegeix un full de peticions i en desa les preferències.
 *
 * Va néixer per al WhatsApp i durant un temps va ser l'ÚNICA porta d'entrada
 * dels fulls de paper: si no els fotografiaves i els enviaves al bot, no hi
 * havia manera de ficar-los a l'app, ni tan sols tenint el full a la mà davant
 * de l'ordinador. Ara l'app també els puja, i el que canvia entre les dues
 * maneres és només qui envia i per on se li contesta:
 *
 *   opts.remitent  — qui puja el full, ja trobat. El WhatsApp no en passa cap
 *                    i el busca pel telèfon, que és tot el que en sap.
 *   opts.respon    — on van els missatges. Per defecte, un WhatsApp a qui
 *                    l'envia; des de l'app, a una llista que es retorna.
 *   opts.botigues  — a quines botigues pot entrar qui puja el full. Si el full
 *                    resulta ser d'una altra, es refusa sense desar res.
 *
 * La lectura, l'aparellament de noms i el desat són els mateixos per als dos
 * camins a posta: un full llegit per l'app i el mateix full llegit pel WhatsApp
 * han de donar exactament el mateix.
 */
export async function handlePaperImage(telefono, imageSource, opts = {}) {
  telefono = normalizePhone(telefono);
  const respon = opts.respon || ((text) => sendWhatsappMessage(telefono, text));

  // 1. Sender must be a manager
  const sender = opts.remitent || await prisma.employee.findFirst({
    where: { telefonoWhatsapp: telefono, activo: true },
    include: { establecimientoGestionado: { select: { id: true, nombre: true } } },
  });
  if (!sender || (sender.rol !== 'MANAGER_LOCAL' && sender.rol !== 'MANAGER_GENERAL')) {
    await respon(
      'Disculpa, de moment només puc processar missatges de text o notes de veu, no imatges. Em pots indicar les teves preferències per escrit?'
    );
    return { handled: true, reason: 'image_from_non_manager' };
  }

  // 2. Get the image bytes
  let buffer = null;
  let mimeType = null;
  if (imageSource?.buffer) {
    buffer = imageSource.buffer;
    mimeType = imageSource.mimeType;
  } else if (imageSource?.mediaId) {
    const media = await downloadWhatsappMedia(imageSource.mediaId);
    if (media) { buffer = media.buffer; mimeType = media.mimeType; }
  }
  if (!buffer) {
    await respon('No he podido descargar la imagen. ¿Puedes volver a enviarla?');
    return { handled: true, reason: 'image_download_failed' };
  }
  const mediaType = (mimeType || '').split(';')[0].toLowerCase();
  if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
    await respon(`Formato de imagen no soportado (${mediaType || 'desconocido'}). Envía la foto en JPG o PNG.`);
    return { handled: true, reason: 'unsupported_image_type' };
  }

  // 3. Candidate establishments (to match the paper header) + rosters
  const managed = sender.establecimientoGestionado || [];
  const establishments = await prisma.establishment.findMany({
    where: { activo: true },
    select: { id: true, nombre: true },
  });
  const rosterEmployees = await prisma.employee.findMany({
    where: { activo: true, rol: { in: ['EMPLEADO', 'MANAGER_LOCAL'] } },
    select: { id: true, nombre: true, apellidos: true, establecimientoId: true },
  });

  // 4. Ask Claude (vision) to read the paper
  const readerPrompt = `Esta imagen es una hoja semanal de preferencias de turnos de una carnicería. Los empleados marcan a mano letras en las celdas de los días.

ESTRUCTURA de la hoja:
- Cabecera: nombre del establecimiento y fechas de la semana (a menudo manuscritas, ej: "de 22 al 28 juny"). El año suele estar impreso.
- Columnas de días en catalán: DLL=LUNES, DT=MARTES, DM=MIERCOLES, DJ=JUEVES, DV=VIERNES, DS=SABADO, DG=DOMINGO (cada una con subcolumna "Hores").
- Filas: un empleado por fila.
- Marcas manuscritas: "M" = quiere trabajar de MAÑANA ese día; "T" = quiere trabajar de TARDE ese día. Celda vacía = sin preferencia.

ESTABLECIMIENTOS VÁLIDOS:
${establishments.map((e) => `- id ${e.id}: ${e.nombre}`).join('\n')}

EMPLEADOS VÁLIDOS (id: nombre completo — establecimientoId):
${rosterEmployees.map((e) => `- ${e.id}: ${e.nombre} ${e.apellidos} — est ${e.establecimientoId}`).join('\n')}

INSTRUCCIONES:
1. Identifica el establecimiento por la cabecera (coincidencia parcial de nombre vale, ej: "AMETLLER GIRONA" → "Girona").
2. Extrae la fecha de inicio de la semana (lunes) en formato ISO. Usa el año impreso en la hoja.
3. Para CADA fila con marcas, empareja el nombre del papel con el empleado válido más parecido (ignora tildes y segundos apellidos). Si no hay ninguno razonablemente parecido, empleadoId: null.
4. Lee SOLO marcas claramente visibles. No inventes marcas.
5. Anota cualquier nota manuscrita o impresa relevante al pie.

Responde SOLO con JSON válido:
{"establecimientoId": <id o null>, "fechaInicioSemana": "YYYY-MM-DD" | null, "empleados": [{"nombreEnPapel": "...", "empleadoId": <id|null>, "marcas": [{"dia": "LUNES|MARTES|MIERCOLES|JUEVES|VIERNES|SABADO|DOMINGO", "marca": "M|T"}]}], "notas": ["..."]}`;

  let parsed;
  try {
    const response = await anthropic.messages.create({
      model: PAPER_MODEL,
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
          { type: 'text', text: readerPrompt },
        ],
      }],
    });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (err) {
    console.error('[Paper] vision/parse error:', err);
    await respon('No he podido leer la hoja. Asegúrate de que la foto esté bien iluminada y recta, y vuelve a intentarlo.');
    return { handled: true, reason: 'paper_read_failed' };
  }

  // 5. Resolve establishment + week
  let estId = parsed.establecimientoId;
  if (!establishments.some((e) => e.id === estId)) estId = null;
  if (!estId && managed.length === 1) estId = managed[0].id; // fallback: the establishment they manage
  if (!estId && sender.establecimientoId) estId = sender.establecimientoId;
  if (!estId) {
    await respon('No he podido identificar el establecimiento de la hoja. Asegúrate de que el nombre sea visible en la cabecera.');
    return { handled: true, reason: 'establishment_not_identified' };
  }
  // Qui puja el full ha de poder entrar a la botiga que hi surt. Si no, es
  // refusa abans de desar res: si no, una encarregada que fotografiés el full
  // de l'altra botiga n'hi escriuria les preferències.
  if (opts.botigues && !opts.botigues.includes(estId)) {
    const quina = establishments.find((e) => e.id === estId)?.nombre || `#${estId}`;
    await respon(`Aquest full és de ${quina}, i no hi tens accés. No he desat res.`);
    return { handled: true, reason: 'establishment_not_allowed', establecimientoId: estId };
  }

  const estName = establishments.find((e) => e.id === estId)?.nombre || `#${estId}`;

  let semana;
  let semanaAsumida = false;
  if (parsed.fechaInicioSemana && /^\d{4}-\d{2}-\d{2}$/.test(parsed.fechaInicioSemana)) {
    semana = isoWeekOfDate(new Date(parsed.fechaInicioSemana));
  } else {
    semana = getNextWeek(); // couldn't read the dates — assume next week
    semanaAsumida = true;
  }

  // A sheet is filled in for the week about to be planned. Any other week means
  // the dates were misread — and misreading them is quieter than failing to read
  // them, because that path says so while this one just files the preferences
  // somewhere nobody will look.
  const semanasEsperadas = [getCurrentWeek(), getNextWeek()];
  const semanaInesperada = !semanaAsumida && !semanasEsperadas.includes(semana);

  // 6. Save preferences (only employees matched to THIS establishment's roster)
  const validIds = new Set(rosterEmployees.filter((e) => e.establecimientoId === estId).map((e) => e.id));
  const DIAS_OK = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  const saved = [];
  const unmatched = [];
  const conflictes = [];
  const dissabtes = [];

  for (const empPaper of parsed.empleados || []) {
    const marcas = (empPaper.marcas || []).filter(
      (m) => DIAS_OK.includes(m.dia) && (m.marca === 'M' || m.marca === 'T')
    );
    if (marcas.length === 0) continue;
    if (!empPaper.empleadoId || !validIds.has(empPaper.empleadoId)) {
      unmatched.push(empPaper.nombreEnPapel || '(sin nombre)');
      continue;
    }

    // Les marques van a `turnosPorDia`, que és on el motor les garanteix amb
    // passades deterministes. Fins ara anaven només a `notasAdicionales`, que
    // el motor mira una sola vegada i només per passar-la a la IA com a text:
    // una M escrita al paper era una suggerència i la mateixa M dita pel
    // WhatsApp una garantia, tot i ser la mateixa petició de la mateixa persona.
    const delPaper = {};
    for (const m of marcas) delPaper[m.dia] = TORN_DE_LA_MARCA[m.marca];

    // El dissabte del full, abans de res: si trenca el repartiment no es desa i
    // es diu a qui té el full a la mà, que és qui pot decidir.
    if (delPaper.SABADO) {
      const v = await dissabteDelFullPassa(empPaper.empleadoId, estId, semana, delPaper.SABADO);
      if (!v.passa) {
        dissabtes.push(`${emp0(rosterEmployees, empPaper.empleadoId)}: el full demana `
          + `${delPaper.SABADO} el dissabte, i l'últim que va fer va ser ${v.ultim}. `
          + 'No l\'he desat; si toca, posa-l\'hi tu.');
        delete delPaper.SABADO;
      }
    }

    const existing = await prisma.shiftPreference.findFirst({
      where: { empleadoId: empPaper.empleadoId, semana, activa: true },
    });

    // Quan es contradiuen, mana el que ha dit la persona i no el paper. El full
    // s'omple a la paret uns dies abans; el WhatsApp és d'aquesta setmana i
    // l'hi ha dit ella mateixa. Cas real: la Montse va apuntar matí al full i
    // després va demanar festa pel WhatsApp — ha de quedar festa.
    const jaDit = existing && existing.recogidoVia !== 'PAPEL' ? existing : null;
    const { turnosPorDia: turnosFinals, guanyats, conflictes: xocs } =
      fusionaPaperIWhatsapp(delPaper, jaDit);
    for (const c of xocs) {
      const qui = emp0(rosterEmployees, empPaper.empleadoId);
      const mana = c.mana === 'FESTA' ? 'va demanar festa' : `va demanar ${c.mana}`;
      conflictes.push(`${qui} ${c.dia.slice(0, 3)}: el full deia ${c.deiaElFull}, però ${mana}`);
    }

    const resum = `Papel (semana del ${weekLabel(semana)}): ` + marcas.map((m) => `${m.dia} quiere ${TURNO_LABEL[m.marca]}`).join('; ');
    // No s'esborra el que va dir pel WhatsApp: s'hi afegeix a sota. Abans això
    // era una manera silenciosa que el paper guanyés.
    const notas = jaDit?.notasAdicionales ? `${jaDit.notasAdicionales}\n${resum}` : resum;

    if (existing) {
      await prisma.shiftPreference.update({
        where: { id: existing.id },
        data: {
          notasAdicionales: notas,
          turnosPorDia: turnosFinals,
          // L'origen només passa a PAPEL si no venia de la persona. Si hi
          // consta WHATSAPP i l'hi poséssim, la propera foto del mateix full
          // ja no el veuria com a seu i li passaria per sobre.
          ...(jaDit ? {} : { recogidoVia: 'PAPEL' }),
        },
      });
    } else {
      await prisma.shiftPreference.create({
        data: {
          empleadoId: empPaper.empleadoId,
          semana,
          turnoPreferido: null,
          diasNoDisponible: [],
          turnosPorDia: turnosFinals,
          notasAdicionales: notas,
          recogidoVia: 'PAPEL',
          activa: true,
        },
      });
    }
    const emp = rosterEmployees.find((e) => e.id === empPaper.empleadoId);
    const desats = Object.entries(guanyats).map(([d, t]) => `${d.slice(0, 3)} ${t === 'MANANA' ? 'M' : 'T'}`);
    saved.push(`${emp.nombre} ${emp.apellidos}: ${desats.length ? desats.join(', ') : '(res, mana el que va dir pel WhatsApp)'}`);
  }

  // 7. Keep the photo. The model reads handwriting, and a mark read one column
  // across or a row skipped comes out structurally perfect — nothing downstream
  // can catch either. Without the image, its reading is the only record of what
  // the paper said, and a fortnight later there is nothing to check against.
  // WhatsApp compresses photos before they arrive, and these are purged with the
  // preferences they belong to.
  let fullId = null;
  try {
    const full = await prisma.paperSheet.create({
      data: {
        establecimientoId: estId,
        semana,
        enviadoPorId: sender.id,
        telefono,
        mimeType: mediaType,
        imagen: buffer,
        lectura: parsed,
      },
      select: { id: true },
    });
    fullId = full.id;
  } catch (err) {
    // Never lose the import over the copy of it.
    console.error('[Paper] no s\'ha pogut desar la imatge:', err.message);
  }

  // 8. Reply with a summary so the manager can verify
  const lines = [
    `He leído la hoja de ${estName} para la semana del ${weekLabel(semana)}${semanaAsumida ? ' (fechas no legibles — he asumido la semana próxima)' : ''}.`,
  ];
  if (semanaInesperada) {
    lines.push(`\n⚠️ ATENCIÓN: esa no es ni esta semana ni la próxima. Puede que haya leído mal las fechas de la hoja. Compruébalo antes de dar las preferencias por buenas.`);
  }
  if (saved.length > 0) {
    lines.push(`\nPreferencias guardadas (${saved.length}):`);
    for (const s of saved) lines.push(`- ${s}`);
  } else {
    lines.push('\nNo he encontrado ninguna marca legible en la hoja.');
  }
  if (unmatched.length > 0) {
    lines.push(`\nNo reconocidos en la app (ignorados): ${unmatched.join(', ')}.`);
  }
  // Es diuen sempre. Descartar una marca en silenci és com el paper guanyava
  // abans: ningú se n'assabentava fins a veure l'horari.
  if (conflictes.length > 0) {
    lines.push(`\nEl full deia una cosa i ells n'havien dit una altra. Mana el que van dir:`);
    for (const c of conflictes) lines.push(`- ${c}`);
  }
  if (dissabtes.length > 0) {
    lines.push(`\nDissabtes que trencarien l'alternança:`);
    for (const d of dissabtes) lines.push(`- ${d}`);
  }
  if (parsed.notas && parsed.notas.length > 0) {
    lines.push(`\nNotas de la hoja: ${parsed.notas.join(' | ')}`);
  }
  lines.push('\nPuedes revisar o corregir las preferencias en la aplicación.');
  if (fullId) lines.push('La foto de la hoja queda guardada por si hay que comprobar algo.');
  const reply = lines.join('\n');
  await respon(reply);

  return {
    handled: true, reason: 'paper_imported', semana, establecimientoId: estId,
    guardados: saved.length, noReconocidos: unmatched, semanaInesperada, fullId, resumen: reply,
  };
}

// ─────────────────────────────────────────────
// HANDLE INCOMING TEXT MESSAGE — AI chatbot logic
// ─────────────────────────────────────────────
// Only a fallback now: while the request window is open the chat stays open,
// so this applies to conversations that carry no deadline.
const EDIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * May somebody who already confirmed still change or add something?
 *
 * Yes for as long as the window is open. Nothing is generated until after the
 * deadline, so a correction that arrives before it costs nothing — and being
 * sent to your manager for a change you could have typed in five seconds is
 * exactly the friction the chatbot exists to remove.
 *
 * The ten minutes survive only for conversations with no deadline stored.
 */
export function potRectificar(conv, ara = new Date()) {
  if (conv.fechaLimite) return ara.getTime() < new Date(conv.fechaLimite).getTime();
  const desat = conv.completedAt || conv.updatedAt;
  return Boolean(desat) && ara.getTime() - new Date(desat).getTime() < EDIT_WINDOW_MS;
}

const IRRELEVANT_WARNING =
  'Informació irrellevant. Després d\'aquest missatge, si no facilita les seves preferències, el xatbot es bloquejarà i no podrà desar-les.';

// Máximo de días libres/festivos que un empleado puede pedir por semana.
const MAX_DIAS_LIBRES = 2;
// Prou per absorbir un reintent o un job duplicat, prou poc per deixar enviar
// un segon recordatori un altre dia si algun dia se'n vol un.
const RECORDATORI_MARGE_MS = 12 * 60 * 60 * 1000;

// Quantes hores abans de tancar-se la finestra s'envia el recordatori.
/**
 * Quan un enviament automàtic ha d'ensenyar la bandera vermella (503, que és el
 * que fa saltar el correu de feina fallida de cron-job.org).
 *
 * Una botiga que peta sencera, sempre: això és codi trencat o base de dades
 * caiguda. Un telèfon individual que falla, no — amb el batec cada hora es
 * reintentaria i faria sonar l'alarma vint-i-quatre vegades al dia per una sola
 * persona amb el número mal escrit, i una alarma que sona sempre deixa de ser
 * una alarma justament el dia que sona de veritat.
 *
 * Però si no n'ha sortit ni un i han fallat tots, allò ja no és un telèfon mal
 * escrit: és WhatsApp caigut, i llavors sí. Aquest era el motiu pel qual els
 * fallits individuals comptaven, i es conserva.
 */
export function esFallidaDeFeina({ enviats, fallits, botiguesAmbError }) {
  if (botiguesAmbError > 0) return true;
  return enviats === 0 && fallits > 0;
}

export const HORES_ABANS_DE_RECORDAR = 24;

/**
 * Si ara toca enviar el recordatori.
 *
 * Abans ho decidia l'horari del cron: dimarts al matí, escrit a cron-job.org.
 * Això volia dir que moure la finestra des de la pantalla d'ajustos no movia el
 * recordatori, i que ningú no se n'assabentava. Ara ho decideix la finestra: el
 * recordatori surt quan queda menys d'un dia per tancar, sigui quin sigui el
 * dia que s'hagi configurat.
 */
export function tocaRecordar(ara, tanca, hores = HORES_ABANS_DE_RECORDAR) {
  const falten = new Date(tanca).getTime() - new Date(ara).getTime();
  return falten > 0 && falten <= hores * 60 * 60 * 1000;
}

// ── When the chatbot is open ────────────────────────────────────────────────
//
// From Sunday at 09:00 to Wednesday at 13:00, the week before the one being
// planned. Outside that it does not take preferences, and — this is the part
// that was missing — it says so instead of going quiet.
//
// Measured backwards from the Monday of the target week, never from the day
// the broadcast happens to be sent. Deriving it from "today" only worked by
// coincidence: sent on a Monday it landed correctly, sent later in the week it
// landed INSIDE the week being scheduled, by which point the schedule is
// published and people have already worked half of it.
// The window now comes from the settings panel, not from a variable on the
// hosting dashboard: changing it used to need a redeploy and somebody who
// knows what a environment variable is.
export const FINESTRA_DEFECTE = { obreDia: 0, obreHora: 9, tancaDia: 3, tancaHora: 13 };

// Day names per language. The deadline is embedded inside messages written in
// the employee's own language, so a Spanish "jueves" landing in the middle of a
// Catalan sentence reads like a bug — because it is one.
const DIAS_LANG = {
  ca: ['diumenge', 'dilluns', 'dimarts', 'dimecres', 'dijous', 'divendres', 'dissabte'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

/** The day of the week `dow`, in the seven days BEFORE this week's Monday. */
function diaAbansDe(monday, dow, hora) {
  const enrere = ((1 - dow + 7) % 7) || 7;   // Monday back to the previous `dow`
  const d = new Date(monday);
  d.setDate(monday.getDate() - enrere);
  d.setHours(hora, 0, 0, 0);
  return d;
}

/**
 * The window for one week's preferences: when it opens and when it shuts.
 *
 * Sunday comes before Wednesday in the same run-up, so the opening is one more
 * day back than the plain "previous Sunday" would give.
 */
export function finestraPeticions(semana, config = FINESTRA_DEFECTE) {
  const { monday } = getWeekDates(semana);
  const tanca = diaAbansDe(monday, config.tancaDia, config.tancaHora);
  let obre = diaAbansDe(monday, config.obreDia, config.obreHora);
  if (obre.getTime() >= tanca.getTime()) obre = new Date(obre.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { obre, tanca };
}

/** The window as configured right now. */
export async function finestraConfigurada(semana) {
  const a = await ajustos();
  return finestraPeticions(semana, {
    obreDia: a.whatsappObreDia, obreHora: a.whatsappObreHora,
    tancaDia: a.whatsappTancaDia, tancaHora: a.whatsappTancaHora,
  });
}

/** La setmana ISO que conté una data. */
function setmanaDe(data) {
  const d = new Date(data);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const num = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(num).padStart(2, '0')}`;
}

/**
 * Quina setmana s'està demanant ara mateix: la que té la finestra oberta.
 *
 * NO es pot fer servir getNextWeek() per a això. És «la setmana ISO d'avui més
 * set dies», i de dilluns a dissabte això és la setmana vinent — però diumenge
 * més set dies és un altre diumenge, que encara pertany a la setmana que
 * comença DEMÀ, perquè les setmanes ISO acaben en diumenge.
 *
 * Com que la finestra obre precisament en diumenge, l'enviament automàtic
 * hauria demanat cada setmana les preferències de la setmana que comença
 * l'endemà, amb l'horari ja generat i publicat. I com que aquella gent ja té
 * conversa d'aquella setmana, la guarda els hauria saltat tots: el cron no
 * hauria fet res, en silenci, cada diumenge.
 *
 * Derivat de la finestra en comptes de comptar dies a mà, així si algun dia es
 * mou des d'Ajustos això segueix quadrant. `null` si ara no hi ha cap finestra
 * oberta: llavors l'enviament automàtic no ha de fer res.
 */
export function setmanaEnFinestra(ara = new Date(), config = FINESTRA_DEFECTE) {
  const vistes = new Set();
  for (let dies = 1; dies <= 21; dies++) {
    const cand = setmanaDe(new Date(ara.getTime() + dies * 24 * 60 * 60 * 1000));
    if (vistes.has(cand)) continue;
    vistes.add(cand);
    const { obre, tanca } = finestraPeticions(cand, config);
    if (ara >= obre && ara <= tanca) return cand;
  }
  return null;
}

/** La mateixa cosa, amb la finestra tal com està configurada. */
export async function setmanaEnFinestraConfigurada(ara = new Date()) {
  const a = await ajustos();
  return setmanaEnFinestra(ara, {
    obreDia: a.whatsappObreDia, obreHora: a.whatsappObreHora,
    tancaDia: a.whatsappTancaDia, tancaHora: a.whatsappTancaHora,
  });
}

/** Active or next collection window, including before its opening day. */
export function properaFinestra(ara, config) {
  const candidates = new Map();
  for (let days = 0; days <= 28; days++) {
    const semana = setmanaDe(new Date(ara.getTime() + days * 86400000));
    const window = finestraPeticions(semana, config);
    if (window.tanca >= ara) candidates.set(semana, { semana, ...window });
  }
  return [...candidates.values()].sort((a, b) => a.obre - b.obre)[0];
}

/**
 * `config` estalvia anar a buscar els ajustos: qui ja té la finestra la passa,
 * i les proves no necessiten base de dades per comprovar l'aritmètica.
 */
export async function computeDeadline(semana, from = new Date(), config = null) {
  const { tanca } = config ? finestraPeticions(semana, config) : await finestraConfigurada(semana);

  // A broadcast sent after its own deadline would be dead on arrival: every
  // reply would be silently discarded. Give a minimum window instead.
  const MIN_MARGEN_MS = 24 * 60 * 60 * 1000;
  if (tanca.getTime() - from.getTime() < MIN_MARGEN_MS) {
    const minim = from.getTime() + MIN_MARGEN_MS;
    const margen = new Date(minim);
    margen.setHours(tanca.getHours(), 0, 0, 0);
    // Rounding to 13:00 can land BEFORE the minimum — sent at 20:00, the next
    // day's 13:00 is only seventeen hours away, not twenty-four.
    if (margen.getTime() < minim) margen.setDate(margen.getDate() + 1);
    return margen;
  }
  return tanca;
}

function deadlineLabel(date, lang = 'ca') {
  const d = new Date(date);
  const dias = DIAS_LANG[lang] || DIAS_LANG.ca;
  const aLes = lang === 'es' ? 'a las' : 'a les';
  const hora = d.getHours() === 0 && d.getMinutes() === 0
    ? ''
    : ` ${aLes} ${d.getHours()}${d.getMinutes() ? ':' + String(d.getMinutes()).padStart(2, '0') : 'h'}`;
  return `${dias[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}${hora}`;
}

export function deadlineParts(date) {
  const value = new Date(date);
  if (!Number.isFinite(value.getTime())) throw new Error('Termini no vàlid.');
  return { date: new Intl.DateTimeFormat('ca-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'long' }).format(value),
    time: new Intl.DateTimeFormat('ca-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }).format(value) };
}

// Which of the two languages to answer a closed-window message in. The model
// is not involved here — this reply is a fixed sentence — so it is decided by
// looking for the handful of words that only ever appear in one of them.
function idiomaDelText(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(puedo|quiero|jueves|miércoles|miercoles|gracias|hola,? qué|mañana|día|estoy|necesito)\b/.test(t)) return 'es';
  return 'ca';
}

// What somebody gets for writing when it is shut. One message, then the
// conversation locks — so a person who keeps typing is not answered twice, and
// the silence that used to be here does not look like a broken number.
// Els «no» del xat, en l'idioma de qui escriu.
//
// Anaven sempre en català perquè són text fix, no els escriu el model — i el
// model, en canvi, sí que contesta en castellà o anglès a qui hi escriu.
// O sigui que la conversa canviava d'idioma justament al missatge més delicat
// de tots: el que li diu que no.
const REBUIG = {
  massaDies: {
    ca: (max, dolors) => `El màxim són ${max} dies lliures per setmana, i per aquí no ho puc registrar. Si ho necessites per causa major, parla-ho directament amb ${dolors}.\n\nEm pots indicar com a màxim ${max} dies en què realment no puguis treballar?`,
    es: (max, dolors) => `El máximo son ${max} días libres por semana, y por aquí no lo puedo registrar. Si lo necesitas por causa mayor, háblalo directamente con ${dolors}.\n\n¿Me puedes indicar como máximo ${max} días en los que realmente no puedas trabajar?`,
    en: (max, dolors) => `The maximum is ${max} days off per week, and I cannot register this here. If you need it for a serious reason, please speak to ${dolors} directly.\n\nCould you tell me at most ${max} days you genuinely cannot work?`,
  },
  massaPocsDies: {
    ca: (dolors) => `Aquests dies no els puc registrar per aquí. Si ho necessites per causa major, parla-ho directament amb ${dolors}.\n\nEm pots dir quins dies realment no pots treballar?`,
    es: (dolors) => `Estos días no los puedo registrar por aquí. Si lo necesitas por causa mayor, háblalo directamente con ${dolors}.\n\n¿Me puedes decir qué días realmente no puedes trabajar?`,
    en: (dolors) => `I cannot register these days here. If you need it for a serious reason, please speak to ${dolors} directly.\n\nCould you tell me which days you genuinely cannot work?`,
  },
};

/** El text del rebuig, amb el català com a xarxa si l'idioma no el tenim. */
export function textRebuig(quin, idioma, ...args) {
  const joc = REBUIG[quin];
  return (joc[idioma] || joc.ca)(...args);
}

const TANCAT_MSG = {
  ca: (limit) => `Hola. El termini per enviar les preferències d'horari ja s'ha acabat (era ${limit}) i el xat no està disponible ara mateix.\n\nTornarà a obrir-se diumenge al matí per a la setmana següent. Si necessites alguna cosa abans, parla-ho amb la responsable.`,
  es: (limit) => `Hola. El plazo para enviar las preferencias de horario ya ha terminado (era ${limit}) y el chat no está disponible ahora mismo.\n\nVolverá a abrirse el domingo por la mañana para la semana siguiente. Si necesitas algo antes, háblalo con la responsable.`,
};

// Responsable general (la Dolors) para redirigir peticiones que el bot no acepta.
async function getGeneralManagerContact() {
  const gm = await prisma.employee.findFirst({
    where: { rol: 'MANAGER_GENERAL', activo: true },
    select: { nombre: true, telefonoWhatsapp: true },
    orderBy: { id: 'asc' },
  });
  const nombre = gm?.nombre || 'la responsable general';
  return gm?.telefonoWhatsapp ? `${nombre} (${gm.telefonoWhatsapp})` : nombre;
}

// `semana` ve de la conversa: és la que s'està demanant en aquell moment. Els
// missatges es queden per sempre (fins a la purga de retenció) i el model només
// ha de veure els de la setmana en curs.
async function logInbound(convId, texto, semana = null) {
  await prisma.whatsappMessage.create({
    data: { conversacionId: convId, direccion: 'entrante', contenido: texto, semana },
  });
}

async function logOutboundAndSend(telefono, convId, texto, semana = null) {
  await sendWhatsappMessage(telefono, texto);
  await prisma.whatsappMessage.create({
    data: { conversacionId: convId, direccion: 'saliente', contenido: texto, semana },
  });
}

// ─────────────────────────────────────────────
// MANAGER MODE (general manager only)
// Interprets management commands ("la Montse està de baixa del 4 al 8") and,
// after an explicit confirmation, registers the absence. Nothing is ever
// written without the manager replying "sí" first.
// ─────────────────────────────────────────────
const pendingManagerActions = new Map(); // phone → { action, expiresAt }
const PENDING_TTL_MS = 10 * 60 * 1000;

// Recent turns of the manager conversation. Without this, only the current
// message reached the model: asked anything back, the manager's answer arrived
// stripped of all context and the reply was a fresh greeting.
// Manager exchanges are short and transactional, so a handful of turns held in
// memory is enough — and unlike the employee flow, nothing here is worth
// persisting once the action is registered.
const managerHistory = new Map(); // phone → { turns: [{role, content}], expiresAt }
const HISTORY_TTL_MS = 15 * 60 * 1000;
const HISTORY_MAX_TURNS = 8;

function getManagerHistory(telefono) {
  const entry = managerHistory.get(telefono);
  if (!entry || Date.now() > entry.expiresAt) {
    managerHistory.delete(telefono);
    return [];
  }
  return entry.turns;
}

function pushManagerTurn(telefono, role, content) {
  const turns = getManagerHistory(telefono);
  turns.push({ role, content });
  managerHistory.set(telefono, {
    turns: turns.slice(-HISTORY_MAX_TURNS),
    expiresAt: Date.now() + HISTORY_TTL_MS,
  });
}

const ABSENCE_TOOL = {
  name: 'registrar_ausencia',
  description: 'Registra una baixa mèdica o vacances d\'un treballador. Només crida aquesta eina quan tinguis clar el treballador i les dates.',
  input_schema: {
    type: 'object',
    properties: {
      empleadoId: { type: 'integer', description: 'Id del treballador (de la llista proporcionada).' },
      tipo: { type: 'string', enum: ['BAJA_MEDICA', 'VACACIONES'] },
      fechaInicio: { type: 'string', description: 'YYYY-MM-DD' },
      fechaFin: { type: 'string', description: 'YYYY-MM-DD (igual que fechaInicio si és un sol dia)' },
    },
    required: ['empleadoId', 'tipo', 'fechaInicio', 'fechaFin'],
  },
};

const AFFIRMATIVE = /^\s*(s[ií]|yes|ok|okey|d'acord|dacord|confirmo|confirmar|correcte|correcto|va)\s*[.!]*\s*$/i;
const NEGATIVE = /^\s*(no|cancel·la|cancela|cancelar|anul·la|anula)\s*[.!]*\s*$/i;

// Dir que sí a la pregunta del dissabte, amb les paraules que fa servir la gent.
// Va a part d'AFFIRMATIVE a posta: aquell el fa servir el circuit de les
// absències de l'encarregada, i allà confirmar una baixa amb un «genial» seria
// massa lleuger. Aquí només decideix si es demana un torn, i val més entendre
// de més que deixar la pregunta penjada.
const SI_DISSABTE = /^\s*(s[ií]|sisi|yes|ok+|okey|okay|oki|d'acord|dacord|confirmo|confirmar|correcte|correcto|va|val|vale|entesos|entendido|rebut|perfecte|perfecto|genial|molt b[eé]|muy bien|bien|b[eé]|i tant|es clar|clar|clar que s[ií])\s*[.!]*\s*$/i;
const NO_DISSABTE = /^\s*(no|no cal|no calen|deixa[- ]ho|d[eé]ixa[- ]ho|millor no|ja est[aà]|nop|negatiu)\s*[.!]*\s*$/i;

async function handleManagerMessage(telefono, texto, manager) {
  // 1. Pending confirmation?
  const pending = pendingManagerActions.get(telefono);
  if (pending && Date.now() > pending.expiresAt) pendingManagerActions.delete(telefono);

  if (pending && Date.now() <= pending.expiresAt) {
    if (AFFIRMATIVE.test(texto)) {
      pendingManagerActions.delete(telefono);
      const a = pending.action;
      // Language of the ORIGINAL request, not of the bare "sí" that confirms it.
      const lang = pending.idioma || detectIdioma(texto);
      // Re-checked at confirmation time, not only when the action was proposed:
      // minutes can pass before the "sí", and another manager may have filed the
      // same leave meanwhile.
      const solapada = await findOverlappingAbsence({
        tipo: a.tipo, empleadoId: a.empleadoId, establecimientoId: a.establecimientoId,
        fechaInicio: a.fechaInicio, fechaFin: a.fechaFin,
      });
      if (solapada) {
        const prefix = { ca: 'No ho he registrat.', es: 'No lo he registrado.', en: "I haven't recorded it." }[lang];
        await sendWhatsappMessage(telefono, `${prefix} ${describeOverlap(solapada, a.tipo, lang)}`);
        return { handled: true, reason: 'manager_absence_overlap' };
      }
      await prisma.absence.create({
        data: {
          tipo: a.tipo,
          fechaInicio: new Date(a.fechaInicio),
          fechaFin: new Date(a.fechaFin),
          empleadoId: a.empleadoId,
          establecimientoId: a.establecimientoId,
          estado: 'APROBADO',
          notas: `Registrada per WhatsApp per ${manager.nombre}`,
        },
      });
      const tipoLabel = a.tipo === 'BAJA_MEDICA'
        ? { ca: 'baixa mèdica', es: 'baja médica', en: 'sick leave' }[lang]
        : { ca: 'vacances', es: 'vacaciones', en: 'holiday' }[lang];
      const saved = {
        ca: `Fet. He registrat la ${tipoLabel} de ${a.empleadoNombre} del ${a.fechaInicio} al ${a.fechaFin}. Es tindrà en compte en generar els horaris.`,
        es: `Hecho. He registrado la ${tipoLabel} de ${a.empleadoNombre} del ${a.fechaInicio} al ${a.fechaFin}. Se tendrá en cuenta al generar los horarios.`,
        en: `Done. I've recorded ${a.empleadoNombre}'s ${tipoLabel} from ${a.fechaInicio} to ${a.fechaFin}. It will be taken into account when generating schedules.`,
      }[lang];
      await sendWhatsappMessage(telefono, saved);
      return { handled: true, reason: 'manager_absence_saved' };
    }
    if (NEGATIVE.test(texto)) {
      pendingManagerActions.delete(telefono);
      await sendWhatsappMessage(telefono, {
        ca: 'D\'acord, ho descarto. No he registrat res.',
        es: 'De acuerdo, lo descarto. No he registrado nada.',
        en: "Okay, discarded. I haven't recorded anything.",
      }[pending.idioma || detectIdioma(texto)]);
      return { handled: true, reason: 'manager_action_cancelled' };
    }
    // Anything else: drop the pending action and treat the message as a new command
    pendingManagerActions.delete(telefono);
  }

  // 2. Interpret the command with Claude (+ roster so it can resolve names)
  const roster = await prisma.employee.findMany({
    where: { activo: true, rol: 'EMPLEADO' },
    select: { id: true, nombre: true, apellidos: true, establecimientoId: true, establecimiento: { select: { nombre: true } } },
  });
  // Amb `toISOString()` la data es converteix a UTC abans de retallar-la: a
  // Madrid, entre mitjanit i les dues de la matinada diria el dia d'ahir. És
  // el mateix error que feia que el bot digués «el diumenge 31» quan era
  // dilluns, i aquesta data també va al prompt.
  const ara = new Date();
  const today = `${ara.getFullYear()}-${String(ara.getMonth() + 1).padStart(2, '0')}-${String(ara.getDate()).padStart(2, '0')}`;

  const idiomaManager = detectIdioma(texto);
  const system = `## IDIOMA
La responsable escriu en ${LANG_NAME[idiomaManager]}. Respon SEMPRE en ${LANG_NAME[idiomaManager]}, incloent-hi el resum de confirmació. Això ja està decidit: no dedueixis l'idioma d'aquest prompt (està escrit en català) ni de missatges anteriors.

Ets l'assistent de gestió d'horarIA per WhatsApp. Parles amb ${manager.nombre}, la responsable general de l'empresa. Respon de manera breu i professional, sense emojis.

Avui és ${today}.

POTS FER: registrar baixes mèdiques i vacances de treballadors amb l'eina registrar_ausencia.
- Si el nom és ambigu o no és a la llista, NO cridis l'eina: demana aclariment.
- Si falten les dates o són ambigües, NO cridis l'eina: pregunta-les.
- MOLT IMPORTANT: quan ja tinguis el treballador i les dues dates, crida l'eina IMMEDIATAMENT. NO demanis confirmació tu mateix ni escriguis coses com "vull confirmar les dates" o "és correcte?": el sistema ja mostra un resum i demana el SÍ després de cridar l'eina. Si ho preguntes tu, la confirmació de la responsable no queda registrada enlloc i l'absència es perd.
- Una data de fi sense any ("fins al 20 de setembre") s'entén com la primera vegada que arriba aquesta data a partir d'avui. No ho preguntis.
- Interpreta dates relatives ("demà", "la setmana que ve") a partir d'avui.
- Si demana una cosa que no pots fer (canviar horaris, regles, consultar dades…), digues-li amablement que de moment només pots registrar baixes i vacances, i que la resta es fa des de l'aplicació.

TREBALLADORS (id: nom — establiment):
${roster.map((e) => `${e.id}: ${e.nombre} ${e.apellidos} — ${e.establecimiento?.nombre || 'sense assignar'}`).join('\n')}`;

  let response;
  try {
    response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 400,
      temperature: 0,
      system,
      messages: [...getManagerHistory(telefono), { role: 'user', content: texto }],
      tools: [ABSENCE_TOOL],
    });
  } catch (err) {
    console.error('[Manager] Claude error:', err.message);
    await sendWhatsappMessage(telefono, 'Ara mateix no puc processar la petició. Torna-ho a provar en un moment.');
    return { handled: true, reason: 'manager_ai_error' };
  }

  const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === 'registrar_ausencia');
  const textOut = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();

  if (toolUse) {
    const { empleadoId, tipo, fechaInicio, fechaFin } = toolUse.input;
    const emp = roster.find((e) => e.id === empleadoId);
    const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d).getTime());
    if (!emp || !validDate(fechaInicio) || !validDate(fechaFin) || new Date(fechaFin) < new Date(fechaInicio)) {
      await sendWhatsappMessage(telefono, 'No he pogut identificar bé el treballador o les dates. Pots repetir-ho indicant nom complet i dates?');
      return { handled: true, reason: 'manager_invalid_action' };
    }
    const action = {
      empleadoId,
      empleadoNombre: `${emp.nombre} ${emp.apellidos}`.trim(),
      establecimientoId: emp.establecimientoId,
      tipo,
      fechaInicio,
      fechaFin,
    };
    // The language travels with the action: the confirmation arrives as a bare
    // "sí"/"correcte", which carries no clue of its own and would always fall
    // back to Catalan even when the request was written in Spanish.
    pendingManagerActions.set(telefono, { action, idioma: idiomaManager, expiresAt: Date.now() + PENDING_TTL_MS });
    pushManagerTurn(telefono, 'user', texto);
    pushManagerTurn(telefono, 'assistant', `He preparat el registre de ${tipo} per a ${action.empleadoNombre} del ${fechaInicio} al ${fechaFin} i he demanat confirmació.`);
    const tipoLabel = {
      ca: tipo === 'BAJA_MEDICA' ? 'BAIXA MÈDICA' : 'VACANCES',
      es: tipo === 'BAJA_MEDICA' ? 'BAJA MÉDICA' : 'VACACIONES',
      en: tipo === 'BAJA_MEDICA' ? 'SICK LEAVE' : 'HOLIDAY',
    }[idiomaManager];
    const resumen = {
      ca: `Vols que registri això?\n\n${tipoLabel} — ${action.empleadoNombre}\nDel ${fechaInicio} al ${fechaFin}\n\nRespon SÍ per confirmar o NO per descartar.`,
      es: `¿Quieres que lo registre?\n\n${tipoLabel} — ${action.empleadoNombre}\nDel ${fechaInicio} al ${fechaFin}\n\nResponde SÍ para confirmar o NO para descartar.`,
      en: `Shall I record this?\n\n${tipoLabel} — ${action.empleadoNombre}\nFrom ${fechaInicio} to ${fechaFin}\n\nReply YES to confirm or NO to discard.`,
    }[idiomaManager];
    await sendWhatsappMessage(telefono, resumen);
    return { handled: true, reason: 'manager_confirmation_requested' };
  }

  const reply = textOut || 'De moment només puc registrar baixes i vacances. Per a la resta, fes servir l\'aplicació.';
  pushManagerTurn(telefono, 'user', texto);
  pushManagerTurn(telefono, 'assistant', reply);
  await sendWhatsappMessage(telefono, reply);
  return { handled: true, reason: 'manager_reply' };
}

export async function handleIncomingMessage(telefono, texto) {
  telefono = normalizePhone(telefono);

  // ── MANAGER MODE ───────────────────────────────────────────────────────────
  // The general manager talks to a management assistant (register absences…),
  // never to the employee-preferences flow.
  const sender = await prisma.employee.findFirst({
    where: { telefonoWhatsapp: telefono, activo: true },
    select: { id: true, nombre: true, rol: true },
  });
  if (sender?.rol === 'MANAGER_GENERAL') {
    return handleManagerMessage(telefono, texto, sender);
  }

  // A phone number cannot gain access to a conversation after its employee
  // has been deactivated. Unknown senders never create business records.
  if (!sender) {
    await sendWhatsappMessage(telefono, 'No tenim aquest número associat a un treballador actiu. Contacta amb la persona responsable.');
    return { handled: false, reason: 'employee_not_found' };
  }

  // Find conversation
  //
  // Només els missatges de la setmana que s'està demanant. Ara que no
  // s'esborren, incloure'ls tots voldria dir que el model llegeix la conversa
  // de la setmana passada com si fos la d'ara i doni per fet el que aquella
  // persona va dir llavors.
  let conv = await prisma.whatsappConversation.findUnique({ where: { telefono } });
  let started = false;
  if (!conv || (conv.fechaApertura && conv.fechaLimite && new Date(conv.fechaLimite) < new Date())) {
    const a = await ajustos();
    const window = properaFinestra(new Date(), {
      obreDia: a.whatsappObreDia, obreHora: a.whatsappObreHora,
      tancaDia: a.whatsappTancaDia, tancaHora: a.whatsappTancaHora,
    });
    if (!window) throw new Error('No es pot determinar la finestra de preferències.');
    const data = { semana: window.semana, fechaApertura: window.obre, fechaLimite: window.tanca,
      estado: 'PENDIENTE', paso: 0, bloqueada: false, intentosIrrelevantes: 0,
      completedAt: null, ultimoRecordatorio: null, pendentAlternanca: null, dissabteRetirat: null };
    conv = conv
      ? await prisma.whatsappConversation.update({ where: { id: conv.id }, data })
      : await prisma.whatsappConversation.create({ data: { telefono, ...data } });
    started = true;
  }
  if (conv) {
    conv.mensajes = await prisma.whatsappMessage.findMany({
      where: { conversacionId: conv.id, semana: conv.semana,
        ...(conv.fechaApertura ? { createdAt: { gte: conv.fechaApertura } } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Persist the first inbound even outside the collection window. These
  // messages are visible to AiBrain, but never accepted as preferences early.
  if (conv.fechaApertura && new Date() < new Date(conv.fechaApertura)) {
    await logInbound(conv.id, texto, conv.semana);
    await logOutboundAndSend(telefono, conv.id,
      `Hola ${sender.nombre}. Hem rebut el teu missatge. La recollida de preferències per a la setmana del ${weekLabel(conv.semana)} obre el ${deadlineLabel(conv.fechaApertura)} i tanca el ${deadlineLabel(conv.fechaLimite)}. Torna a escriure dins d'aquest termini per indicar la teva disponibilitat.`, conv.semana);
    return { handled: true, reason: 'before_window' };
  }
  if (started && /^\s*(hola|bon dia|bona tarda|bona nit|prova|prueba|test|hello|hi)[!.?\s]*$/i.test(texto)) {
    await logInbound(conv.id, texto, conv.semana);
    await logOutboundAndSend(telefono, conv.id,
      `Hola ${sender.nombre}. Ja pots indicar la teva disponibilitat per a la setmana del ${weekLabel(conv.semana)}: quins dies no pots treballar o quin torn necessites? Tens fins al ${deadlineLabel(conv.fechaLimite)}.`, conv.semana);
    return { handled: true, reason: 'conversation_started' };
  }

  // ── BLOCKED: log inbound, no Claude call, no reply ─────────────────────────
  if (conv.bloqueada) {
    await logInbound(conv.id, texto, conv.semana);
    return { handled: true, reason: 'bloqueada' };
  }

  // Find employee + manager phone (used by several branches below)
  const employee = await prisma.employee.findFirst({
    where: { telefonoWhatsapp: telefono, activo: true },
    include: {
      establecimiento: {
        include: {
          managerLocal: { select: { id: true, telefonoWhatsapp: true, nombre: true } },
        },
      },
    },
  });

  if (!employee) {
    await logInbound(conv.id, texto, conv.semana);
    return { handled: false, reason: 'employee_not_found' };
  }

  // The shop manager is also an employee and fills in their own preferences.
  // Telling them to "contact your manager" prints their own phone number back at
  // them, which is nonsense — they are the person who resolves these requests.
  const esElEncargado = employee.establecimiento?.managerLocal?.id === employee.id;
  const managerPhone = esElEncargado
    ? null
    : (employee.establecimiento?.managerLocal?.telefonoWhatsapp || null);
  const managerName = esElEncargado
    ? null
    : (employee.establecimiento?.managerLocal?.nombre || null);

  // ── OUTSIDE THE WINDOW ─────────────────────────────────────────────────────
  // It used to lock in silence. From the other end that is indistinguishable
  // from a number that does not work, and somebody who writes on a Thursday
  // deserves to be told the deadline was Wednesday rather than left waiting.
  //
  // One message, then the lock — which returns without answering — so a person
  // who keeps typing is not told the same thing five times.
  if (conv.estado !== 'COMPLETADO' && conv.fechaLimite && Date.now() > new Date(conv.fechaLimite).getTime()) {
    await logInbound(conv.id, texto, conv.semana);
    const lang = idiomaDelText(texto);
    const missatge = (TANCAT_MSG[lang] || TANCAT_MSG.ca)(deadlineLabel(conv.fechaLimite, lang));
    await logOutboundAndSend(telefono, conv.id, missatge, conv.semana);
    await prisma.whatsappConversation.update({ where: { id: conv.id }, data: { bloqueada: true } });
    return { handled: true, reason: 'deadline_passed' };
  }

  // ── ALREADY COMPLETED ──────────────────────────────────────────────────────
  // While the window is open the chat is open: somebody who confirmed on Sunday
  // and remembers something on Tuesday can just say it. Nothing is generated
  // until after the deadline, so an edit that arrives before it costs nothing.
  //
  // Read the state as it ARRIVED, before the reopen below overwrites it — the
  // "you can generate now" notice is suppressed by comparing against this, and
  // comparing against the already-modified value silently disabled it.
  // ── Esperàvem que confirmés el dissabte? ─────────────────────────────────
  // Aquí, i no més avall, per dos motius: mentre la finestra sigui oberta el
  // seu «sí» ha de valer encara que la conversa ja consti com a completada, i
  // contestar-lo aquí no gasta ni una crida a la IA.
  if (conv.pendentAlternanca) {
    const esSi = SI_DISSABTE.test(texto);
    const esNo = NO_DISSABTE.test(texto);
    if (esSi || esNo) {
      await logInbound(conv.id, texto, conv.semana);
      const demanat = conv.pendentAlternanca;
      const idioma = idiomaDelText(texto) || 'ca';

      if (esSi) {
        // El torn s'afegeix ARA, no es guardava abans: si s'hagués desat
        // esperant el «no», un «no» que no arribés mai el deixaria concedit.
        const pref = await prisma.shiftPreference.findFirst({
          where: { empleadoId: employee.id, semana: conv.semana, activa: true },
        });
        if (pref) {
          const torns = { ...(pref.turnosPorDia || {}), SABADO: demanat };
          await prisma.shiftPreference.update({
            where: { id: pref.id },
            data: { turnosPorDia: torns },
          });
        }
      }

      await prisma.whatsappConversation.update({
        where: { id: conv.id },
        data: {
          pendentAlternanca: null,
          // Qui el retira deixa rastre. La setmana de referència encara es pot
          // tocar després —i es toca— i llavors el que li vam dir deixa de ser
          // veritat. Sense això, recuperar-lo demanava llegir-se la conversa.
          dissabteRetirat: esSi ? null : demanat,
          paso: conv.paso + 1,
        },
      });
      const resposta = esSi ? textAlternancaSi(demanat, idioma) : textAlternancaNo(idioma);
      await logOutboundAndSend(telefono, conv.id, resposta, conv.semana);
      return { handled: true, reason: esSi ? 'alternanca_confirmada' : 'alternanca_retirada' };
    }
    // Ni sí ni no: es deixa pendent i el missatge segueix el camí normal, que
    // pot ser que estigui canviant una altra cosa.
  }

  let pendentDissabte = null;
  let avisAlternanca = null;
  const estavaCompletadaEnArribar = conv.estado === 'COMPLETADO';
  let reabiertaParaEditar = false;
  if (conv.estado === 'COMPLETADO') {
    // Ja està desat i encara escriuen: «gràcies», «ok», tres emojis. És
    // educació, no informació, i contestar-la costa una crida a la IA i un
    // WhatsApp cada vegada. Es queda apuntat al registre i no es contesta:
    // ningú no espera resposta a un «igualment».
    // `!conv.pendentAlternanca` és el que de debò tanca el forat, i no la
    // llista de dalt: amb una pregunta esperant resposta, QUALSEVOL cosa que
    // escrigui pot ser-ne la resposta. Un «val» que caigués aquí es registrava
    // i no es contestava, la persona es pensava que havia dit que sí, i la
    // pregunta quedava penjada per sempre sense que ho sabés ningú.
    if (!conv.pendentAlternanca && esComiat(texto)) {
      await logInbound(conv.id, texto, conv.semana);
      return { handled: true, reason: 'comiat' };
    }

    if (!potRectificar(conv)) {
      await logInbound(conv.id, texto, conv.semana);
      const phoneLine = managerPhone
        ? ` Si necessites canviar alguna cosa, contacta amb el teu encarregat${managerName ? ` ${managerName}` : ''}: ${managerPhone}.`
        : esElEncargado
          ? ` Per a qualsevol canvi, contacta amb ${await getGeneralManagerContact()}.`
          : ' Per a qualsevol canvi, contacta amb el teu encarregat.';
      const reply = `Ja tinc les teves preferències desades per a aquesta setmana.${phoneLine}`;
      await logOutboundAndSend(telefono, conv.id, reply, conv.semana);
      // Lock so further messages cost zero (no Claude, no reply).
      await prisma.whatsappConversation.update({
        where: { id: conv.id },
        data: { bloqueada: true },
      });
      return { handled: true, reason: 'locked_after_save' };
    }

    // Dins de la finestra per rectificar: es continua cap a la IA, però NO
    // s'escriu a la base de dades que la conversa torna a estar oberta.
    //
    // Escriure-ho era l'arrel del problema de la Núria Bachs. Reobrir és una
    // cosa d'aquesta petició —deixar que el model llegeixi el que ve i pugui
    // canviar el que hi havia— i no un canvi d'estat que hagi de sobreviure-la.
    // Escrit a la base de dades, calia desfer-lo a totes les sortides de la
    // funció, i n'hi ha set: un missatge fora de tema, demanar massa dies
    // lliures, no quedar-ne prou de disponibles... Qualsevol d'elles la deixava
    // oberta per sempre amb les preferències desades, i la pantalla deia que en
    // faltava una que ja hi era.
    //
    // Sense escriure-ho, no hi ha res a desfer: si aquesta ronda desa
    // preferències noves, el camí de desar ja posa COMPLETADO amb la data
    // d'ara; i si no en desa, la conversa es queda com estava, que és el
    // correcte perquè el que hi havia desat continua sent-hi.
    conv.estado = 'EN_PROGRESO';
    // Reopening is not enough on its own: the history still shows a finished
    // summary, so without being told otherwise the model reads the follow-up as
    // "too late" and redirects the employee to their manager — the very thing
    // the edit window exists to avoid.
    reabiertaParaEditar = true;
  }

  // ── NORMAL FLOW: log inbound, call Claude ─────────────────────────────────
  await logInbound(conv.id, texto, conv.semana);

  // Build conversation history for Claude (mensajes was loaded BEFORE this inbound)
  const allMessages = [
    ...conv.mensajes.map((m) => ({
      role: m.direccion === 'saliente' ? 'assistant' : 'user',
      content: m.contenido,
    })),
    { role: 'user', content: texto },
  ];

  const semanaLabel = weekLabel(conv.semana);
  const { start: weekStart, end: weekEnd } = weekIsoRange(conv.semana);
  // Quin dia de la setmana és cada data: vegeu utils/isoWeek.js. Sense això el
  // prompt només deia «del 2026-08-31 al 2026-09-06» i el model ho endevinava.
  const calendari = calendariDeLaSetmana(weekStart).map((d) => `   ${d.text}`).join('\n');
  const maxHoras = employee.maxHorasSemana || 40;
  const minDiasNecesarios = Math.max(1, Math.ceil(maxHoras / 8)); // assume 8h max per day
  // Se le dice explícitamente al modelo que puede rectificar, porque el historial
  // que ve termina en un resumen cerrado y por sí solo concluiría que ya es tarde.
  const edicionLine = reabiertaParaEditar
    ? `IMPORTANTE: el empleado YA había confirmado sus preferencias y ahora quiere cambiarlas o añadir algo. El plazo sigue ABIERTO${conv.fechaLimite ? ` (hasta el ${deadlineLabel(conv.fechaLimite, 'es')})` : ''}, así que acepta el cambio con normalidad: recoge la corrección, actualiza el resumen ENTERO (lo anterior más lo nuevo) y vuelve a confirmar con "completo": true. NO le digas que contacte con nadie ni que ya es tarde.`
    : '';

  const managerLine = managerPhone
    ? `Si el empleado pide algo que no puedes aceptar (ver reglas de validación), invítale a contactar con su manager${managerName ? ` ${managerName}` : ''} al ${managerPhone}.`
    : esElEncargado
      ? `Esta persona ES la encargada del establecimiento y NO usa la aplicación. NUNCA le digas que contacte con su encargado (es ella misma) ni que lo gestione desde la app: si pide algo que no puedes aceptar, dile que contacte con ${await getGeneralManagerContact()}.`
      : 'Si el empleado pide algo que no puedes aceptar, dile que contacte con su manager para cambios mayores.';

  // Decided from the employee's own messages only — never from the Catalan
  // broadcast or the fixed system replies sitting in the history.
  const idiomaEmpleado = detectIdioma([
    ...conv.mensajes.filter((m) => m.direccion !== 'saliente').map((m) => m.contenido),
    texto,
  ]);

  // Els dies que la botiga té tancats cada setmana. El bot ja tenia
  // l'establiment carregat i no ho sabia: preguntava per la disponibilitat del
  // diumenge d'una botiga que tanca els diumenges, i pitjor, si algú demanava
  // el diumenge lliure l'hi apuntava — gastant-li un dels seus dos dies en un
  // dia que ja estava tancat per a tothom.
  const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  let diesTancats = [];
  const obertura = employee.establecimiento?.diasApertura;
  if (obertura) {
    try {
      const oberts = JSON.parse(obertura);
      // `Array.isArray` no és paranoia: sense ell, una llista buida o un JSON
      // que no fos una llista no peta —`includes` existeix igualment i sempre
      // diu que no— i el bot conclouria que la botiga tanca els set dies i
      // l'hi diria a tothom. Avui la pantalla d'establiments ho valida abans de
      // desar-ho, però és l'únic tallafoc i no és aquest.
      if (Array.isArray(oberts) && oberts.length > 0) {
        diesTancats = DIES.filter((d) => !oberts.includes(d));
      }
    } catch {
      // Mateix criteri que el motor: si no es pot llegir, s'ignora i es
      // pregunta per tots els dies, que és el comportament de sempre.
      console.warn('[WhatsApp] diasApertura il·legible, s\'ignora:', obertura);
    }
  }

  const systemPrompt = `## IDIOMA — LA REGLA MÁS IMPORTANTE
El empleado escribe en ${LANG_NAME[idiomaEmpleado]}. Responde SIEMPRE en ${LANG_NAME[idiomaEmpleado]}, en TODOS tus mensajes, incluido el resumen final de confirmación.
- Esto ya está decidido: NO deduzcas el idioma del historial. Los mensajes automáticos del sistema están escritos en catalán y NO indican el idioma de la conversación.
- Aunque el mensaje anterior de la conversación esté en catalán, tú responde en ${LANG_NAME[idiomaEmpleado]}.

${conv.pendentAlternanca ? `## HAY UNA PREGUNTA TUYA SIN RESPONDER
Le preguntaste si quiere pedir igualmente el turno de sábado que rompe la alternancia, y todavía no ha dicho ni sí ni no. Si en su mensaje se entiende la respuesta, dila con claridad en el resumen. Si habla de otra cosa, recuérdale al final que esa pregunta sigue pendiente. NO la des por respondida ni por retirada.

` : ''}Eres un asistente de WhatsApp de una empresa cárnica española. Tu trabajo es recoger las preferencias de turno del empleado para la semana del ${semanaLabel} (del ${weekStart} al ${weekEnd}) de forma profesional y cordial.

Datos del empleado:
- Nombre: ${employee.nombre}
- Días en los que como mínimo debe quedar disponible: ${minDiasNecesarios}. Dato interno para detectar el caso de la regla A: NUNCA se lo digas ni lo cites.
${diesTancats.length ? `- La tienda CIERRA estos días: ${diesTancats.join(', ')}. Nadie trabaja esos días.` : '- La tienda abre todos los días de la semana.'}
${employee.condicionesFijas ? `- Condiciones que YA constan en su ficha y se aplican SIEMPRE, sin que las tenga que pedir: "${employee.condicionesFijas}"` : ''}

Necesitas recoger:
1. Días no disponibles: cualquier día en que NO pueda trabajar esa semana. NO se lo preguntes como si esperaras que tenga alguno —la mayoría de semanas no lo tiene—: pregunta abierto, si necesita algo para esa semana. Si dice que no necesita nada, perfecto: eso es una respuesta completa.
   - UNA SOLA VEZ EN TODA LA CONVERSACIÓN. Cuenta cuántas veces le has preguntado ya si necesita algo o si tiene días no disponibles, mirando tus propios mensajes del historial. Si ya se lo has preguntado UNA vez, NO se lo preguntes más, digan lo que digan sus respuestas.
   - Después de esa única pregunta, con lo que te haya contestado ya tienes bastante: si no ha nombrado ningún día, es que no tiene ninguno. Marca "completo": true (SALVO que se active la regla A o la C de más abajo, que mandan sobre esto) y cierra con el resumen.
   - Una conversación COMPLETA puede no tener ningún día no disponible y ninguna necesidad de turno. Eso es lo NORMAL, no una conversación a medias: no la alargues buscando datos que no existen.
   - Volver a preguntar lo mismo con otras palabras es lo que hace que el chat parezca un formulario y no una persona. Solo repregunta si algo que SÍ ha dicho te ha quedado ambiguo (por ejemplo "el jueves mejor pronto", que no dice si es mañana o tarde).
2. Necesidades de turno puntuales: NO preguntes por un turno preferido general; el empleado NO elige su turno libremente.
   - ⚠️ ANTES de decirle que no puede elegir turno, MIRA sus condiciones de ficha (arriba).
   - Compara por SIGNIFICADO, no por palabras. La gente no repite su ficha literalmente: dice lo mismo con sus palabras y sin horas. Si en ficha pone "sempre matins de 8 a 12h" y te escribe "vull tots els torns de matí", "només puc matins" o "jo sempre faig matí", es LO MISMO — aunque no diga ninguna hora. Igual con las tardes, con un día fijo de fiesta o con cualquier otra condición.
   - Cuando coincida: NO le digas que no puede elegir ni que hable con la responsable. Dile que eso ya consta en su ficha y se le aplica cada semana sin que lo tenga que pedir, y sigue con la conversación.
   - Decirle que no puede pedir algo que YA tiene concedido es la peor respuesta posible: le hace pensar que se lo han quitado. Solo aplica la regla del turno general si lo que pide es DISTINTO de lo que tiene en ficha. Solo si el empleado indica por su cuenta que NECESITA un turno concreto (mañana o tarde) algún día en particular (por ejemplo "el jueves solo puedo por la mañana"), anótalo en las notas adicionales.
3. Notas adicionales: las necesidades de turno puntuales y cualquier otra cosa relevante.

TONO: Mantén un trato profesional, claro y cordial, tratando al empleado de "tú". NO uses emojis ni expresiones coloquiales. Sé conciso y directo.

REGLAS DE VALIDACIÓN (importantísimo):
A) Máximo de días libres por semana:
   - El empleado NO puede pedir más de ${MAX_DIAS_LIBRES} días libres/festivos por semana. Si pide ${MAX_DIAS_LIBRES + 1} o más, NO lo guardes y marca "contractMismatch": true. NO marques "completo": true.
   - Tampoco puede dejar tan pocos días disponibles que no se pueda cubrir su jornada. Mismo trato: no lo guardes y marca "contractMismatch": true.
   - CÓMO DECÍRSELO, en los dos casos: solo que por aquí no es posible, y que si lo necesita por causa mayor lo hable directamente con la responsable general (Dolors). NUNCA menciones su contrato, sus horas semanales, cuántos días necesita trabajar o quedar disponible, ni ningún número ni cálculo. Ni siquiera para justificar el motivo. Ese dato lo tienes para detectar el caso, no para soltárselo: a quien pide tres días de fiesta no se le contesta con su nómina. Una o dos frases, sin sermón y sin justificarte.

A-bis) Días que la tienda tiene CERRADOS:
   - NUNCA preguntes por su disponibilidad en un día cerrado: ya libra todo el mundo, y preguntarlo hace quedar mal al sistema.
   - Si el empleado pide libre un día que la tienda cierra, díselo con naturalidad —que ese día ya se libra— y NO lo anotes en "diasNoDisponible". Anotarlo le gastaría uno de los días libres que sí puede pedir, a cambio de nada.
   - Esto NO cuenta como respuesta incompleta: si el resto ya está, marca "completo": true igual.

A-ter) Lo que YA consta en su ficha:
   - Si lo que pide coincide con una condición que ya tiene en su ficha (arriba), NO lo trates como una petición nueva: confírmale que eso ya está guardado y que se le aplica siempre, y sigue.
   - NO lo anotes otra vez en "diasNoDisponible" ni en "turnosPorDia". Ya se aplica solo, y anotarlo como petición de esta semana consumiría uno de sus días libres o pisaría otras reglas sin necesidad.
   - Si pide algo DISTINTO de lo que consta en su ficha, eso sí es una petición nueva y se anota con normalidad.

B) Solo días dentro de la semana planeada:
   - QUÉ DÍA ES CADA FECHA de esta semana (no lo deduzcas tú, está aquí):
${calendari}
   - Si el empleado nombra una fecha, usa esta tabla. Nunca digas de qué día de
     la semana es una fecha sin mirarla aquí.
   - La semana planeada va del ${weekStart} al ${weekEnd}. Si el empleado menciona una fecha concreta fuera de ese rango (ej: "el día 25" cuando el 25 no está en la semana), NO lo guardes. Pídele que se refiera a un día dentro de esta semana o que contacte con su manager${managerPhone ? ` (${managerPhone})` : ''} para ausencias en otras fechas.
   - Los días por nombre (LUNES…DOMINGO) sí son válidos: siempre se refieren a esta semana.

C) Mensajes irrelevantes:
   - Si el empleado responde con bromas, insultos, mensajes sin sentido, conversación off-topic o intenta jugar con el chatbot (ej: "hola guapa", "cuéntame un chiste", "asdfgh", "qué tiempo hace"), responde brevemente reconduciendo a las preferencias de turno y marca "irrelevant": true en el JSON. NO marques "completo": true. NO menciones la palabra "irrelevante" — solo redirige amablemente.

${edicionLine}

${managerLine}

FORMATO DEL JSON (siempre que alguna bandera esté activa o tengas suficiente info, incluye una línea al final).
⚠️ "PREFERENCIAS_JSON" es una etiqueta técnica literal: escríbela SIEMPRE exactamente así, en castellano y sin acentos, aunque estés respondiendo en catalán o en inglés. NO la traduzcas.
Las claves del JSON ("turnoPreferido", "diasNoDisponible", "turnosPorDia"…) y sus valores (LUNES, MANANA, TARDE…) también van SIEMPRE en castellano sin acentos, sea cual sea el idioma de tu mensaje.

PREFERENCIAS_JSON:{"turnoPreferido":null,"diasNoDisponible":["LUNES",...],"turnosPorDia":{"MIERCOLES":"TARDE"},"notasAdicionales":"texto o null","completo":true|false,"irrelevant":false,"contractMismatch":false}

"turnoPreferido" debe ser SIEMPRE null (no recogemos un turno preferido general).

"turnosPorDia" es OBLIGATORIO cuando el empleado pide trabajar SOLO un turno concreto un día concreto. Es un objeto {DIA: "MANANA"|"TARDE"}. Ejemplos:
- "el miércoles solo puedo por la tarde" → {"MIERCOLES":"TARDE"}
- "dijous només al matí" → {"JUEVES":"MANANA"}
- "el viernes por la mañana tengo médico" → el empleado NO puede la mañana, así que solo puede la tarde → {"VIERNES":"TARDE"}
Si no pide ningún turno concreto, pon "turnosPorDia" como objeto vacío {}.
NUNCA pongas un día en "turnosPorDia" y en "diasNoDisponible" a la vez: si no puede trabajar en todo el día va SOLO en "diasNoDisponible".
Estas peticiones de turno concreto NO deben ir en "notasAdicionales": van SIEMPRE en "turnosPorDia". "notasAdicionales" es solo para observaciones que no encajen en los otros campos.

Cuando "completo" sea true, tu mensaje al empleado DEBE incluir un resumen tipo:
- Días no disponibles: [...]
- Turnos concretos: [...]
- Notas: [...]
Y una confirmación breve y profesional tipo "He registrado tu disponibilidad correctamente. Gracias.".

El empleado puede no tener ningún día no disponible: si dice que puede trabajar cualquier día, pon "diasNoDisponible" como lista vacía y "completo" en true.
Si aún te falta información (y no es irrelevant ni contractMismatch), simplemente pregunta lo que falta sin incluir el JSON.`;

  // Call Claude with retry logic (handles 529 overloaded errors)
  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 900, // headroom so the summary + PREFERENCIAS_JSON line never truncates
        temperature: 0.5,
        system: systemPrompt,
        messages: allMessages,
      });
      break;
    } catch (err) {
      // Retry on transient errors: 429 (rate limit), 529 (overloaded), and 5xx.
      const transient = err.status === 429 || err.status === 529 || (err.status >= 500 && err.status < 600);
      if (transient && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error(`Error del chatbot IA: ${err.message || 'API no disponible, inténtalo de nuevo en unos segundos'}`);
    }
  }

  const replyText = response.content[0].text;
  const { prefs, reply: replyToSend } = extractPreferences(replyText);

  // ── IRRELEVANT: 2-strike anti-troll logic ──────────────────────────────────
  //
  // The model decides this flag, and after two strikes it has itself written
  // "this person is trolling" into the history it then reads back. Neus Sala's
  // third message was "perdon, necesito también que el miercoles solo puedo
  // trabajar por la tarde" — a perfectly good preference — and it was counted
  // as the third strike and locked her out in silence.
  //
  // So the flag is no longer the last word: a message that carries a
  // preference, or that even talks about days and shifts, is about the
  // schedule whatever the model concluded. Being wrong here costs one
  // redirection too many; being wrong the other way locks somebody out of
  // their own rota until the following week.
  if (prefs.irrelevant && esSobreLHorari(texto, prefs)) {
    prefs.irrelevant = false;
  }
  if (prefs.irrelevant) {
    const newCount = (conv.intentosIrrelevantes || 0) + 1;
    if (newCount >= 3) {
      // Strike 3: lock silently. No Claude reply sent, no further cost.
      await prisma.whatsappConversation.update({
        where: { id: conv.id },
        data: { intentosIrrelevantes: newCount, bloqueada: true, paso: conv.paso + 1 },
      });
      return { handled: true, reason: 'locked_irrelevant', count: newCount };
    }
    if (newCount === 2) {
      // Strike 2: override Claude's reply with the verbatim warning.
      await logOutboundAndSend(telefono, conv.id, IRRELEVANT_WARNING, conv.semana);
      await prisma.whatsappConversation.update({
        where: { id: conv.id },
        data: { intentosIrrelevantes: newCount, paso: conv.paso + 1 },
      });
      return { handled: true, reason: 'irrelevant_warning', count: newCount };
    }
    // Strike 1: send Claude's normal redirection reply.
    await logOutboundAndSend(telefono, conv.id, replyToSend, conv.semana);
    await prisma.whatsappConversation.update({
      where: { id: conv.id },
      data: { intentosIrrelevantes: newCount, paso: conv.paso + 1 },
    });
    return { handled: true, reason: 'irrelevant', count: newCount };
  }

  // Reset irrelevant counter on a relevant message
  const counterUpdates =
    (conv.intentosIrrelevantes || 0) > 0 ? { intentosIrrelevantes: 0 } : {};

  // ── TOO MANY DAYS OFF: absolute limit → redirect to the general manager ─────
  // Deterministic (regardless of Claude's flags): if it parsed more than the
  // allowed days off, send the firm "max N, contact Dolors" message and don't save.
  const DIAS_VALIDOS = ['LUNES', 'MARTES', 'MIERCOLES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'SÁBADO', 'DOMINGO'];
  const diasPedidos = [...new Set((prefs.diasNoDisponible || []).map((d) => String(d).toUpperCase()))]
    .filter((d) => DIAS_VALIDOS.includes(d));
  if (diasPedidos.length > MAX_DIAS_LIBRES) {
    const dolors = await getGeneralManagerContact();
    const refusal = textRebuig('massaDies', idiomaEmpleado, MAX_DIAS_LIBRES, dolors);
    await logOutboundAndSend(telefono, conv.id, refusal, conv.semana);
    await prisma.whatsappConversation.update({
      where: { id: conv.id },
      data: { paso: conv.paso + 1, ...counterUpdates },
    });
    return { handled: true, reason: 'too_many_days_off' };
  }

  // ── CONTRACT MISMATCH: refuse, send Claude's explanation, don't save ───────
  if (prefs.contractMismatch) {
    await logOutboundAndSend(telefono, conv.id, replyToSend, conv.semana);
    await prisma.whatsappConversation.update({
      where: { id: conv.id },
      data: { paso: conv.paso + 1, ...counterUpdates },
    });
    return { handled: true, reason: 'contract_mismatch' };
  }

  // ── COMPLETED: validate server-side, save, mark COMPLETADO ─────────────────
  let preferencesCompleted = false;
  if (prefs.completo) {
    const diasMap = {
      LUNES: 'LUNES', MARTES: 'MARTES', MIERCOLES: 'MIERCOLES', MIÉRCOLES: 'MIERCOLES',
      JUEVES: 'JUEVES', VIERNES: 'VIERNES', SABADO: 'SABADO', SÁBADO: 'SABADO', DOMINGO: 'DOMINGO',
    };
    const diasNormalized = (prefs.diasNoDisponible || [])
      .map((d) => diasMap[String(d).toUpperCase()] || String(d).toUpperCase())
      .filter((d) => ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'].includes(d));

    const turnoMap = { MANANA: 'MANANA', MAÑANA: 'MANANA', MATI: 'MANANA', MATÍ: 'MANANA', TARDE: 'TARDE', TARDA: 'TARDE', PARTIDO: 'PARTIDO' };
    const turno = prefs.turnoPreferido ? (turnoMap[String(prefs.turnoPreferido).toUpperCase()] || null) : null;

    // Per-day shift restrictions. Only MANANA/TARDE make sense here (PARTIDO is
    // the whole day, which is not a restriction), and a day the employee cannot
    // work at all belongs in diasNoDisponible — keeping it in both would let the
    // scheduler satisfy one rule while breaking the other.
    const turnosPorDia = {};
    for (const [rawDia, rawTurno] of Object.entries(prefs.turnosPorDia || {})) {
      const dia = diasMap[String(rawDia).toUpperCase()] || String(rawDia).toUpperCase();
      const t = turnoMap[String(rawTurno).toUpperCase()];
      if (!['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'].includes(dia)) continue;
      if (t !== 'MANANA' && t !== 'TARDE') continue;
      if (diasNormalized.includes(dia)) continue;
      turnosPorDia[dia] = t;
    }

    // El que ja hi ha desat d'aquesta setmana, llegit ABANS de decidir res del
    // dissabte: cal saber si el que la IA no menciona és perquè no s'ha dit o
    // perquè ja estava confirmat.
    const existingPrefPrevi = await prisma.shiftPreference.findFirst({
      where: { empleadoId: employee.id, semana: conv.semana, activa: true },
    });

    // ── El dissabte trenca l'alternança? ───────────────────────────────────
    // No es desa i es pregunta. La resta de preferències sí que es desen: qui
    // ha dit quatre coses no ha de tornar-les a dir totes per culpa d'una.
    //
    // Cada ronda, la IA torna a deduir les preferències senceres de tota la
    // conversa, i el que es desa reemplaça el que hi havia. Amb el dissabte
    // això no pot ser: el confirmat el vam escriure NOSALTRES quan va dir que
    // sí, no surt de la IA, i per tant una ronda posterior sobre qualsevol
    // altra cosa el faria desaparèixer sense que ningú l'hagués retirat.
    // Es conserva si aquesta ronda no diu res del dissabte.
    const parlaDelDissabte = 'SABADO' in turnosPorDia || diasNormalized.includes('SABADO');
    const dissabteJaConfirmat = existingPrefPrevi?.turnosPorDia?.SABADO || null;
    if (!parlaDelDissabte && dissabteJaConfirmat) turnosPorDia.SABADO = dissabteJaConfirmat;

    if (turnosPorDia.SABADO && !dissabteJaConfirmat) {
      const demanat = turnosPorDia.SABADO;
      const ultim = await ultimDissabteDe(employee.id, conv.semana, employee.establecimientoId);
      avisAlternanca = avisAlDemanar({ demanat, ultim, idioma: idiomaEmpleado });
      if (avisAlternanca) {
        delete turnosPorDia.SABADO;
        pendentDissabte = demanat;
      }
    }

    // Server-side guard: even if Claude misses the contract check, refuse here.
    const daysAvailable = 7 - diasNormalized.length;
    if (daysAvailable < minDiasNecesarios) {
      // Ni aquí ni al prompt es diu res del contracte ni de les hores. Qui demana
      // tres dies de festa no ha de rebre com a resposta la seva nòmina: el
      // càlcul és nostre, i explicar-lo converteix un «no» en una discussió
      // sobre aritmètica que el xat no pot guanyar ni li toca tenir.
      const dolors = await getGeneralManagerContact();
      const refusal = textRebuig('massaPocsDies', idiomaEmpleado, dolors);
      await logOutboundAndSend(telefono, conv.id, refusal, conv.semana);
      await prisma.whatsappConversation.update({
        where: { id: conv.id },
        data: { paso: conv.paso + 1, ...counterUpdates },
      });
      return { handled: true, reason: 'contract_mismatch_server' };
    }

    // ── El que la persona havia apuntat al full de paper ───────────────────
    // La IA dedueix les preferències de la conversa, i al full no s'hi va dir
    // res: el paper hi és invisible. Com que el que es desa reemplaça el que hi
    // havia, escriure pel WhatsApp per demanar un sol dia esborrava la resta de
    // dies que la persona havia apuntat al full — i en silenci.
    //
    // La regla és la mateixa que quan el full arriba després: mana el WhatsApp,
    // dia per dia. Aquí el paper és la capa de sota i només omple els dies dels
    // quals la conversa no diu res.
    //
    // Va DESPRÉS del bloc del dissabte a posta: un dissabte que vingui del full
    // no ha de disparar la pregunta de l'alternança enmig d'una conversa sobre
    // una altra cosa, dies després d'haver-lo apuntat.
    const fullDeLaSetmana = await prisma.paperSheet.findFirst({
      where: { establecimientoId: employee.establecimientoId, semana: conv.semana },
      orderBy: { createdAt: 'desc' },
      select: { lectura: true },
    });
    const delFull = marquesDelFull(fullDeLaSetmana?.lectura, employee.id);
    // El mateix control que quan es puja el full: si el dissabte del paper
    // trenca el repartiment, no torna a entrar per aquí. Si no, la recuperació
    // seria la porta del darrere del control que hi ha just aquí sobre.
    if (delFull.SABADO) {
      const v = await dissabteDelFullPassa(
        employee.id, employee.establecimientoId, conv.semana, delFull.SABADO);
      if (!v.passa) {
        console.log(`[Paper] ${employee.id} ${conv.semana}: el dissabte del full `
          + `(${delFull.SABADO}) trenca l'alternança, no es recupera`);
        delete delFull.SABADO;
      }
    }
    if (Object.keys(delFull).length > 0) {
      const fusio = fusionaPaperIWhatsapp(delFull, {
        diasNoDisponible: diasNormalized,
        turnosPorDia,
      });
      for (const [dia, torn] of Object.entries(fusio.guanyats)) turnosPorDia[dia] = torn;
      if (fusio.conflictes.length > 0) {
        // No hi ha ningú a qui contestar-li en aquest camí —l'encarregada no hi
        // és— però que quedi al registre: si algú es queixa que el que va
        // apuntar al full no li ha sortit, aquí hi ha el motiu.
        console.log(`[Paper] ${employee.id} ${conv.semana}: mana el WhatsApp a `
          + fusio.conflictes.map((c) => `${c.dia} (full deia ${c.deiaElFull})`).join(', '));
      }
    }

    // Upsert preference
    const existingPref = existingPrefPrevi ?? await prisma.shiftPreference.findFirst({
      where: { empleadoId: employee.id, semana: conv.semana, activa: true },
    });
    if (existingPref) {
      await prisma.shiftPreference.update({
        where: { id: existingPref.id },
        data: {
          turnoPreferido: turno,
          diasNoDisponible: diasNormalized,
          turnosPorDia: Object.keys(turnosPorDia).length > 0 ? turnosPorDia : null,
          notasAdicionales: prefs.notasAdicionales || null,
          recogidoVia: 'WHATSAPP',
        },
      });
    } else {
      await prisma.shiftPreference.create({
        data: {
          empleadoId: employee.id,
          semana: conv.semana,
          turnoPreferido: turno,
          diasNoDisponible: diasNormalized,
          turnosPorDia: Object.keys(turnosPorDia).length > 0 ? turnosPorDia : null,
          notasAdicionales: prefs.notasAdicionales || null,
          recogidoVia: 'WHATSAPP',
          activa: true,
        },
      });
    }

    await prisma.whatsappConversation.update({
      where: { id: conv.id },
      data: {
        estado: 'COMPLETADO',
        completedAt: new Date(),
        intentosIrrelevantes: 0,
        // `?? conv.pendentAlternanca`: una ronda que no parli del dissabte no
        // ha de tirar per terra una pregunta que encara espera resposta.
        pendentAlternanca: pendentDissabte ?? conv.pendentAlternanca ?? null,
      },
    });
    preferencesCompleted = true;

    await checkAllCompleted(employee.establecimientoId, conv.semana, estavaCompletadaEnArribar);
  }

  // ── Send Claude's reply ────────────────────────────────────────────────────
  // L'avís del dissabte va enganxat a la resposta de la IA i no en un missatge a
  // part: dos WhatsApps seguits del mateix bot es llegeixen com un error, i el
  // segon és el que porta la pregunta.
  const textFinal = avisAlternanca ? `${replyToSend}\n\n${avisAlternanca}` : replyToSend;
  await logOutboundAndSend(telefono, conv.id, textFinal, conv.semana);

  // Update paso (and counter reset if needed) — skip if we already updated above on save
  if (!preferencesCompleted) {
    await prisma.whatsappConversation.update({
      where: { id: conv.id },
      data: { paso: conv.paso + 1, ...counterUpdates },
    });
  }

  return { handled: true, completed: preferencesCompleted };
}

// ─────────────────────────────────────────────
// CHECK IF ALL EMPLOYEES COMPLETED — notify manager
// ─────────────────────────────────────────────
/**
 * L'avís de «ja pots generar», amb el nombre de gent que ha contestat.
 *
 * Deia «tot l'equip ha enviat les seves preferències» comptant només els que
 * tenen telèfon a la fitxa. A Girona això són 4 de 16: quan aquells quatre
 * contestessin, la responsable hauria rebut llum verda per generar un horari
 * amb tres quartes parts de l'equip a qui ningú ha preguntat res — i sense cap
 * manera d'assabentar-se'n, perquè el missatge deia que estava tot fet.
 *
 * Els que no tenen telèfon no són un error del sistema: són fitxes a mig
 * omplir. Però qui genera l'horari ho ha de saber.
 */
export function textEquipComplet({ nom, botiga, setmana, ambTelefon, senseTelefon }) {
  const cap = `Hola ${nom}.`;
  // Ningú a qui preguntar no és «tothom ha contestat». checkAllCompleted ja
  // talla abans, però això és una funció exportada i el dia que algú la cridi
  // des d'un altre lloc no ha de dir «han contestat els 0 treballadors».
  if (ambTelefon === 0) {
    return `${cap} A ${botiga} no s'ha pogut demanar les preferències a ningú per a la setmana ${setmana}: cap treballador té telèfon a la fitxa.`;
  }
  if (senseTelefon === 0) {
    return `${cap} Tot l'equip de ${botiga} (${ambTelefon}) ha enviat les seves preferències per a la setmana ${setmana}. Ja pots generar l'horari a l'aplicació.`;
  }
  const un = senseTelefon === 1;
  const qui = un ? '1 treballador més no té' : `${senseTelefon} treballadors més no tenen`;
  const aQui = un ? 'no se li ha demanat res' : 'no se\'ls ha demanat res';
  const contestat = ambTelefon === 1
    ? 'ha contestat l\'únic treballador al qual se li ha pogut preguntar'
    : `han contestat els ${ambTelefon} treballadors als quals se'ls ha pogut preguntar`;
  return `${cap} A ${botiga} ${contestat}, per a la setmana ${setmana}.\n\n`
    + `Atenció: ${qui} telèfon a la fitxa, o sigui que ${aQui}.\n\n`
    + `Ja pots generar l'horari a l'aplicació.`;
}

export async function checkAllCompleted(establecimientoId, semana, jaEstavaCompletada = false) {
  if (!establecimientoId) return;
  // Nothing became true that was not already true: this person was finished
  // before this message, so somebody editing inside the ten-minute window
  // cannot announce the week as finished all over again.
  if (jaEstavaCompletada) return;

  // Tot l'equip, amb telèfon i sense. Als de sense no se'ls pot preguntar res,
  // però qui genera l'horari ha de saber quants són.
  const equip = await prisma.employee.findMany({
    where: {
      activo: true,
      rol: { not: 'MANAGER_GENERAL' },
      OR: [
        { establecimientoId },
        { establecimientosPermitidos: { some: { establishmentId: establecimientoId } } },
      ],
    },
    select: { telefonoWhatsapp: true },
  });
  // Un sol criteri de qui és «l'equip», aplicat a la consulta i no després. La
  // primera versió treia la responsable general només del compte dels que NO
  // tenen telèfon, o sigui que formar part de l'equip depenia de tenir-ne o no.
  //
  // La responsable general no treballa a cap establiment — les botigues les
  // porten les encarregades, que sí que hi treballen i sí que compten.
  const employees = equip.filter((e) => e.telefonoWhatsapp);
  const senseTelefon = equip.length - employees.length;

  const phones = employees.map((e) => e.telefonoWhatsapp).filter(Boolean);
  if (phones.length === 0) return;

  // Check that EVERY employee with a phone has a COMPLETADO conversation for this week.
  // (Previously compared lengths, which broke if phones changed between broadcast and reply.)
  const completedConvs = await prisma.whatsappConversation.findMany({
    where: { telefono: { in: phones }, semana, estado: 'COMPLETADO' },
    select: { telefono: true },
  });
  const completedPhones = new Set(completedConvs.map((c) => c.telefono));
  const allCompleted = phones.every((p) => completedPhones.has(p));

  if (!allCompleted) return;

  // "You can generate the schedule now" is addressed to whoever generates it,
  // and that is the general manager — it went to the shop manager, who does
  // not do that job and did not ask to be told.
  const establishment = await prisma.establishment.findUnique({
    where: { id: establecimientoId },
    select: { nombre: true },
  });
  const general = await prisma.employee.findFirst({
    where: { rol: 'MANAGER_GENERAL', activo: true, telefonoWhatsapp: { not: null } },
    select: { id: true, nombre: true, telefonoWhatsapp: true },
    orderBy: { id: 'asc' },
  });

  if (!general) {
    console.warn(`[WhatsApp] Han contestat ${phones.length} a ${establishment?.nombre || establecimientoId} (${semana})${senseTelefon ? ` · ${senseTelefon} sense telèfon` : ''} però cap responsable general té telèfon — no s'avisa.`);
    return;
  }

  await sendWhatsappMessage(general.telefonoWhatsapp, textEquipComplet({
    nom: general.nombre,
    botiga: establishment?.nombre || 'l\'establiment',
    setmana: weekLabelLlarg(semana),
    ambTelefon: phones.length,
    senseTelefon,
  }));
}

// ─────────────────────────────────────────────
// EL CICLE, SOL
//
// El broadcast sortia perquè algú clicava un botó diumenge al matí, i el
// recordatori igual. Amb la finestra oberta de diumenge a les 9 fins dimecres
// a la 1, tot el cicle depenia que una persona se'n recordés el cap de setmana.
//
// Només per a les botigues que ho tinguin encès a Ajustos: encendre-ho vol dir
// que cada diumenge surten missatges de debò, i una botiga amb telèfons de
// prova no hi ha de ser fins que estigui a punt.
// ─────────────────────────────────────────────

/** Les botigues amb l'enviament automàtic encès. */
export async function botiguesAutomatiques() {
  const totes = await prisma.establishment.findMany({ select: { id: true, nombre: true } });
  const enceses = [];
  for (const est of totes) {
    if (await ajust('enviamentAutomatic', est.id)) enceses.push(est);
  }
  return enceses;
}

/** Avisa la responsable general del que ha sortit sol, si hi ha res a dir. */
export async function informaLaResponsable(text) {
  if (process.env.HORARIA_MANAGER_NOTIFICATIONS === '0') return false;
  const gm = await prisma.employee.findFirst({
    where: { rol: 'MANAGER_GENERAL', activo: true, telefonoWhatsapp: { not: null } },
    select: { nombre: true, telefonoWhatsapp: true },
    orderBy: { id: 'asc' },
  });
  if (!gm) return false;
  try {
    await sendWhatsappMessage(gm.telefonoWhatsapp, text);
    return true;
  } catch (err) {
    // Que no arribi l'avís no pot fer caure l'enviament: els missatges als
    // treballadors ja han sortit i són el que importa.
    console.error('[Automàtic] no s\'ha pogut avisar la responsable:', err.message);
    return false;
  }
}

export async function broadcastAutomatic(semana) {
  const botigues = await botiguesAutomatiques();
  const targetWeek = semana || await setmanaEnFinestraConfigurada();
  if (!targetWeek) {
    console.log('[Automàtic] fora de la finestra de peticions: no s\'envia res');
    return { semana: null, botigues: [], enviats: 0, errors: 0, falla: false, motiu: 'fora_de_finestra' };
  }
  if (botigues.length === 0) {
    console.log('[Automàtic] cap botiga amb enviament automàtic encès');
    return { semana: targetWeek, botigues: [], enviats: 0, falla: false };
  }

  const resultats = [];
  for (const est of botigues) {
    try {
      const r = await broadcastPreferenceRequest(est.id, targetWeek);
      resultats.push({ botiga: est.nombre, ...r });
      console.log(`[Automàtic] ${est.nombre} ${targetWeek}: ${r.empleadosContactados} enviats, ${r.fallidos} fallits, ${r.saltats.length} saltats`);
    } catch (err) {
      resultats.push({ botiga: est.nombre, error: err.message });
      console.error(`[Automàtic] ${est.nombre}: ${err.message}`);
    }
  }

  const enviats = resultats.reduce((n, r) => n + (r.empleadosContactados || 0), 0);
  const fallits = resultats.reduce((n, r) => n + (r.fallidos || 0), 0);
  const errors = resultats.filter((r) => r.error);

  // Un enviament automàtic que no es veu és un enviament que ningú comprova.
  // Però un avís que arriba sempre deixa de llegir-se: si no s'ha enviat res i
  // no ha fallat res — un cron disparat dues vegades, una prova a mà — no hi ha
  // res a dir, i dir-ho igualment li ensenya a ignorar-los.
  const linies = resultats.map((r) => (r.error
    ? `• ${r.botiga}: ERROR — ${r.error}`
    : `• ${r.botiga}: ${r.empleadosContactados} enviats${r.fallidos ? `, ${r.fallidos} fallits` : ''}${r.saltats?.length ? `, ${r.saltats.length} ja la tenien` : ''}`));
  const hiHaResADir = enviats > 0 || fallits > 0 || errors.length > 0;
  const avisat = hiHaResADir
    ? await informaLaResponsable(
      `Petició de preferències enviada per a la setmana ${weekLabelLlarg(targetWeek)}.\n\n${linies.join('\n')}`
    )
    : false;

  const falla = esFallidaDeFeina({ enviats, fallits, botiguesAmbError: errors.length });
  return { semana: targetWeek, botigues: botigues.map((b) => b.nombre), enviats, fallits, errors: errors.length, falla, avisat, detall: resultats };
}

export async function recordatorisAutomatics(semana, ara = new Date()) {
  const botigues = await botiguesAutomatiques();
  const targetWeek = semana || await setmanaEnFinestraConfigurada(ara);
  if (!targetWeek) {
    console.log('[Automàtic] fora de la finestra: no es recorda res');
    return { semana: null, pendents: [], fallits: [], errors: 0, falla: false, motiu: 'fora_de_finestra' };
  }
  // Dins de la finestra hi som quatre dies, i el batec passa cada hora: sense
  // això enviaria recordatoris tot el temps. Només toca a prop del termini.
  const { tanca } = await finestraConfigurada(targetWeek);
  if (!tocaRecordar(ara, tanca)) {
    return { semana: targetWeek, pendents: [], fallits: [], errors: 0, falla: false, motiu: 'encara_no_toca' };
  }
  const resultats = [];
  for (const est of botigues) {
    try {
      const r = await sendReminders(est.id, targetWeek, { margeMs: Infinity, ara });
      resultats.push({ botiga: est.nombre, ...r });
    } catch (err) {
      resultats.push({ botiga: est.nombre, error: err.message });
      console.error(`[Automàtic] recordatori ${est.nombre}: ${err.message}`);
    }
  }

  const pendents = resultats.flatMap((r) => (r.detalle || []).map((x) => x.nombre)).filter(Boolean);
  // Sense això l'endpoint contestava 200 encara que hagués fallat tot, i el
  // correu de job fallit de cron-job.org — que és el segon canal, el que
  // sobreviu que WhatsApp sigui justament la cosa espatllada — no saltava mai.
  const fallits = resultats.flatMap((r) => r.fallits || []);
  const botiguesAmbError = resultats.filter((r) => r.error).length;
  const errors = fallits.length + botiguesAmbError;
  const falla = esFallidaDeFeina({ enviats: pendents.length, fallits: fallits.length, botiguesAmbError });
  console.log(`[Automàtic] recordatoris ${targetWeek}: ${pendents.length} enviats, ${errors} errors`);

  // Callar quan tothom ha contestat: un avís que sempre arriba deixa de llegir-se.
  let avisat = false;
  if (pendents.length > 0) {
    avisat = await informaLaResponsable(
      `Encara no han contestat per a la setmana ${weekLabelLlarg(targetWeek)}: ${pendents.join(', ')}.\n\nSe'ls acaba d'enviar un recordatori. El termini es tanca ${deadlineLabel(tanca)}.`
    );
  }

  if (fallits.length > 0) {
    await informaLaResponsable(
      `No s'ha pogut enviar el recordatori a: ${fallits.map((f) => f.nombre).join(', ')}. Caldrà avisar-los d'una altra manera.`
    );
  }

  return { semana: targetWeek, pendents, fallits, errors, falla, avisat, detall: resultats };
}

// ─────────────────────────────────────────────
// SEND REMINDERS — to employees who haven't responded
// ─────────────────────────────────────────────
/**
 * `margeMs` és quant ha de fer que se li va recordar per tornar-l'hi a enviar.
 * A mà val el marge curt: si el responsable pica el botó, vol enviar-lo. El
 * camí automàtic passa Infinity, que vol dir un sol recordatori per setmana i
 * persona — amb un batec cada hora, el marge de 12 h n'hauria enviat dos al dia
 * durant tota la finestra.
 */
export async function sendReminders(establecimientoId, semana, { margeMs = RECORDATORI_MARGE_MS, employeeIds, ara = new Date() } = {}) {
  const template = await approvedBusinessTemplate('reminder');
  const targetWeek = semana || getNextWeek();

  const employees = await prisma.employee.findMany({
    where: selectedRecipients(quiRepLaPeticio(establecimientoId), employeeIds),
    select: { id: true, nombre: true, telefonoWhatsapp: true },
  });
  verifySelectedRecipients(employees, employeeIds);

  const conversations = await prisma.whatsappConversation.findMany({
    where: { semana: targetWeek, telefono: { in: employees.map((e) => e.telefonoWhatsapp).filter(Boolean) } },
  });

  const convMap = {};
  for (const c of conversations) convMap[c.telefono] = c;

  const reminded = [];
  const fallits = [];
  const repetits = [];
  const saltats = [];
  const semanaLabel = weekLabel(targetWeek);

  for (const emp of employees) {
    if (!emp.telefonoWhatsapp) continue;
    const conv = convMap[emp.telefonoWhatsapp];

    // Only remind if conversation exists and is NOT completed
    if (!conv || conv.estado === 'COMPLETADO') continue;
    if (conv.fechaLimite && new Date(conv.fechaLimite).getTime() <= ara.getTime()) continue;

    // Ja se li ha recordat fa poc. El broadcast tenia guarda contra la doble
    // execució i això no: un cron que es dispari dues vegades li enviava dos
    // cops el mateix «encara no has contestat», que és la manera més ràpida de
    // fer que la gent deixi de llegir-los.
    if (conv.ultimoRecordatorio
      && ara.getTime() - new Date(conv.ultimoRecordatorio).getTime() < margeMs) {
      repetits.push(emp.nombre);
      continue;
    }

    const mensaje = `Hola ${emp.nombre}. Et recordem que encara no hem rebut les teves preferències per a la setmana del ${semanaLabel}. Si us plau, indica\'ns els dies en què no pots treballar. Gràcies.`;

    // Un número que peta no s'ha d'endur els recordatoris de la resta de
    // l'equip. Abans l'excepció pujava i deixava mitja botiga sense avisar.
    // Tot el que pot petar, dins. La primera versió només protegia l'enviament
    // i deixava fora les dues escriptures, que és el pitjor lloc on trencar-se:
    // la persona ja ha rebut el WhatsApp, no queda marcada ni com a enviada ni
    // com a fallida, i com que `ultimoRecordatorio` no s'ha desat, el pròxim
    // cron li'l torna a enviar. El duplicat que volíem evitar, per una altra
    // porta — i a més s'enduia la resta de l'equip.
    try {
      if (!MOCK_MODE && REMINDER_TEMPLATE) {
        const deadline = conv.fechaLimite || await computeDeadline(targetWeek, ara);
        if (!templateDeadlineMatches(template, deadline, ara)) {
          saltats.push({ empleadoId: emp.id, nombre: emp.nombre, motiu: 'termini_no_es_dema' });
          continue;
        }
        const parts = deadlineParts(deadline);
        await sendWhatsappTemplate(emp.telefonoWhatsapp, { name: REMINDER_TEMPLATE, bodyParams: template?.bodyParameters === 4 ? [emp.nombre, semanaLabel, parts.date, parts.time] : [emp.nombre, semanaLabel] });
      } else {
        await sendWhatsappMessage(emp.telefonoWhatsapp, mensaje);
      }
      await prisma.whatsappMessage.create({
        // Sense la setmana, el model no veuria mai aquest recordatori: el
        // carrega filtrant per `conv.semana`. La persona rebria «encara no hem
        // rebut les teves preferències», contestaria, i el xatbot no sabria que
        // li acaba d'escriure això.
        data: { conversacionId: conv.id, direccion: 'saliente', contenido: mensaje, semana: targetWeek },
      });
      await prisma.whatsappConversation.update({
        where: { id: conv.id },
        data: { ultimoRecordatorio: new Date() },
      });
    } catch (err) {
      console.error(`[Recordatori] ${emp.nombre}: ${err.message}`);
      fallits.push({ empleadoId: emp.id, nombre: emp.nombre, error: err.message });
      continue;
    }

    reminded.push({ empleadoId: emp.id, nombre: emp.nombre });
  }

  return {
    semana: targetWeek,
    recordatoriosEnviados: reminded.length,
    detalle: reminded,
    fallits,
    repetits,
    saltats,
  };
}

// ─────────────────────────────────────────────
// GET conversation status for an establishment
// ─────────────────────────────────────────────
export async function getConversationStatus(establecimientoId, semana) {
  const targetWeek = semana || getNextWeek();

  const employees = await prisma.employee.findMany({
    where: {
      activo: true,
      OR: [
        { establecimientoId },
        { establecimientosPermitidos: { some: { establishmentId: establecimientoId } } },
      ],
    },
    select: { id: true, nombre: true, apellidos: true, telefonoWhatsapp: true },
  });

  const conversations = await prisma.whatsappConversation.findMany({
    where: { semana: targetWeek },
    // D'aquella setmana. Ara que els missatges no s'esborren, l'últim de la
    // conversa pot ser de fa tres setmanes, i la pantalla de WhatsApp
    // ensenyaria com a «últim missatge» una cosa que aquella persona no ha dit
    // aquesta setmana.
    include: { mensajes: { where: { semana: targetWeek }, orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  const convMap = {};
  for (const c of conversations) convMap[c.telefono] = c;

  const result = employees.map((emp) => {
    const conv = emp.telefonoWhatsapp ? convMap[emp.telefonoWhatsapp] : null;
    return {
      empleadoId: emp.id,
      nombre: `${emp.nombre} ${emp.apellidos}`,
      telefono: emp.telefonoWhatsapp,
      tieneWhatsapp: !!emp.telefonoWhatsapp,
      estado: conv?.estado || 'SIN_CONTACTAR',
      // A locked conversation looks exactly like one nobody has answered, and
      // the lock is silent by design — so unless the screen says so, the person
      // is simply gone and nobody knows why.
      bloqueada: !!conv?.bloqueada,
      ultimoMensaje: conv?.mensajes?.[0]?.contenido?.substring(0, 100) || null,
      ultimaActividad: conv?.updatedAt || null,
    };
  });

  const total = result.length;
  const conWhatsapp = result.filter((r) => r.tieneWhatsapp).length;
  const completados = result.filter((r) => r.estado === 'COMPLETADO').length;
  const enProgreso = result.filter((r) => r.estado === 'EN_PROGRESO').length;
  const pendientes = result.filter((r) => r.estado === 'PENDIENTE').length;

  return {
    semana: targetWeek,
    resumen: { total, conWhatsapp, completados, enProgreso, pendientes },
    empleados: result,
  };
}
