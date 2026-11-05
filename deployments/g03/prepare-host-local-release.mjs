// Offline packaging requires a new explicit host-only recovery decision.
// Never contact a provider, rotate credentials, overwrite or start a service.
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expectedAuthOrigin = process.env.AIBRAIN_EXPECTED_SUPABASE_ORIGIN || "https://project-ref.supabase.co";
const expectedOperatorId = process.env.AIBRAIN_EXPECTED_OPERATOR_ID || "00000000-0000-4000-8000-000000000001";
const expectedPublicOrigin = process.env.AIBRAIN_EXPECTED_PUBLIC_ORIGIN || "https://brain.example.com";
const expectedImage = process.env.AIBRAIN_EXPECTED_IMAGE_REPOSITORY || "ghcr.io/example-owner/graphikai-brain";
const expectedEgressImage = process.env.AIBRAIN_EXPECTED_EGRESS_IMAGE_REPOSITORY || "ghcr.io/example-owner/graphikai-brain-egress";
const decision = process.env.AIBRAIN_HOST_LOSS_ACCEPTANCE_ID;
if (!decision || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(decision)) throw Error("A new explicit host-only recovery acceptance is required");
for (const value of [expectedAuthOrigin, expectedPublicOrigin]) { const url = new URL(value); if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw Error("Invalid reviewed origin binding"); }
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(expectedOperatorId)) throw Error("Invalid reviewed operator binding");

const [operator, manifestFile] = process.argv.slice(2);
if (!operator || !manifestFile || !path.isAbsolute(operator) || !path.isAbsolute(manifestFile)) {
  throw new Error("Usage: node prepare-host-local-release.mjs <private operator directory> <verified release.json>");
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function privateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
    || (info.mode & 0o077) || await realpath(directory) !== directory
    || directory === repo || directory.startsWith(repo + path.sep)) throw new Error("Unsafe private directory");
}
async function privateFile(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid()
      || (info.mode & 0o077) || info.size > 65536) throw new Error("Unsafe private file");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
await privateDirectory(operator);
const prepared = path.join(operator, "runtime-prepared");
await privateDirectory(prepared);
const manifest = JSON.parse(await privateFile(manifestFile));
if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(manifest.revision)
  || !/^[a-z0-9][a-z0-9./_-]+@sha256:[a-f0-9]{64}$/u.test(manifest.image ?? "")
  || !/^[a-z0-9][a-z0-9./_-]+@sha256:[a-f0-9]{64}$/u.test(manifest.egressImage ?? "")
  || manifest.image.split("@")[0] !== expectedImage
  || manifest.egressImage.split("@")[0] !== expectedEgressImage) {
  throw new Error("Only exact David-owned candidate images are accepted");
}
const config = JSON.parse(await privateFile(path.join(prepared, "installation.json")));
if (config.installationId !== "g03-production" || config.publicUrl !== expectedPublicOrigin) {
  throw new Error("Wrong installation");
}
const egress = await privateFile(path.join(prepared, "egress.env"));
const health = /^AIBRAIN_EGRESS_HEALTH_TOKEN=([A-Za-z0-9_-]{64})$/mu.exec(egress)?.[1];
if (!health) throw new Error("Dedicated health token is missing");
const runtime = await privateFile(path.join(prepared, "runtime.env"));
if (!runtime.includes(`NEXT_PUBLIC_SUPABASE_URL=${expectedAuthOrigin}\n`)
  || /^AIBRAIN_(G03_PUBLICATION_ENABLED|ADMIN_USER_IDS)=/mu.test(runtime)) {
  throw new Error("Wrong Auth or already configured release controls");
}
const template = await readFile(path.join(repo, "infra/hetzner/compose.env.example"), "utf8");
const environment = template.replaceAll("company-qa", "g03-production")
  .replace(/^AIBRAIN_IMAGE=.+$/mu, `AIBRAIN_IMAGE=${manifest.image}`)
  .replace(/^AIBRAIN_EGRESS_IMAGE=.+$/mu, `AIBRAIN_EGRESS_IMAGE=${manifest.egressImage}`)
  .replace(/^AIBRAIN_REVISION=.+$/mu, `AIBRAIN_REVISION=${manifest.revision}`)
  + `\nAIBRAIN_AUTOMATION_WORKER_ENABLED=false\nAIBRAIN_G03_RECOVERY_DECISION=${decision}\n`;
const destination = path.join(operator, `release-inputs-${manifest.revision}`);
await mkdir(destination, { mode: 0o700 });
const files = {
  "compose.env": environment,
  "runtime.env": runtime + `AIBRAIN_ADMIN_USER_IDS=${expectedOperatorId}\nAIBRAIN_G03_PUBLICATION_ENABLED=true\n`,
  "egress.env": egress,
  "alerts.env": `AIBRAIN_ALERT_SINK=file\nAIBRAIN_G03_RECOVERY_DECISION=${decision}\nAIBRAIN_ALERT_EGRESS_HEALTH_TOKEN=${health}\n`,
  "replica.env": `AIBRAIN_G03_RECOVERY_DECISION=${decision}\n`,
  "readiness.json": JSON.stringify({ installationId: "g03-production", revision: manifest.revision,
    prepared: true, deployed: false, recovery: "local-only", hostLossRiskAccepted: decision,
    externalNotifications: false, missing: ["authenticated first boot", "DNS/TLS cutover",
      "local restore proof", "Windows installation and acceptance"],
    disabled: ["Sage", "automations"], windowsConnected: false }, null, 2) + "\n",
};
for (const name of ["installation.json", "users.json", "restic-password", ".aibrain-owner.json"]) {
  files[name] = await privateFile(path.join(prepared, name));
}
for (const [name, contents] of Object.entries(files)) {
  const handle = await open(path.join(destination, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
}
console.log(JSON.stringify({ destination, revision: manifest.revision, deployed: false,
  externalBackup: false, externalNotifications: false, secretsPrinted: false }));
