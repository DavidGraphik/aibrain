import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const bodyHash = (body) => createHash('sha256').update(body).digest('hex');
export function signEnvelope(claims, secret) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

/** One installation per private service/database. Browser tokens are never accepted. */
export function createVerifier({ secret, installationId, now = Date.now }) {
  if (!secret || secret.length < 32 || !installationId) throw new Error('Horaria bridge is not configured');
  const seen = new Map();
  return (token, { method, target, contentType, body }) => {
    if (typeof token !== 'string' || token.length > 4096) throw new Error('Invalid bridge request');
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) throw new Error('Invalid bridge request');
    const expected = createHmac('sha256', secret).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid bridge request');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const time = now();
    if (claims.v !== 1 || claims.installationId !== installationId ||
      !Number.isSafeInteger(claims.timestamp) || Math.abs(time - claims.timestamp) > 60_000 ||
      !/^[a-f0-9-]{36}$/.test(claims.nonce) || claims.method !== method || claims.target !== target ||
      claims.contentType !== contentType || claims.bodyHash !== bodyHash(body) ||
      !['user', 'event', 'scheduler'].includes(claims.kind)) throw new Error('Invalid bridge request');
    if (claims.kind === 'user' && (!Number.isSafeInteger(claims.employeeId) || claims.employeeId < 1 || typeof claims.actorId !== 'string' || !claims.actorId)) throw new Error('Invalid bridge request');
    for (const [nonce, expires] of seen) if (expires < time) seen.delete(nonce);
    if (seen.has(claims.nonce) || seen.size >= 10_000) throw new Error('Replayed bridge request');
    seen.set(claims.nonce, time + 120_000);
    return claims;
  };
}
