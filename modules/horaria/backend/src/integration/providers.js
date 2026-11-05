import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { signEnvelope, bodyHash } from './signature.js';

// Identity is inherited from the verified request, never from prompts or customer data.
export const aiIdentity = new AsyncLocalStorage();

// Native transport avoids fetch's five-minute response-header deadline. The
// calculation has its own bounded deadline and only targets operator config.
export function requestCodex(url, token, body, timeoutMs = 20 * 60_000) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/api/horaria-codex' || url.search || url.hash) throw new Error('Invalid internal Codex URL.');
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      agent: false, method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-aibrain-authorization': token },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Codex d’AiBrain no ha completat el càlcul (${response.statusCode}).`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) response.destroy(new Error('Codex response too large.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Codex returned invalid JSON.')); }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}
export async function authorizeWhatsApp(identity) {
  const target = '/api/horaria-codex';
  const body = Buffer.from(JSON.stringify({ authorizationOnly: true }));
  const token = signEnvelope({ v: 1, kind: 'user', source: 'whatsapp', installationId: process.env.HORARIA_INSTALLATION_ID,
    actorId: identity.actorId, employeeId: identity.employeeId, method: 'POST', target,
    timestamp: Date.now(), nonce: randomUUID(), contentType: 'application/json', bodyHash: bodyHash(body),
  }, process.env.HORARIA_BRIDGE_SECRET);
  const result = await requestCodex(new URL(target, process.env.HORARIA_CODEX_URL), token, body, 15000);
  if (result.authorized !== true) throw new Error('WhatsApp execution is not authorized');
}

export function createAiClient() {
  return { messages: { async create(params) {
    if (process.env.HORARIA_ALLOW_AI !== '1') throw new Error('La generació amb IA encara no està activada.');
    const identity = aiIdentity.getStore();
    if (!identity || identity.kind !== 'user') throw new Error('Cal executar la IA des del xat o una automatització autoritzada d’AiBrain.');
    const target = '/api/horaria-codex';
    const body = Buffer.from(JSON.stringify({ system: params.system, messages: params.messages, tools: params.tools, tool_choice: params.tool_choice }));
    const token = signEnvelope({ v: 1, kind: 'user', installationId: process.env.HORARIA_INSTALLATION_ID,
      ...(identity.source ? { source: identity.source } : {}), actorId: identity.actorId, employeeId: identity.employeeId, method: 'POST', target,
      timestamp: Date.now(), nonce: randomUUID(), contentType: 'application/json', bodyHash: bodyHash(body),
    }, process.env.HORARIA_BRIDGE_SECRET);
    return requestCodex(new URL(target, process.env.HORARIA_CODEX_URL), token, body);
  } } };
}

export function requireDelivery() {
  if (process.env.HORARIA_ALLOW_DELIVERY !== '1') throw new Error('Els enviaments de WhatsApp encara no estan activats.');
  if (process.env.WHATSAPP_MOCK === 'true') throw new Error('El mode de simulació no pot fer enviaments reals.');
  const env = process.env;
  const explicit = (env.WHATSAPP_PROVIDER || '').toLowerCase();
  const provider = ['meta', '360dialog', 'twilio'].includes(explicit) ? explicit : env.D360_API_KEY ? '360dialog' : !env.WHATSAPP_TOKEN && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? 'twilio' : 'meta';
  const ready = provider === 'twilio' ? env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM
    : provider === '360dialog' ? env.D360_API_KEY : env.WHATSAPP_TOKEN && (env.WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_ID);
  if (!ready) throw new Error('Falten les credencials del proveïdor de WhatsApp.');
}
