// Trusted application-server module. Never expose control files/keys to workers.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { buildSignedRequest } from './signed-request.mjs';
import { verifySelectedCohort } from './client-selection.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const ref = value => typeof value === 'string' && /^[A-Za-z0-9_:./-]{3,120}$/.test(value);
const deny = () => { throw Error('INSIJETS_CRM_UNAVAILABLE'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

function protectedJson(file, expectedHash) {
  if (!isAbsolute(file || '') || realpathSync(file) !== resolve(file)) deny();
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o077)) deny();
  const raw = readFileSync(file);
  if (!/^[a-f0-9]{64}$/.test(expectedHash || '') || sha(raw) !== expectedHash) deny();
  return JSON.parse(raw.toString('utf8'));
}
function control(env, now) {
  if (env.AIBRAIN_INSIJETS_CRM_ENABLED !== 'true' || env.AIBRAIN_INSIJETS_CRM_LIVE_ACCEPTED !== 'true') deny();
  const c = protectedJson(env.AIBRAIN_INSIJETS_CRM_CONTROL_FILE, env.AIBRAIN_INSIJETS_CRM_CONTROL_SHA256);
  if (!exact(c, ['version','tenantId','clientId','gatewayOrigin','acceptanceEvidenceRef','authorizedUserIds','policy','packet','expectedSelectionDigest','metadata']) || c.version !== 1 || c.tenantId !== 'insijets-demo' || c.clientId !== 'insijets-outreach' || !ref(c.acceptanceEvidenceRef)
    || !Array.isArray(c.authorizedUserIds) || !c.authorizedUserIds.length || c.authorizedUserIds.length > 20 || c.authorizedUserIds.some(x => !ref(x))) deny();
  const u = new URL(c.gatewayOrigin);
  if (u.protocol !== 'https:' || u.origin !== c.gatewayOrigin || u.username || u.password) deny();
  if (!exact(c.metadata, ['campaignRef','approvalRef','authorityRef','icp','tier']) || !['campaignRef','approvalRef','authorityRef','icp'].every(k => ref(c.metadata[k])) || !['tier1','tier2','tier3'].includes(c.metadata.tier)) deny();
  if (c.policy.tenantId !== c.tenantId) deny();
  const packet = verifySelectedCohort(c.packet, c.policy, { now, expectedDigest: c.expectedSelectionDigest });
  if (packet.selected.length > 100 || !ref(packet.cohortId) || !ref(packet.policyRevision)) deny();
  return { ...c, packet, controlDigest: sha(JSON.stringify(c)) };
}
async function authorized(actor, authorize, now) {
  if (!actor || actor.installationId !== 'insijets-demo' || actor.backgroundExecution !== false || !ref(actor.userId) || !ref(actor.threadId) || !ref(actor.turnId) || !Number.isFinite(Date.parse(actor.expiresAt)) || Date.parse(actor.expiresAt) <= now || typeof authorize !== 'function' || !await authorize()) deny();
}
function journal(root) {
  if (!isAbsolute(root || '') || realpathSync(root) !== resolve(root)) deny();
  const dir = join(root, 'insijets-crm-dispatch');
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) deny();
  chmodSync(dir, 0o700);
  const file = join(dir, 'ledger.sqlite');
  try { const st = lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) deny(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  try {
    db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS identity(tenant TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT); CREATE TABLE IF NOT EXISTS subjects(subject TEXT PRIMARY KEY,operation_id TEXT NOT NULL);");
    const rows = db.prepare('SELECT tenant FROM identity').all();
    if (rows.length > 1 || rows.length && rows[0].tenant !== 'insijets-demo') deny();
    if (!rows.length) db.prepare('INSERT INTO identity VALUES(?)').run('insijets-demo');
    return db;
  } catch (e) { db.close(); throw e; }
}
function rowsFor(c, input) {
  if (!exact(input, ['selectionRef','revision','recordRefs']) || input.selectionRef !== c.packet.cohortId || input.revision !== c.packet.policyRevision || !Array.isArray(input.recordRefs) || !input.recordRefs.length || input.recordRefs.length > 100 || input.recordRefs.some(x => !ref(x)) || new Set(input.recordRefs).size !== input.recordRefs.length) deny();
  return [...input.recordRefs].sort().map(id => { const rows = c.packet.selected.filter(r => r.recordRef === id); if (rows.length !== 1) deny(); return rows[0]; });
}
async function boundedReceipt(response, operationId) {
  if (response.status !== 200) return null;
  const reader = response.body?.getReader(); if (!reader) return null;
  const chunks = []; let size = 0;
  while (true) { const n = await reader.read(); if (n.done) break; size += n.value.length; if (size > 65536) { await reader.cancel(); return null; } chunks.push(Buffer.from(n.value)); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (body.operationId !== operationId || body.kind !== 'email-batch-upsert' || body.status !== 'delivered' || !/^[a-f0-9]{64}$/.test(body.digest || '') || !Array.isArray(body.records)) return null;
  if (body.records.some((r, i) => r.recordIndex !== i || r.status !== 'delivered' || !/^[0-9]+$/.test(r.externalId || '')) || new Set(body.records.map(r => r.externalId)).size !== body.records.length) return null;
  // Provider IDs, CRM properties and responses never enter the model result.
  return { operationId, status: 'delivered', count: body.records.length };
}

export async function crmConnectionStatus({ actor, authorize, env = process.env, now = Date.now() }) {
  await authorized(actor, authorize, now);
  if (env.AIBRAIN_INSIJETS_CRM_ENABLED !== 'true') return { enabled: false, configuredForDispatch: false, liveAccepted: false, reason: 'client_connection_not_activated' };
  try { const c = control(env, now); if (!c.authorizedUserIds.includes(actor.userId)) deny(); return { enabled: true, configuredForDispatch: true, clientAcceptanceEvidencePresent: true, selectionRef: c.packet.cohortId, revision: c.packet.policyRevision, selected: c.packet.selected.length, expiresAt: c.packet.expiresAt, liveAccepted: false }; }
  catch { return { enabled: false, configuredForDispatch: false, liveAccepted: false, reason: 'client_configuration_or_selection_unavailable' }; }
}
export async function readSelectedFacts({ actor, authorize, input, env = process.env, now = Date.now() }) {
  await authorized(actor, authorize, now);
  const c = control(env, now); if (!c.authorizedUserIds.includes(actor.userId)) deny();
  const rows = rowsFor(c, input);
  // Email and deal histories are not necessary to compose from permitted facts.
  return { selectionRef: c.packet.cohortId, revision: c.packet.policyRevision, untrustedData: true, records: rows.map(r => ({ recordRef: r.recordRef, facts: r.facts.filter(f => !['email','email_verification_ref','owner_id','account_id'].includes(f.field)) })), sendingAuthorized: false };
}
export async function dispatchSelectedContacts({ actor, authorize, input, dataRoot, env = process.env, fetcher = globalThis.fetch, now = Date.now() }) {
  await authorized(actor, authorize, now);
  const c = control(env, now); if (!c.authorizedUserIds.includes(actor.userId) || typeof env.AIBRAIN_INSIJETS_CRM_CALLER_HMAC !== 'string' || env.AIBRAIN_INSIJETS_CRM_CALLER_HMAC.length < 32) deny();
  const rows = rowsFor(c, input);
  const identity = { clientId: c.clientId, selectionDigest: c.packet.digest, recordRefs: rows.map(r => r.recordRef), metadata: c.metadata };
  const operationId = `crm_${sha(JSON.stringify(identity)).slice(0,48)}`;
  const payload = { clientId: c.clientId, operationId, action: 'batch-upsert-contacts-by-email', authorityRef: c.metadata.authorityRef, records: rows.map(r => {
    const facts = Object.fromEntries(r.facts.map(f => [f.field, f.value]));
    if (!facts.locale || !facts.email_verification_ref) deny();
    return { recordRef: r.recordRef, approvalRef: c.metadata.approvalRef, fields: { email: r.email, locale: facts.locale, tier: c.metadata.tier, icp: c.metadata.icp, campaignRef: c.metadata.campaignRef, sourceRef: `selection:${sha(`${c.packet.cohortId}:${r.recordRef}`).slice(0,48)}`, eligibilityRef: `eligibility:${sha(`${c.packet.digest}:${r.recordRef}`).slice(0,48)}` } };
  }) };
  const digest = sha(JSON.stringify(payload)), subjects = rows.map(r => sha(`${c.clientId}:${r.email}`));
  const db = journal(dataRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    let old;
    try {
      old = db.prepare('SELECT digest,status,receipt FROM operations WHERE id=?').get(operationId);
      if (old) { if (old.digest !== digest) deny(); }
      else {
        if (subjects.some(s => db.prepare('SELECT 1 FROM subjects WHERE subject=?').get(s))) deny();
        db.prepare('INSERT INTO operations VALUES(?,?,?,NULL)').run(operationId, digest, 'dispatching');
        for (const s of subjects) db.prepare('INSERT INTO subjects VALUES(?,?)').run(s, operationId);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (old) return old.status === 'delivered' ? JSON.parse(old.receipt) : { operationId, status: 'needs_reconciliation', retryAllowed: false };
    let receipt = null;
    try {
      // Recheck current custody, selection/suppression and actor immediately before I/O.
      await authorized(actor, authorize, Date.now());
      const latest = control(env, Date.now());
      if (latest.controlDigest !== c.controlDigest || !latest.authorizedUserIds.includes(actor.userId)) deny();
      const req = await buildSignedRequest({ origin: c.gatewayOrigin, payload, signingKey: env.AIBRAIN_INSIJETS_CRM_CALLER_HMAC, batch: true });
      const response = await fetcher(new Request(req, { signal: AbortSignal.timeout(20000) }));
      receipt = await boundedReceipt(response, operationId);
      if (receipt?.count !== rows.length) receipt = null;
    } catch { /* No payloads/errors/secrets logged. Unknown effects stay claimed. */ }
    const result = receipt || { operationId, status: 'needs_reconciliation', retryAllowed: false };
    db.prepare('UPDATE operations SET status=?,receipt=? WHERE id=?').run(receipt ? 'delivered' : 'needs_reconciliation', JSON.stringify(result), operationId);
    return result;
  } finally { db.close(); }
}
