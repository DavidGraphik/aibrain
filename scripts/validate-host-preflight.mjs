import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const OWNER_FILE = ".aibrain-owner.json";
const LABEL_PRODUCT = "com.graphikai.aibrain.product";
const LABEL_INSTALLATION = "com.graphikai.aibrain.installation";
const IMMUTABLE_IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/u;
const CHANNEL_TOKEN = /^[A-Za-z0-9_-]{32,256}$/u;
const REQUIRED_OPENAI_WORKER_HOSTS = ["api.openai.com", "auth.openai.com"];

function fail(message) {
  process.stderr.write(`AiBrain host preflight failed: ${message}\n`);
  process.exit(78);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("expected --env-file path --installation id");
    if (key !== "--env-file" && key !== "--installation") fail(`unknown argument ${key}`);
    if (result[key]) fail(`duplicate argument ${key}`);
    result[key] = value;
  }
  if (!result["--env-file"] || !result["--installation"]) fail("--env-file and --installation are required");
  return { envFile: path.resolve(result["--env-file"]), installationId: result["--installation"] };
}

function parseEnv(contents) {
  const values = new Map();
  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) fail(`invalid env line ${index + 1}`);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || values.has(key)) fail(`invalid or duplicate env key at line ${index + 1}`);
    if (/[\r\n\0]/u.test(value)) fail(`invalid env value for ${key}`);
    values.set(key, value);
  }
  return values;
}

function required(env, key) {
  const value = env.get(key);
  if (!value) fail(`${key} is required`);
  return value;
}

function assertRegularNoSymlink(target, description) {
  const info = lstatSync(target, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) fail(`${description} must be a regular non-symlink file: ${target}`);
  return realpathSync(target);
}

function assertPrivateFile(target, description, expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined) {
  const canonical = assertRegularNoSymlink(target, description);
  const info = lstatSync(canonical);
  if (info.nlink !== 1 || (expectedUid !== undefined && info.uid !== expectedUid) || (info.mode & 0o077) !== 0) {
    fail(`${description} must be owner-controlled, have one link and no group/world permissions: ${target}`);
  }
  return canonical;
}

function assertControlledFile(target, description, expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined) {
  const canonical = assertRegularNoSymlink(target, description);
  const info = lstatSync(canonical);
  if (info.nlink !== 1 || (expectedUid !== undefined && info.uid !== expectedUid) || (info.mode & 0o022) !== 0) {
    fail(`${description} must be owner-controlled, exclusive and not group/world writable: ${target}`);
  }
  return canonical;
}

function assertDirectoryNoSymlink(target, description) {
  const info = lstatSync(target, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(`${description} must be a directory and not a symlink: ${target}`);
  return realpathSync(target);
}

function assertDirectoryPolicy(target, description, { uid, gid, forbiddenMode = 0, requiredMode = 0 }) {
  const canonical = assertDirectoryNoSymlink(target, description);
  const info = lstatSync(canonical);
  if (info.uid !== uid || info.gid !== gid || (info.mode & forbiddenMode) !== 0
    || (info.mode & requiredMode) !== requiredMode) {
    fail(`${description} has unsafe ownership or permissions: ${target}`);
  }
  return canonical;
}

function numericId(env, key) {
  const value = required(env, key);
  if (!/^[0-9]+$/u.test(value)) fail(`${key} must be numeric`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) fail(`${key} is invalid`);
  return parsed;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertOwner(root, installationId) {
  const markerPath = path.join(root, OWNER_FILE);
  assertControlledFile(markerPath, "ownership marker");
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    fail(`ownership marker is not valid JSON: ${markerPath}`);
  }
  if (marker?.schemaVersion !== 1 || marker?.product !== "aibrain" || marker?.installationId !== installationId) {
    fail(`ownership marker does not belong to ${installationId}: ${markerPath}`);
  }
}

function inspectExistingDockerResource(kind, name, installationId) {
  const list = spawnSync("docker", [kind, "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"], { encoding: "utf8" });
  if (list.status !== 0) fail(`cannot list Docker ${kind} resources`);
  const exact = list.stdout.split(/\r?\n/u).filter(Boolean).includes(name);
  if (!exact) return;
  let labels;
  try {
    labels = JSON.parse(execFileSync("docker", [kind, "inspect", name, "--format", "{{json .Labels}}"], { encoding: "utf8" }));
  } catch {
    fail(`cannot inspect existing Docker ${kind} ${name}`);
  }
  if (labels?.[LABEL_PRODUCT] !== "aibrain" || labels?.[LABEL_INSTALLATION] !== installationId) {
    fail(`existing Docker ${kind} ${name} is not owned by ${installationId}`);
  }
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(resolve));
  }).catch(() => fail(`loopback port ${port} is already occupied`));
}

const { envFile, installationId } = parseArgs(process.argv.slice(2));
if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(installationId)) fail("installation id is invalid");
if (process.platform === "linux") {
  try {
    accessSync("/usr/bin/flock", constants.X_OK);
  } catch {
    fail("/usr/bin/flock is required for crash-safe release serialization");
  }
}
const envFileReal = assertControlledFile(envFile, "compose env file");
const env = parseEnv(readFileSync(envFileReal, "utf8"));
for (const key of env.keys()) {
  if (/(?:^|_)(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY_ID)$/u.test(key)) {
    fail("compose env must not contain secret values");
  }
}
if (required(env, "AIBRAIN_INSTALLATION_ID") !== installationId) fail("installation id does not match compose env");
const serviceUid = numericId(env, "AIBRAIN_UID");
const serviceGid = numericId(env, "AIBRAIN_GID");

const prefix = `aibrain-${installationId}`;
const exactNames = new Map([
  ["AIBRAIN_COMPOSE_PROJECT_NAME", prefix],
  ["AIBRAIN_NETWORK_NAME", `${prefix}-private`],
  ["AIBRAIN_EGRESS_NETWORK_NAME", `${prefix}-egress`],
  ["AIBRAIN_INGRESS_NETWORK_NAME", `${prefix}-ingress`],
  ["AIBRAIN_DATA_VOLUME_NAME", `${prefix}-data`],
  ["AIBRAIN_BACKUP_VOLUME_NAME", `${prefix}-backups`],
  ["AIBRAIN_RESTORE_VOLUME_NAME", `${prefix}-restores`],
]);
for (const [key, expected] of exactNames) {
  if (required(env, key) !== expected) fail(`${key} must equal ${expected}`);
}
const resourceNames = [...exactNames.values()];
if (new Set(resourceNames).size !== resourceNames.length) fail("project, network and volume names must be distinct");

const configFile = assertControlledFile(required(env, "AIBRAIN_INSTALLATION_CONFIG_HOST"), "installation config");
const runtimeEnv = assertPrivateFile(required(env, "AIBRAIN_RUNTIME_ENV_FILE"), "runtime env");
const egressEnv = assertPrivateFile(required(env, "AIBRAIN_EGRESS_ENV_FILE"), "egress env");
const alertsEnv = assertPrivateFile(required(env, "AIBRAIN_ALERTS_ENV_FILE"), "alerts env");
const replicaEnv = assertPrivateFile(required(env, "AIBRAIN_REPLICA_ENV_FILE"), "replica env");
const resticPassword = assertPrivateFile(required(env, "AIBRAIN_RESTIC_PASSWORD_FILE_HOST"), "Restic password file", serviceUid);
if ((lstatSync(resticPassword).mode & 0o222) !== 0) fail("Restic password file must be read-only");
const configRoot = realpathSync(path.dirname(configFile));
if (path.dirname(runtimeEnv) !== configRoot || path.dirname(egressEnv) !== configRoot
  || path.dirname(alertsEnv) !== configRoot
  || path.dirname(replicaEnv) !== configRoot || path.dirname(resticPassword) !== configRoot) {
  fail("installation config and all secret env/password files must share one owned config root");
}
assertOwner(configRoot, installationId);

for (const key of ["AIBRAIN_IMAGE", "AIBRAIN_EGRESS_IMAGE"]) {
  if (!IMMUTABLE_IMAGE.test(required(env, key))) fail(`${key} must use an immutable sha256 digest`);
}
const egressPolicy = parseEnv(readFileSync(egressEnv, "utf8"));
const channelTokens = [
  required(egressPolicy, "AIBRAIN_EGRESS_BROWSER_TOKEN"),
  required(egressPolicy, "AIBRAIN_EGRESS_WORKER_TOKEN"),
  required(egressPolicy, "AIBRAIN_EGRESS_SERVER_TOKEN"),
];
if (channelTokens.some((token) => !CHANNEL_TOKEN.test(token)) || new Set(channelTokens).size !== 3) {
  fail("egress channel tokens must be strong and pairwise distinct");
}
const mailHosts = (egressPolicy.get("AIBRAIN_EGRESS_MAIL_HOSTS") ?? "").split(",").filter(Boolean);
if (mailHosts.length > 10 || mailHosts.some(host => !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u.test(host) ||
    host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))) {
  fail("IMAPS egress requires exact normalized public DNS hostnames");
}
const workerHosts = required(egressPolicy, "AIBRAIN_EGRESS_WORKER_HOSTS").split(",");
if (workerHosts.some((host) => !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host) ||
    host.includes("..") || host === "localhost" || host.endsWith(".localhost"))) {
  fail("worker egress hosts must be exact normalized DNS hostnames");
}
const missingOpenAiWorkerHosts = REQUIRED_OPENAI_WORKER_HOSTS.filter((host) => !workerHosts.includes(host));
if (missingOpenAiWorkerHosts.length > 0) {
  fail(`worker egress is missing required OpenAI hosts: ${missingOpenAiWorkerHosts.join(",")}`);
}
let supabaseOrigin;
try {
  supabaseOrigin = new URL(required(egressPolicy, "AIBRAIN_EGRESS_SUPABASE_ORIGIN"));
} catch {
  fail("Supabase egress origin is invalid");
}
if (supabaseOrigin.protocol !== "https:" || supabaseOrigin.username || supabaseOrigin.password ||
    supabaseOrigin.port || supabaseOrigin.pathname !== "/" || supabaseOrigin.search || supabaseOrigin.hash) {
  fail("Supabase egress origin must be an exact credential-free HTTPS origin");
}
const runtimePolicy = parseEnv(readFileSync(runtimeEnv, "utf8"));
const companyMail = JSON.parse(readFileSync(configFile, "utf8")).connectors?.companyMail;
if (companyMail?.enabled) {
  if (!mailHosts.includes(companyMail.host)) fail("enabled company mailbox host is absent from the IMAPS allowlist");
  const mailKey = runtimePolicy.get("AIBRAIN_COMPANY_MAIL_ENCRYPTION_KEY") ?? "";
  const decodedMailKey = Buffer.from(mailKey, "base64");
  if (decodedMailKey.length !== 32 || decodedMailKey.toString("base64") !== mailKey) fail("enabled company mail requires a 32-byte base64 encryption key");
}

if (required(runtimePolicy, "NEXT_PUBLIC_SUPABASE_URL") !== supabaseOrigin.origin) {
  fail("Supabase auth URL and server egress origin must match exactly");
}
const alertPolicy = parseEnv(readFileSync(alertsEnv, "utf8"));
// Host-only recovery requires a newly reviewed acceptance supplied by the operator.
// No historical acceptance is inherited by this public source; tenant and origin stay bound.
const recoveryDecision = env.get("AIBRAIN_G03_RECOVERY_DECISION");
const expectedDecision = process.env.AIBRAIN_HOST_LOSS_ACCEPTANCE_ID;
const expectedPublicOrigin = process.env.AIBRAIN_EXPECTED_PUBLIC_ORIGIN || "https://brain.example.com";
const hostLocal = typeof expectedDecision === "string" && /^[a-z0-9][a-z0-9-]{7,127}$/u.test(expectedDecision) && recoveryDecision === expectedDecision;
if (recoveryDecision !== undefined && (!hostLocal || installationId !== "g03-production")) {
  fail("host-only recovery is authorized exclusively for G03 with its explicit decision");
}
if (hostLocal) {
  let reviewedOrigin;
  try { reviewedOrigin = new URL(expectedPublicOrigin); } catch { fail("Reviewed host-local origin is invalid"); }
  if (reviewedOrigin.protocol !== "https:" || reviewedOrigin.origin !== expectedPublicOrigin || reviewedOrigin.username || reviewedOrigin.password) fail("Reviewed host-local origin must be an exact credential-free HTTPS origin");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  if (config.installationId !== "g03-production" || config.publicUrl !== expectedPublicOrigin
    || alertPolicy.get("AIBRAIN_G03_RECOVERY_DECISION") !== recoveryDecision
    || alertPolicy.get("AIBRAIN_ALERT_SINK") !== "file") {
    fail("G03 host-local recovery and local alert policy disagree");
  }
}
const healthToken = required(egressPolicy, "AIBRAIN_EGRESS_HEALTH_TOKEN");
if (!CHANNEL_TOKEN.test(healthToken) || channelTokens.includes(healthToken)) {
  fail("egress health token must be strong and distinct from channel tokens");
}
if (required(alertPolicy, "AIBRAIN_ALERT_EGRESS_HEALTH_TOKEN") !== healthToken) {
  fail("alert dispatcher health token must match the dedicated egress health token");
}
if (!hostLocal) {
if (required(alertPolicy, "AIBRAIN_ALERT_SINK") !== "webhook") fail("external alert sink must be webhook");
let alertWebhook;
try {
  alertWebhook = new URL(required(alertPolicy, "AIBRAIN_ALERT_WEBHOOK_URL"));
} catch {
  fail("alert webhook URL is invalid");
}
if (alertWebhook.protocol !== "https:" || alertWebhook.username || alertWebhook.password || alertWebhook.hash) {
  fail("alert webhook must be a credential-free HTTPS URL");
}
if (!CHANNEL_TOKEN.test(required(alertPolicy, "AIBRAIN_ALERT_WEBHOOK_TOKEN"))) {
  fail("alert webhook token must be strong");
}
}
const replicaPolicy = parseEnv(readFileSync(replicaEnv, "utf8"));
if (hostLocal) {
  if (replicaPolicy.size !== 1 || replicaPolicy.get("AIBRAIN_G03_RECOVERY_DECISION") !== recoveryDecision) {
    fail("G03 host-only recovery must not contain an external or pretend replica destination");
  }
  process.stderr.write("G03 recovery: local snapshots only; host loss is NOT covered; alerts remain local.\n");
} else {
const resticRepository = required(replicaPolicy, "AIBRAIN_RESTIC_REPOSITORY");
if (!/^(?:s3:https:\/\/|rest:https:\/\/|b2:|azure:|gs:)/u.test(resticRepository)) {
  fail("Restic repository must use an approved off-host encrypted backend");
}
}

const operatorUid = typeof process.getuid === "function" ? process.getuid() : lstatSync(configRoot).uid;
const operatorGid = typeof process.getgid === "function" ? process.getgid() : lstatSync(configRoot).gid;
assertDirectoryPolicy(configRoot, "installation config root", {
  uid: operatorUid, gid: operatorGid, forbiddenMode: 0o022,
});
const hostRoot = assertDirectoryPolicy(required(env, "AIBRAIN_HOST_ROOT"), "installation host root", {
  uid: operatorUid, gid: operatorGid, forbiddenMode: 0o022,
});
const sourceRoot = assertDirectoryPolicy(required(env, "AIBRAIN_SOURCE_HOST_PATH"), "source root", {
  uid: serviceUid, gid: serviceGid, forbiddenMode: 0o222, requiredMode: 0o500,
});
const publishRoot = assertDirectoryPolicy(required(env, "AIBRAIN_PUBLISH_HOST_PATH"), "publish root", {
  uid: serviceUid, gid: serviceGid, forbiddenMode: 0o022, requiredMode: 0o700,
});
const replicaStateRoot = assertDirectoryPolicy(required(env, "AIBRAIN_REPLICA_STATE_HOST_PATH"), "replica state root", {
  uid: serviceUid, gid: serviceGid, forbiddenMode: 0o077, requiredMode: 0o700,
});
assertOwner(hostRoot, installationId);
if (!isInside(hostRoot, sourceRoot) || !isInside(hostRoot, publishRoot) || !isInside(hostRoot, replicaStateRoot)) {
  fail("source, publish and replica state roots must be children of the owned host root");
}
const isolatedRoots = [sourceRoot, publishRoot, replicaStateRoot];
for (let left = 0; left < isolatedRoots.length; left += 1) {
  for (let right = left + 1; right < isolatedRoots.length; right += 1) {
    if (isolatedRoots[left] === isolatedRoots[right]
      || isInside(isolatedRoots[left], isolatedRoots[right])
      || isInside(isolatedRoots[right], isolatedRoots[left])) {
      fail("source, publish and replica state roots must not overlap");
    }
  }
}

for (const target of [envFileReal, runtimeEnv, egressEnv, alertsEnv, replicaEnv, resticPassword, configRoot, hostRoot, sourceRoot, publishRoot, replicaStateRoot]) {
  if (/(?:^|[\\/])bgreenly(?:[\\/]|$)/iu.test(target)) fail("an AiBrain path must never address BGreenly");
}

const portText = required(env, "AIBRAIN_HTTP_PORT");
if (!/^[0-9]+$/u.test(portText)) fail("AIBRAIN_HTTP_PORT must be numeric");
const port = Number(portText);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail("AIBRAIN_HTTP_PORT must be between 1024 and 65535");

const offline = process.env.AIBRAIN_PREFLIGHT_ALLOW_OFFLINE === "1";
if (offline) {
  process.stdout.write("WARNING: Docker ownership and port availability skipped in explicit offline test mode\n");
} else {
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (docker.status !== 0 || !docker.stdout.trim()) fail("Docker daemon is unavailable");
  const buildx = spawnSync("docker", ["buildx", "version"], { encoding: "utf8" });
  if (buildx.status !== 0) fail("Docker Buildx is unavailable");
  inspectExistingDockerResource("network", required(env, "AIBRAIN_NETWORK_NAME"), installationId);
  inspectExistingDockerResource("network", required(env, "AIBRAIN_EGRESS_NETWORK_NAME"), installationId);
  for (const key of ["AIBRAIN_DATA_VOLUME_NAME", "AIBRAIN_BACKUP_VOLUME_NAME", "AIBRAIN_RESTORE_VOLUME_NAME"]) {
    inspectExistingDockerResource("volume", required(env, key), installationId);
  }
  await assertPortAvailable(port);
}

process.stdout.write(`AiBrain host preflight: PASS (${installationId})\n`);
