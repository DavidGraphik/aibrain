import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { authorizeWhatsApp, requestCodex } from '../src/integration/providers.js';

test('private calculation accepts delayed headers and enforces its own deadline without following redirects', async () => {
  let mode = 'delayed';
  const server = createServer((req, res) => {
    assert.equal(req.headers['x-aibrain-authorization'], 'signed-test');
    req.resume();
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); return; }
    const timer = setTimeout(() => res.end(JSON.stringify({ content: [{ type: 'text', text: '8' }] })), 60);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${server.address().port}/api/horaria-codex`);
  try {
    assert.equal((await requestCodex(url, 'signed-test', Buffer.from('{}'), 1000)).content[0].text, '8');
    await assert.rejects(requestCodex(url, 'signed-test', Buffer.from('{}'), 10), { name: 'AbortError' });
    mode = 'redirect';
    await assert.rejects(requestCodex(url, 'signed-test', Buffer.from('{}')), /302/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});


test('WhatsApp preflight carries only the signed operator identity and never requests model work', async () => {
  const previous = { HORARIA_CODEX_URL: process.env.HORARIA_CODEX_URL, HORARIA_BRIDGE_SECRET: process.env.HORARIA_BRIDGE_SECRET, HORARIA_INSTALLATION_ID: process.env.HORARIA_INSTALLATION_ID };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.deepEqual(JSON.parse(body.toString()), { authorizationOnly: true });
    const [payload, signature] = String(req.headers['x-aibrain-authorization']).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(signature, createHmac('sha256', process.env.HORARIA_BRIDGE_SECRET).update(payload).digest('base64url'));
    assert.equal(claims.source, 'whatsapp'); assert.equal(claims.actorId, 'operator'); assert.equal(claims.employeeId, 7);
    assert.equal(claims.installationId, 'isolated-company'); assert.equal(claims.bodyHash, createHash('sha256').update(body).digest('hex'));
    res.end(JSON.stringify({ authorized: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { HORARIA_CODEX_URL: `http://127.0.0.1:${server.address().port}`, HORARIA_BRIDGE_SECRET: 'private-test-secret', HORARIA_INSTALLATION_ID: 'isolated-company' });
  try { await authorizeWhatsApp({ actorId: 'operator', employeeId: 7 }); }
  finally {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise(resolve => server.close(resolve));
  }
});
