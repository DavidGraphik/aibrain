import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const OCI = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const GROUPS = ['mail', 'crm', 'erp', 'documents', 'history', 'runtime'];
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

export const backendAcceptanceHash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const requireValue = (condition, code) => { if (!condition) throw new Error(code); };
const PACKAGE_KEYS = ['architecture', 'archiveSha256', 'candidateSha', 'fileCount', 'filesSha256', 'manifestSha256', 'payloadBytes'];
const packageIdentity = (value, candidateSha) => object(value)
  && Object.keys(value).sort().join(',') === PACKAGE_KEYS.join(',')
  && value.candidateSha === candidateSha && ['x64', 'arm64'].includes(value.architecture)
  && ['archiveSha256', 'filesSha256', 'manifestSha256'].every(key => HASH.test(value[key]))
  && Number.isSafeInteger(value.fileCount) && value.fileCount >= 4 && value.fileCount <= 25_000
  && Number.isSafeInteger(value.payloadBytes) && value.payloadBytes > 0 && value.payloadBytes <= 220 * 1024 ** 2;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const json = (bytes, code) => { try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(code); } };

/** Validates supplied evidence; never connects, runs cases, or manufactures a live receipt. */
export async function verifyBackendAcceptance(input, readEvidence, now = Date.now) {
  const { receipt, bank, manifest, candidateSha, manifestSha256, bankSha256 } = input;
  requireValue(SHA.test(candidateSha) && HASH.test(manifestSha256) && HASH.test(bankSha256), 'EXPECTED_IDENTITY_INVALID');
  requireValue(backendAcceptanceHash(input.manifestBytes) === manifestSha256, 'MANIFEST_INTEGRITY_MISMATCH');
  requireValue(backendAcceptanceHash(input.bankBytes) === bankSha256 && JSON.stringify(bank) === JSON.stringify(json(input.bankBytes, 'CASE_BANK_JSON_INVALID')), 'CASE_BANK_INTEGRITY_MISMATCH');
  requireValue(JSON.stringify(manifest) === JSON.stringify(json(input.manifestBytes, 'MANIFEST_JSON_INVALID')), 'MANIFEST_INTEGRITY_MISMATCH');
  requireValue(object(manifest) && manifest.kind === 'aibrain-release-manifest' && [1, 2].includes(manifest.schemaVersion)
    && manifest.candidateSha === candidateSha && Array.isArray(manifest.images) && manifest.images.length >= 1 && manifest.images.length <= 8, 'MANIFEST_IDENTITY_INVALID');
  // Version 1 is an image release. Version 2 binds an independently packaged
  // application to its runtime images without relabelling those base images.
  const packaged = manifest.schemaVersion === 2;
  requireValue(packaged ? packageIdentity(manifest.artifact, candidateSha) : manifest.artifact === undefined, 'MANIFEST_PACKAGE_INVALID');
  const images = new Map();
  for (const image of manifest.images) {
    requireValue(object(image) && typeof image.name === 'string' && ID.test(image.name) && !images.has(image.name)
      && (packaged ? SHA.test(image.revision) : image.revision === candidateSha) && OCI.test(image.digest), 'MANIFEST_IMAGE_INVALID');
    images.set(image.name, { digest: image.digest, revision: image.revision });
  }
  requireValue(images.has('app'), 'MANIFEST_APP_MISSING');
  requireValue(object(bank) && bank.schemaVersion === 1 && bank.suiteId === 'backend-common-v1'
    && timestamp(bank.registeredAt) && bank.registrationStage === 'after-initial-backend-changes'
    && Array.isArray(bank.cases) && bank.cases.length >= 36 && bank.cases.length <= 200, 'CASE_BANK_INVALID');
  const cases = new Map();
  for (const entry of bank.cases) {
    requireValue(object(entry) && typeof entry.id === 'string' && ID.test(entry.id) && !cases.has(entry.id) && GROUPS.includes(entry.category)
      && typeof entry.prompt === 'string' && entry.prompt.trim().length > 10 && typeof entry.critical === 'boolean'
      && typeof entry.mutating === 'boolean' && Number.isSafeInteger(entry.budgetMs) && entry.budgetMs >= 1_000 && entry.budgetMs <= 300_000
      && Array.isArray(entry.checks) && entry.checks.length >= 1 && entry.checks.every(check => typeof check === 'string' && ID.test(check))
      && new Set(entry.checks).size === entry.checks.length, 'CASE_BANK_ENTRY_INVALID');
    cases.set(entry.id, entry);
  }
  for (const category of GROUPS) requireValue(bank.cases.filter(entry => entry.category === category).length >= 4, 'CASE_BANK_CATEGORY_MISSING');
  requireValue(object(receipt) && receipt.kind === 'aibrain-backend-live-acceptance' && receipt.schemaVersion === 1
    && receipt.environment === 'live' && receipt.execution === 'authenticated-ui' && receipt.suiteId === bank.suiteId
    && receipt.suiteSha256 === bankSha256 && receipt.manifestSha256 === manifestSha256
    && receipt.candidateSha === candidateSha && receipt.installedSha === candidateSha, 'LIVE_IDENTITY_INVALID');
  requireValue(timestamp(receipt.startedAt) && timestamp(receipt.completedAt) && Date.parse(receipt.completedAt) > Date.parse(receipt.startedAt)
    && Date.parse(receipt.startedAt) >= Date.parse(bank.registeredAt) && Date.parse(receipt.completedAt) <= now() + 30_000, 'LIVE_WINDOW_INVALID');
  requireValue(Array.isArray(receipt.actors) && receipt.actors.length >= 2 && receipt.actors.length <= 20
    && receipt.actors.every(actor => typeof actor === 'string' && ID.test(actor))
    && new Set(receipt.actors).size === receipt.actors.length, 'ACTOR_COVERAGE_INVALID');
  requireValue(object(receipt.incidents) && ['crossUserAccess', 'duplicateEffects', 'incorrectWrites'].every(key => receipt.incidents[key] === false), 'CRITICAL_INCIDENT');
  requireValue(Array.isArray(receipt.results) && receipt.results.length <= cases.size, 'RESULTS_INVALID');

  let evidenceBytes = 0;
  const verifiedEvidence = new Map();
  const evidence = async reference => {
    requireValue(object(reference) && typeof reference.path === 'string' && HASH.test(reference.sha256), 'EVIDENCE_REFERENCE_INVALID');
    requireValue(/^[a-zA-Z0-9._/-]{1,250}$/u.test(reference.path) && !reference.path.startsWith('/')
      && !reference.path.split('/').some(part => !part || part === '.' || part === '..'), 'EVIDENCE_PATH_INVALID');
    if (verifiedEvidence.has(reference.path)) {
      const previous = verifiedEvidence.get(reference.path);
      requireValue(previous.sha256 === reference.sha256, 'EVIDENCE_HASH_CONFLICT');
      return previous.bytes;
    }
    const bytes = await readEvidence(reference.path);
    requireValue(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_FILE_BYTES, 'EVIDENCE_SIZE_INVALID');
    evidenceBytes += bytes.length;
    requireValue(evidenceBytes <= MAX_EVIDENCE_BYTES && backendAcceptanceHash(bytes) === reference.sha256, 'EVIDENCE_INTEGRITY_MISMATCH');
    verifiedEvidence.set(reference.path, { sha256: reference.sha256, bytes });
    return bytes;
  };
  const identity = json(await evidence(receipt.releaseIdentityEvidence), 'RUNTIME_IDENTITY_EVIDENCE_INVALID');
  requireValue(object(identity) && identity.kind === 'runtime-inspection' && identity.installedSha === candidateSha
    && identity.manifestSha256 === manifestSha256 && timestamp(identity.checkedAt)
    && Date.parse(identity.checkedAt) <= Date.parse(receipt.startedAt) && Date.parse(identity.checkedAt) >= Date.parse(receipt.startedAt) - 300_000 && Array.isArray(identity.images)
    && identity.images.length === images.size, 'RUNTIME_IDENTITY_MISMATCH');
  const observed = new Set();
  for (const image of identity.images) {
    const expected = object(image) ? images.get(image.name) : null;
    requireValue(expected && !observed.has(image.name) && expected.digest === image.digest
      && expected.revision === image.revision, 'RUNTIME_IMAGE_MISMATCH');
    observed.add(image.name);
  }
  if (packaged) {
    const artifact = identity.artifact;
    requireValue(packageIdentity(artifact?.package, candidateSha)
      && PACKAGE_KEYS.every(key => artifact.package[key] === manifest.artifact[key])
      && artifact.payloadReadOnly === true && artifact.verifiedFileCount === manifest.artifact.fileCount
      && artifact.verifiedPayloadBytes === manifest.artifact.payloadBytes
      && artifact.unexpectedCodeFiles === 0 && artifact.missingFiles === 0 && artifact.mismatchedFiles === 0,
    'RUNTIME_PACKAGE_MISMATCH');
  } else requireValue(identity.artifact === undefined, 'RUNTIME_PACKAGE_UNEXPECTED');

  const results = new Map();
  const actorsUsed = new Set();
  const failures = [];
  let criticalFailed = false;
  for (const result of receipt.results) {
    requireValue(object(result) && cases.has(result.caseId) && !results.has(result.caseId)
      && ['passed', 'failed', 'blocked', 'not-run'].includes(result.status), 'CASE_RESULT_INVALID');
    const definition = cases.get(result.caseId);
    if (result.duplicatesObserved !== undefined) requireValue(Number.isSafeInteger(result.duplicatesObserved) && result.duplicatesObserved >= 0, 'CASE_EFFECT_STATE_INVALID');
    requireValue((result.duplicatesObserved ?? 0) === 0 && result.unauthorizedEffects !== true && result.incorrectWrite !== true, 'CRITICAL_CASE_EFFECT');
    let passed = result.status === 'passed';
    if (passed) {
      requireValue(result.duplicatesObserved === 0 && result.unauthorizedEffects === false && result.incorrectWrite === false, 'CASE_EFFECT_STATE_MISSING');
      requireValue(receipt.actors.includes(result.actorId) && result.timingBasis === 'user-submit-to-final-response'
        && timestamp(result.startedAt) && timestamp(result.completedAt) && Number.isSafeInteger(result.elapsedMs)
        && result.elapsedMs >= 0 && Math.abs(Date.parse(result.completedAt) - Date.parse(result.startedAt) - result.elapsedMs) <= 1
        && Date.parse(result.startedAt) >= Date.parse(receipt.startedAt) && Date.parse(result.completedAt) <= Date.parse(receipt.completedAt), 'CASE_TIMING_OR_ACTOR_INVALID');
      requireValue(Array.isArray(result.passedChecks) && definition.checks.every(check => result.passedChecks.includes(check))
        && result.sourceVerified === true && object(result.evidence), 'CASE_VERIFICATION_MISSING');
      const ui = json(await evidence(result.evidence.ui), 'UI_EVIDENCE_INVALID');
      const source = json(await evidence(result.evidence.source), 'SOURCE_EVIDENCE_INVALID');
      for (const [proof, kind] of [[ui, 'authenticated-ui-case'], [source, 'source-verification']]) {
        requireValue(object(proof) && proof.kind === kind && proof.caseId === result.caseId && proof.actorId === result.actorId
          && proof.candidateSha === candidateSha && proof.startedAt === result.startedAt && proof.completedAt === result.completedAt,
        'CASE_EVIDENCE_BINDING_INVALID');
      }
      requireValue(ui.captureMode === 'browser' && source.verified === true, 'CASE_EVIDENCE_ORIGIN_INVALID');
      if (definition.mutating) {
        requireValue(result.readbackVerified === true && result.repetitionVerified === true, 'WRITE_VERIFICATION_MISSING');
        const readback = json(await evidence(result.evidence.readback), 'READBACK_EVIDENCE_INVALID');
        requireValue(object(readback) && readback.kind === 'provider-readback' && readback.caseId === result.caseId
          && readback.actorId === result.actorId && readback.candidateSha === candidateSha && readback.verified === true
          && readback.singleEffect === true, 'WRITE_READBACK_BINDING_INVALID');
      }
      actorsUsed.add(result.actorId);
      passed = result.elapsedMs <= definition.budgetMs;
    }
    results.set(result.caseId, passed);
    if (!passed) failures.push({ caseId: result.caseId, reason: result.status === 'passed' ? 'time-budget' : result.status });
  }
  for (const definition of cases.values()) {
    if (!results.has(definition.id)) failures.push({ caseId: definition.id, reason: 'missing' });
    if (definition.critical && results.get(definition.id) !== true) criticalFailed = true;
  }
  const categories = GROUPS.map(category => {
    const entries = [...cases.values()].filter(entry => entry.category === category);
    const passed = entries.filter(entry => results.get(entry.id) === true).length;
    return { category, passed, total: entries.length, percent: passed * 100 / entries.length };
  });
  const passed = [...results.values()].filter(Boolean).length;
  const total = cases.size;
  const percent = passed * 100 / total;
  return {
    accepted: percent > 90 && categories.every(category => category.percent >= 90) && !criticalFailed && actorsUsed.size >= 2,
    candidateSha, manifestSha256, bankSha256, passed, total, percent, categories, failures, criticalFailed,
    actorCoverage: actorsUsed.size,
    improvementVerified: false,
    notice: 'Validates supplied live evidence only. No cases executed. Improvement requires a separate comparable baseline using this exact case bank.',
  };
}

async function regularBytes(filename, expectedRoot) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    requireValue(metadata.isFile() && metadata.nlink === 1 && metadata.size <= MAX_FILE_BYTES, 'INPUT_FILE_INVALID');
    if (expectedRoot) {
      const resolved = await realpath(filename);
      const current = await lstat(filename);
      requireValue(resolved.startsWith(expectedRoot + path.sep) && !current.isSymbolicLink()
        && current.dev === metadata.dev && current.ino === metadata.ino, 'EVIDENCE_DIRECTORY_CHANGED');
    }
    const bytes = await handle.readFile();
    requireValue(bytes.length <= MAX_FILE_BYTES, 'INPUT_FILE_INVALID');
    return bytes;
  } finally { await handle.close(); }
}

export async function evidenceReader(root) {
  const canonical = await realpath(root);
  requireValue((await lstat(canonical)).isDirectory(), 'EVIDENCE_ROOT_INVALID');
  return async relative => {
    requireValue(typeof relative === 'string' && /^[a-zA-Z0-9._/-]{1,250}$/u.test(relative) && !relative.startsWith('/')
      && !relative.split('/').some(part => !part || part === '.' || part === '..'), 'EVIDENCE_PATH_INVALID');
    const parts = relative.split('/');
    let directory = canonical;
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);
      const metadata = await lstat(directory);
      requireValue(metadata.isDirectory() && !metadata.isSymbolicLink(), 'EVIDENCE_DIRECTORY_INVALID');
    }
    return regularBytes(path.join(canonical, relative), canonical);
  };
}

async function main(args) {
  const allowed = ['receipt', 'manifest', 'manifest-sha256', 'case-bank-sha256', 'candidate-sha', 'evidence-root'];
  const options = {};
  requireValue(args.length === allowed.length * 2, 'USAGE');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].slice(2);
    requireValue(args[index].startsWith('--') && allowed.includes(key) && !Object.hasOwn(options, key) && args[index + 1], 'USAGE');
    options[key] = args[index + 1];
  }
  const bankPath = fileURLToPath(new URL('../tests/acceptance/backend-use-cases.json', import.meta.url));
  const [receiptBytes, manifestBytes, bankBytes] = await Promise.all([
    regularBytes(options.receipt), regularBytes(options.manifest), regularBytes(bankPath),
  ]);
  const result = await verifyBackendAcceptance({
    receipt: json(receiptBytes, 'RECEIPT_JSON_INVALID'), manifest: json(manifestBytes, 'MANIFEST_JSON_INVALID'), bank: json(bankBytes, 'CASE_BANK_JSON_INVALID'),
    candidateSha: options['candidate-sha'], manifestSha256: options['manifest-sha256'], bankSha256: options['case-bank-sha256'], manifestBytes, bankBytes,
  }, await evidenceReader(options['evidence-root']));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.accepted ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Backend acceptance rejected: ${error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : 'INPUT_OR_EVIDENCE_UNAVAILABLE'}\n`);
    process.exitCode = 1;
  });
}
