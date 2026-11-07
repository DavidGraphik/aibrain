import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backendAcceptanceHash, evidenceReader, verifyBackendAcceptance } from './verify-backend-acceptance.mjs';

const script = fileURLToPath(new URL('./verify-backend-acceptance.mjs', import.meta.url));
const bankBytes = await readFile(new URL('../tests/acceptance/backend-use-cases.json', import.meta.url));
const bank = JSON.parse(bankBytes);
const candidateSha = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);
const start = '2026-11-05T19:00:00.000Z';
const end = '2026-11-05T19:05:00.000Z';
const clock = () => Date.parse(end);

// Unit fixtures remain in memory. They exercise validation and are not collected
// browser/provider evidence or evidence of a live acceptance run.
function fixture() {
  const files = new Map();
  const proof = (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    files.set(name, bytes);
    return { path: name, sha256: backendAcceptanceHash(bytes) };
  };
  const manifest = { kind: 'aibrain-release-manifest', schemaVersion: 1, candidateSha,
    images: [{ name: 'app', revision: candidateSha, digest }] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestSha256 = backendAcceptanceHash(manifestBytes);
  const identity = proof('runtime.json', { kind: 'runtime-inspection', installedSha: candidateSha,
    manifestSha256, checkedAt: start, images: manifest.images });
  const receipt = { schemaVersion: 1, kind: 'aibrain-backend-live-acceptance', environment: 'live', execution: 'authenticated-ui',
    suiteId: bank.suiteId, suiteSha256: backendAcceptanceHash(bankBytes), manifestSha256,
    candidateSha, installedSha: candidateSha, startedAt: start, completedAt: end, actors: ['employee-a', 'employee-b'],
    incidents: { crossUserAccess: false, duplicateEffects: false, incorrectWrites: false }, releaseIdentityEvidence: identity,
    results: bank.cases.map((entry, index) => {
      const actorId = index % 2 ? 'employee-b' : 'employee-a';
      const completedAt = '2026-11-05T19:00:10.000Z';
      const binding = { caseId: entry.id, actorId, candidateSha, startedAt: start, completedAt };
      return { ...binding, status: 'passed', timingBasis: 'user-submit-to-final-response', elapsedMs: 10_000,
        duplicatesObserved: 0, unauthorizedEffects: false, incorrectWrite: false,
        passedChecks: entry.checks, sourceVerified: true, readbackVerified: true, repetitionVerified: true,
        evidence: { ui: proof(entry.id + '-ui.json', { ...binding, kind: 'authenticated-ui-case', captureMode: 'browser' }),
          source: proof(entry.id + '-source.json', { ...binding, kind: 'source-verification', verified: true }),
          ...(entry.mutating ? { readback: proof(entry.id + '-readback.json', { ...binding, kind: 'provider-readback', verified: true, singleEffect: true }) } : {}) } };
    }) };
  const input = { receipt, bank: structuredClone(bank), manifest, manifestBytes, bankBytes,
    candidateSha, manifestSha256, bankSha256: backendAcceptanceHash(bankBytes) };
  const run = () => verifyBackendAcceptance(input, async name => {
    if (!files.has(name)) throw new Error('Missing synthetic unit fixture');
    return files.get(name);
  }, clock);
  return { input, files, run };
}

test('validates a coherent candidate while explicitly refusing to infer improvement', async () => {
  const result = await fixture().run();
  assert.equal(result.accepted, true);
  assert.equal(result.passed, 48);
  assert.equal(result.total, 48);
  assert.equal(result.improvementVerified, false);
  assert.equal(result.actorCoverage, 2);
});

function replaceInspection(f, change) {
  const value = JSON.parse(f.files.get('runtime.json')); change(value);
  const bytes = Buffer.from(JSON.stringify(value)); f.files.set('runtime.json', bytes);
  f.input.receipt.releaseIdentityEvidence.sha256 = backendAcceptanceHash(bytes);
}

function packagedFixture() {
  const f = fixture();
  f.input.manifest.schemaVersion = 2;
  f.input.manifest.images[0].revision = 'c'.repeat(40); // Actual older runtime image.
  f.input.manifest.artifact = { architecture: 'x64', archiveSha256: 'd'.repeat(64), candidateSha,
    fileCount: 4, filesSha256: 'e'.repeat(64), manifestSha256: 'f'.repeat(64), payloadBytes: 4096 };
  f.input.manifestBytes = Buffer.from(JSON.stringify(f.input.manifest));
  f.input.manifestSha256 = backendAcceptanceHash(f.input.manifestBytes);
  f.input.receipt.manifestSha256 = f.input.manifestSha256;
  replaceInspection(f, identity => {
    identity.manifestSha256 = f.input.manifestSha256;
    identity.images = structuredClone(f.input.manifest.images);
    identity.artifact = { package: structuredClone(f.input.manifest.artifact), payloadReadOnly: true,
      verifiedFileCount: 4, verifiedPayloadBytes: 4096, unexpectedCodeFiles: 0, missingFiles: 0, mismatchedFiles: 0 };
  });
  return f;
}

test('binds a separately packaged application and the actual unchanged base image', async () => {
  const f = packagedFixture();
  assert.notEqual(f.input.manifest.images[0].revision, candidateSha);
  assert.equal((await f.run()).accepted, true);
  assert.equal((await f.run()).improvementVerified, false);
});

test('package acceptance still requires original base image identity and a fresh inspection', async () => {
  for (const change of [identity => { identity.images[0].revision = candidateSha; },
    identity => { identity.images[0].digest = 'sha256:' + '0'.repeat(64); },
    identity => { identity.checkedAt = '2026-11-05T18:54:59.000Z'; }]) {
    const f = packagedFixture(); replaceInspection(f, change); await assert.rejects(f.run, /RUNTIME_(?:IMAGE|IDENTITY)_MISMATCH/);
  }
});

test('rejects missing, different, partially verified or writable packaged code', async () => {
  for (const change of [identity => { delete identity.artifact; },
    identity => { identity.artifact.package.candidateSha = 'c'.repeat(40); },
    identity => { identity.artifact.package.manifestSha256 = '0'.repeat(64); },
    identity => { identity.artifact.package.archiveSha256 = '0'.repeat(64); },
    identity => { identity.artifact.package.filesSha256 = '0'.repeat(64); },
    identity => { identity.artifact.package.architecture = 'arm64'; },
    identity => { identity.artifact.payloadReadOnly = false; },
    identity => { identity.artifact.verifiedFileCount = 3; },
    identity => { identity.artifact.verifiedPayloadBytes = 4095; },
    identity => { identity.artifact.unexpectedCodeFiles = 1; },
    identity => { identity.artifact.missingFiles = 1; },
    identity => { identity.artifact.mismatchedFiles = 1; }]) {
    const f = packagedFixture(); replaceInspection(f, change); await assert.rejects(f.run, /RUNTIME_PACKAGE_MISMATCH/);
  }
});

test('a package cannot bypass the original image-only release contract', async () => {
  const f = packagedFixture(); f.input.manifest.schemaVersion = 1;
  f.input.manifestBytes = Buffer.from(JSON.stringify(f.input.manifest));
  f.input.manifestSha256 = backendAcceptanceHash(f.input.manifestBytes);
  await assert.rejects(f.run, /MANIFEST_PACKAGE_INVALID/);
  const old = fixture(); replaceInspection(old, identity => { identity.artifact = {}; });
  await assert.rejects(old.run, /RUNTIME_PACKAGE_UNEXPECTED/);
});

test('packaging cannot waive failed critical cases or missing UI/source evidence', async () => {
  const f = packagedFixture();
  f.input.receipt.results.find(result => result.caseId === 'mail-foreign-account').status = 'blocked';
  assert.equal((await f.run()).accepted, false);
  const missing = packagedFixture(); missing.files.delete(missing.input.receipt.results[0].evidence.ui.path);
  await assert.rejects(missing.run);
});

test('missing, blocked and failed cases retain the fixed denominator', async () => {
  const f = fixture();
  const optional = f.input.receipt.results.filter(result => !bank.cases.find(entry => entry.id === result.caseId).critical);
  f.input.receipt.results = f.input.receipt.results.filter(result => result.caseId !== optional[0].caseId);
  f.input.receipt.results.find(result => result.caseId === optional[1].caseId).status = 'blocked';
  f.input.receipt.results.find(result => result.caseId === optional[2].caseId).status = 'failed';
  const result = await f.run();
  assert.equal(result.total, 48);
  assert.equal(result.passed, 45);
  assert.equal(result.failures.length, 3);
  assert.ok(result.failures.some(entry => entry.reason === 'missing'));
});

test('requires strictly greater than ninety percent, including not-run cases', async () => {
  const f = fixture();
  const optional = f.input.receipt.results.filter(result => !bank.cases.find(entry => entry.id === result.caseId).critical);
  for (const entry of optional.slice(0, 5)) entry.status = 'not-run';
  const result = await f.run();
  assert.equal(result.accepted, false);
  assert.equal(result.passed, 43);
  assert.ok(result.percent < 90);
});

test('exactly ninety percent fails even with sufficient category and critical coverage', async () => {
  const f = fixture();
  for (const category of ['mail', 'documents']) {
    const source = f.input.bank.cases.find(entry => entry.category === category);
    f.input.bank.cases.push({...source, id: category + '-additional', critical:false, mutating:false});
  }
  f.input.bankBytes = Buffer.from(JSON.stringify(f.input.bank));
  f.input.bankSha256 = backendAcceptanceHash(f.input.bankBytes);
  f.input.receipt.suiteSha256 = f.input.bankSha256;
  for (const id of ['crm-exact-company', 'history-dated-report', 'runtime-background-load']) {
    f.input.receipt.results.find(entry => entry.caseId === id).status = 'failed';
  }
  const result = await f.run();
  assert.equal(result.percent, 90);
  assert.equal(result.criticalFailed, false);
  assert.ok(result.categories.every(entry => entry.percent >= 80));
  assert.equal(result.accepted, false);
});

test('a weak category or failed critical case blocks a high overall average', async () => {
  const f = fixture();
  for (const result of f.input.receipt.results.filter(result => result.caseId.startsWith('history-')).slice(0, 2)) result.status = 'blocked';
  const byCategory = await f.run();
  assert.ok(byCategory.percent > 90);
  assert.equal(byCategory.accepted, false);
  const critical = fixture();
  critical.input.receipt.results.find(result => result.caseId === 'mail-foreign-account').status = 'blocked';
  const result = await critical.run();
  assert.ok(result.percent > 90);
  assert.equal(result.accepted, false);
  assert.equal(result.criticalFailed, true);
});

test('over-budget responses fail despite functional success and final-chunk timing cannot replace total time', async () => {
  const f = fixture();
  const result = f.input.receipt.results.find(entry => entry.caseId === 'mail-reference');
  result.completedAt = '2026-11-05T19:01:01.000Z'; result.elapsedMs = 61_000;
  for (const key of ['ui', 'source']) {
    const reference = result.evidence[key];
    const value = JSON.parse(f.files.get(reference.path)); value.completedAt = result.completedAt;
    const bytes = Buffer.from(JSON.stringify(value)); f.files.set(reference.path, bytes); reference.sha256 = backendAcceptanceHash(bytes);
  }
  assert.ok((await f.run()).failures.some(entry => entry.caseId === result.caseId && entry.reason === 'time-budget'));
  result.elapsedMs = 1_000;
  await assert.rejects(f.run, /CASE_TIMING_OR_ACTOR_INVALID/);
});

test('rejects local or mock runs, drifted candidate, altered manifests and a changed bank', async () => {
  for (const change of [f => { f.input.receipt.environment = 'local'; }, f => { f.input.receipt.execution = 'mock'; },
    f => { f.input.receipt.installedSha = 'c'.repeat(40); }, f => { f.input.manifestBytes = Buffer.from('{}'); },
    f => { f.input.bankBytes = Buffer.from('{}'); }]) {
    const f = fixture(); change(f); await assert.rejects(f.run);
  }
});

test('requires matching runtime image digests from a recent independent inspection artifact', async () => {
  const f = fixture();
  const identity = JSON.parse(f.files.get('runtime.json')); identity.images[0].digest = 'sha256:' + 'd'.repeat(64);
  const bytes = Buffer.from(JSON.stringify(identity)); f.files.set('runtime.json', bytes);
  f.input.receipt.releaseIdentityEvidence.sha256 = backendAcceptanceHash(bytes);
  await assert.rejects(f.run, /RUNTIME_IMAGE_MISMATCH/);
});

test('rejects missing, changed, reused or unbound evidence', async () => {
  for (const change of [f => f.files.delete(f.input.receipt.results[0].evidence.ui.path),
    f => f.files.set(f.input.receipt.results[0].evidence.source.path, Buffer.from('changed')),
    f => { f.input.receipt.results[1].evidence.ui = f.input.receipt.results[0].evidence.ui; },
    f => { f.input.receipt.results[0].evidence.ui.path = '../outside.json'; },
    f => { f.input.receipt.results[0].sourceVerified = false; }]) {
    const f = fixture(); change(f); await assert.rejects(f.run);
  }
});

test('write readback, duplicate effects and foreign access cannot be averaged away', async () => {
  for (const change of [f => { f.input.receipt.incidents.crossUserAccess = true; },
    f => { f.input.receipt.results[0].duplicatesObserved = 1; },
    f => { f.input.receipt.results[0].incorrectWrite = true; },
    f => { f.input.receipt.results.find(entry => entry.caseId === 'crm-note-repeat').readbackVerified = false; }]) {
    const f = fixture(); change(f); await assert.rejects(f.run);
  }
});

test('rejects duplicate result IDs, unknown cases, missing effects and future windows', async () => {
  for (const change of [f => { f.input.receipt.results[1].caseId = f.input.receipt.results[0].caseId; },
    f => { f.input.receipt.results[0].caseId = 'unknown-case'; },
    f => { delete f.input.receipt.results[0].duplicatesObserved; },
    f => { f.input.receipt.completedAt = '2099-01-01T00:00:00.000Z'; }]) {
    const f = fixture(); change(f); await assert.rejects(f.run);
  }
});

test('filesystem reader rejects traversal and symbolic links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'backend-proof-'));
  try {
    await writeFile(path.join(root, 'real.json'), '{}');
    await symlink(path.join(root, 'real.json'), path.join(root, 'link.json'));
    const read = await evidenceReader(root);
    assert.equal((await read('real.json')).toString(), '{}');
    await assert.rejects(() => read('../outside.json'), /EVIDENCE_PATH_INVALID/);
    await assert.rejects(() => read('link.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI absence of evidence fails closed and never writes a receipt', () => {
  const noArgs = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /rejected: USAGE/);
  assert.equal(noArgs.stdout, '');
  assert.throws(() => execFileSync(process.execPath, [script, '--receipt', '/missing'], { stdio: 'pipe' }));
});
