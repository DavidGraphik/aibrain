// Offline only. Generate private G03 runtime inputs, never deploy or start it.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expectedAuthOrigin = process.env.AIBRAIN_EXPECTED_SUPABASE_ORIGIN || "https://project-ref.supabase.co";
const expectedOperatorId = process.env.AIBRAIN_EXPECTED_OPERATOR_ID || "00000000-0000-4000-8000-000000000001";
const expectedOperatorEmail = process.env.AIBRAIN_EXPECTED_OPERATOR_EMAIL || "operator@example.invalid";
const expectedPublicOrigin = process.env.AIBRAIN_EXPECTED_PUBLIC_ORIGIN || "https://brain.example.com";
for (const value of [expectedAuthOrigin, expectedPublicOrigin]) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw Error("Invalid reviewed origin binding");
}
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(expectedOperatorId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(expectedOperatorEmail)) throw Error("Invalid reviewed operator binding");

const directory = process.argv[2];
const chrome = process.argv[3];
if (!directory || !path.isAbsolute(directory) || !/^\d+\.\d+\.\d+\.\d+$/u.test(chrome ?? "")) {
  throw new Error("Usage: node prepare-runtime.mjs /private/operator/g03 <verified-image-chromium-version>");
}
const parent = await lstat(directory);
if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
  || (parent.mode & 0o077) !== 0 || await realpath(directory) !== directory) {
  throw new Error("Operator directory must be private, owned and canonical.");
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (directory === repo || directory.startsWith(repo + path.sep)) throw new Error("Secrets must remain outside Git.");
async function privateInput(name) {
  const handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > 65536 || (info.mode & 0o077)) {
      throw new Error("Unsafe private input.");
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
const auth = Object.fromEntries((await privateInput("auth.env")).trim().split(/\r?\n/u).map((line) => {
  const index = line.indexOf("=");
  if (index < 1) throw new Error("Malformed Auth input.");
  return [line.slice(0, index), line.slice(index + 1)];
}));
if (Object.keys(auth).length !== 3 || auth.AIBRAIN_AUTH_MODE !== "supabase"
  || auth.NEXT_PUBLIC_SUPABASE_URL !== expectedAuthOrigin
  || !/^sb_publishable_[A-Za-z0-9_-]+$/u.test(auth.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "")) {
  throw new Error("Only G03 publishable authentication may enter this runtime.");
}
const rosterBytes = await privateInput("users.json");
const roster = JSON.parse(rosterBytes);
if (roster.length !== 1 || roster[0].userId !== expectedOperatorId
  || roster[0].email !== expectedOperatorEmail || roster[0].requireInitialPasswordChange !== true) {
  throw new Error("G03 initial operator identity mismatch.");
}
const installation = JSON.parse(await readFile(process.env.AIBRAIN_INSTALLATION_TEMPLATE || path.join(repo, "deployments/g03/installation.example.json"), "utf8"));
if (installation.installationId !== "g03-production" || installation.publicUrl !== expectedPublicOrigin) {
  throw new Error("Wrong installation.");
}
const secret = () => randomBytes(48).toString("base64url");
const runtime = {
  NODE_ENV: "production", ...auth,
  ...Object.fromEntries(["SESSION", "AUTH_CHALLENGE", "PUBLICATION", "BROWSER_GATEWAY", "MAINTENANCE"]
    .map((key) => [`AIBRAIN_${key}_SECRET`, secret()])),
  AIBRAIN_USAGE_ADMIN_USER_IDS: roster[0].userId,
  AIBRAIN_CHROME_EXPECTED_VERSION: chrome,
  AIBRAIN_CHROME_LANGUAGE: "es-ES",
  AIBRAIN_AUTOMATION_WORKER_ENABLED: "false",
  AIBRAIN_MINIMUM_FREE_RATIO: "0.20", AIBRAIN_MINIMUM_FREE_BYTES: "1073741824",
  AIBRAIN_BROWSER_MAX_CONCURRENT_STARTS: "2", AIBRAIN_DOCUMENT_MAX_CONVERSIONS: "2",
  AIBRAIN_DOCUMENT_MAX_ACTIVE_UPLOADS: "2",
};
const egress = {
  ...Object.fromEntries(["BROWSER", "WORKER", "SERVER", "HEALTH"]
    .map((key) => [`AIBRAIN_EGRESS_${key}_TOKEN`, secret()])),
  AIBRAIN_EGRESS_WORKER_HOSTS: "api.openai.com,auth.openai.com",
  AIBRAIN_EGRESS_SUPABASE_ORIGIN: auth.NEXT_PUBLIC_SUPABASE_URL,
};
const destination = path.join(directory, "runtime-prepared");
await mkdir(destination, { mode: 0o700 }); // Refuse every existing destination; never rotate silently.
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const env = (value) => Object.entries(value).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
for (const [name, contents] of Object.entries({
  "runtime.env": env(runtime), "egress.env": env(egress),
  "restic-password": secret() + "\n", "users.json": rosterBytes,
  "installation.json": json(installation),
  ".aibrain-owner.json": json({ schemaVersion: 1, product: "aibrain", installationId: "g03-production" }),
  "readiness.json": json({ installationId: "g03-production", prepared: true, deployed: false,
    missing: ["verified G03 candidate release manifest", "off-host encrypted backup destination and restore proof",
      "operational alert webhook", "authenticated first boot", "DNS/TLS cutover", "Windows installation and acceptance"],
    disabled: ["Windows writes", "Sage", "automations"],
    note: "No placeholder secrets, backup URLs or alert endpoints are provided. Production preflight remains mandatory." }),
})) {
  const handle = await open(path.join(destination, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
}
console.log(JSON.stringify({ installationId: "g03-production", prepared: true, directory: destination,
  deployed: false, remoteChanges: false, secretsPrinted: false }));
