import crypto from 'crypto';

// ─────────────────────────────────────────────
// Is this webhook really from Meta?
//
// Meta signs every delivery with X-Hub-Signature-256: an HMAC-SHA256 of the raw
// body keyed with the app secret. Without checking it the endpoint accepts
// anything: the URL is not a secret and the path is conventional, so anyone
// could post messages that impersonate the manager and file absences, submit
// preferences as any employee, or simply burn Anthropic credits one fake
// message at a time.
//
// Needs the RAW body, not the parsed object — re-serialising JSON does not
// reproduce Meta's bytes, so the hash would never match.
// ─────────────────────────────────────────────

export function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  // Not configured → cannot verify. The caller decides whether to allow it, so
  // an existing deployment keeps working until the secret is added.
  if (!secret) return { ok: true, reason: 'not_configured' };

  const header = req.get('x-hub-signature-256');
  if (!header) return { ok: false, reason: 'missing_signature' };

  const raw = req.rawBody;
  if (!raw) return { ok: false, reason: 'no_raw_body' };

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

  // Constant-time compare: a plain === leaks how much of the hash matched.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'bad_signature' };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true, reason: 'verified' }
    : { ok: false, reason: 'bad_signature' };
}
