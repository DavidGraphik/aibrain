// A server-only transport. Never import into a browser bundle or an AI tool runtime.
// This helper signs and constructs a Request; it never dispatches it.
export const protocol = 'insijets-outreach-v1';
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const canonicalMessage = (path, timestamp, nonce, raw) => `${protocol}\nPOST\n${path}\n${timestamp}\n${nonce}\n${raw}`;
export async function buildSignedRequest({ origin, payload, signingKey, maintenance = false, batch = false, timestamp = Date.now(), nonce = crypto.randomUUID() }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('approved_https_origin_required');
  if (typeof signingKey !== 'string' || signingKey.length < 32) throw new Error('signing_key_required');
  if (maintenance && batch) throw new Error('transport_path_ambiguous');
  const path = maintenance ? '/v1/outreach/operation' : batch ? '/v1/outreach/contacts/batch' : '/v1/outreach/contact', raw = JSON.stringify(payload);
  const key = await crypto.subtle.importKey('raw', encoder.encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalMessage(path, timestamp, nonce, raw))));
  return new Request(`${url.origin}${path}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-InsiJets-Timestamp': String(timestamp), 'X-InsiJets-Nonce': nonce, 'X-InsiJets-Signature': signature }, body: raw });
}
