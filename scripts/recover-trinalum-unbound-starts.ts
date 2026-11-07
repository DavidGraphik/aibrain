import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { loadInstallationConfig } from "../src/config/installation";
import { readRegularFileWithin } from "../src/security/safe-file";
import { FileTurnProjectionStore, isUnboundTurnBefore, type TurnProjection } from "../src/workbench/turn-projection-store";
import { FileWorkbenchStore } from "../src/workbench/filesystem-store";
import { isUuid, type WorkbenchThread } from "../src/workbench/types";
import { isUnboundAutomationThread } from "../src/operations/unbound-automation-recovery";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "ddfb21cc-55a2-4007-bbc3-f9d61429837a";
const prefix = "Análisis interno programado autorizado de Trinalum. Analiza únicamente los datos suministrados. No escribas en Attio, Sibema ni correo, no envíes mensajes ni utilices herramientas de comandos o archivos.";
const jobs = new Set(["email-event-router", "sibema-event-router", "provider-response-watchdog", "client-response-watchdog", "missing-invoice-watchdog", "weekly-trini-summary", "monday-delivery-summary"]);
type Candidate = { threadId: string; assistantId: string; threadDigest: string; projectionDigest: string };
type Plan = { schemaVersion: 1; installationId: string; userId: string; projectId: string; restartedAt: string; candidates: Candidate[] };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesDigest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function isScopedThread(thread: WorkbenchThread, restartedAt: string) {
  return isUnboundAutomationThread(thread, { projectId, jobs, prefix, restartedAt });
}

async function main() {
  const args = process.argv.slice(2);
  const applyIndex = args.indexOf("--apply-plan");
  const outputIndex = args.indexOf("--output-dir");
  const restartIndex = args.indexOf("--restarted-at");
  if (!(applyIndex === 0 && args.length === 2) &&
      !(outputIndex === 0 && restartIndex === 2 && args.length === 4)) {
    throw Error("Use --output-dir /private/new-directory --restarted-at verified-container-start-time, then --apply-plan /private/directory/plan.json");
  }
  const config = await loadInstallationConfig();
  if (config.installationId !== "trinalum-production") throw Error("TRINALUM_INSTALLATION_REQUIRED");
  const allowedRoot = path.join(config.paths.dataRoot, "qa", "repair-20261011", "orphan-recovery");
  const directory = path.resolve(applyIndex === 0 ? path.dirname(args[1]) : args[1]);
  const relative = path.relative(allowedRoot, directory);
  if (!/^[a-z0-9-]{1,80}$/.test(relative) || await realpath(allowedRoot) !== allowedRoot) throw Error("PRIVATE_RECEIPT_DIRECTORY_REQUIRED");
  if (applyIndex === 0 && (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())) throw Error("PRIVATE_RECEIPT_DIRECTORY_REQUIRED");
  const userRoot = path.join(config.paths.usersRoot, userId);
  const workbench = FileWorkbenchStore.fromInstallation(config);
  const readState = async () => {
    // Export the fully hydrated durable state, including runtime tokens. A v2
    // head alone is not a backup; this v1 JSON is a complete logical export.
    const state = await workbench.readExistingDurableStateForMaintenance(userId);
    if (!state) throw Error("EXISTING_WORKBENCH_REQUIRED");
    const bytes = Buffer.from(JSON.stringify(state));
    if (state.installationId !== config.installationId || state.userId !== userId ||
        !state.projects.some(project => project.id === projectId && project.sharing.visibility === "private")) throw Error("PRIVATE_OPERATOR_PROJECT_REQUIRED");
    return { state, bytes };
  };
  const projections = new FileTurnProjectionStore({ installationId: config.installationId, userId, usersRoot: config.paths.usersRoot });
  if (applyIndex !== 0) {
    const restartedAt = args[3];
    if (!Number.isFinite(Date.parse(restartedAt)) || Date.parse(restartedAt) > Date.now()) throw Error("VERIFIED_RESTART_REQUIRED");
    const { state, bytes } = await readState();
    const candidates: Candidate[] = [];
    for (const thread of state.threads) {
      if (!isScopedThread(thread, restartedAt)) continue;
      const assistantId = thread.messages[1].id;
      const projection = await projections.read(thread.id, assistantId);
      if (!projection || !isUnboundTurnBefore(projection, restartedAt, "fuentes-programadas.txt")) continue;
      candidates.push({ threadId: thread.id, assistantId, threadDigest: digest(thread), projectionDigest: digest(projection) });
    }
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, "workbench-before-private.json"), bytes, { mode: 0o600, flag: "wx" });
    const plan: Plan = { schemaVersion: 1, installationId: config.installationId, userId, projectId, restartedAt, candidates };
    await writeFile(path.join(directory, "plan.json"), JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" });
    process.stdout.write(JSON.stringify({ mode: "plan", candidates: candidates.length, workbenchBackupSha256: bytesDigest(bytes) }) + "\n");
    return;
  }
  if (path.resolve(args[1]) !== path.join(directory, "plan.json")) throw Error("EXACT_PLAN_REQUIRED");
  const plan = JSON.parse((await readRegularFileWithin(directory, "plan.json", 1024 * 1024)).toString()) as Plan;
  if (plan.schemaVersion !== 1 || plan.installationId !== config.installationId || plan.userId !== userId || plan.projectId !== projectId ||
      !Array.isArray(plan.candidates) || plan.candidates.length > 1000 ||
      new Set(plan.candidates.map(row => row.threadId)).size !== plan.candidates.length ||
      !Number.isFinite(Date.parse(plan.restartedAt)) || Date.parse(plan.restartedAt) > Date.now()) throw Error("RECOVERY_PLAN_INVALID");
  await writeFile(path.join(directory, "apply-started-private.json"), JSON.stringify({ startedAt: new Date().toISOString(), planSha256: digest(plan) }), { mode: 0o600, flag: "wx" });
  for (const candidate of plan.candidates) {
    if (!isUuid(candidate.threadId) || !isUuid(candidate.assistantId)) throw Error("RECOVERY_ID_INVALID");
    const { state } = await readState();
    const thread = state.threads.find(thread => thread.id === candidate.threadId);
    if (!thread || !isScopedThread(thread, plan.restartedAt) || digest(thread) !== candidate.threadDigest || thread.messages[1].id !== candidate.assistantId) throw Error("RECOVERY_THREAD_CHANGED");
    const relativeProjection = `state/turn-projections/${candidate.threadId}/${candidate.assistantId}.json`;
    const original = await readRegularFileWithin(userRoot, relativeProjection, 64 * 1024 * 1024);
    const parsed = JSON.parse(original.toString()) as TurnProjection;
    if (digest(parsed) !== candidate.projectionDigest) throw Error("RECOVERY_PROJECTION_CHANGED");
    const backupFile = `${candidate.threadId}-${candidate.assistantId}-before-private.json`;
    await writeFile(path.join(directory, backupFile), original, { mode: 0o600, flag: "wx" });
    if (bytesDigest(await readFile(path.join(directory, backupFile))) !== bytesDigest(original)) throw Error("RECOVERY_BACKUP_MISMATCH");
    const recovered = await projections.stopUnboundTurnBefore(candidate.threadId, candidate.assistantId, {
      restartedAt: plan.restartedAt, expectedDigest: candidate.projectionDigest, preparedSourceName: "fuentes-programadas.txt",
    });
    await workbench.finishThreadTurn(userId, candidate.threadId, recovered.message, null);
    const after = await projections.read(candidate.threadId, candidate.assistantId);
    if (after?.message.status !== "stopped") throw Error("RECOVERY_READBACK_FAILED");
    await appendFile(path.join(directory, "receipts-private.jsonl"), JSON.stringify({ ...candidate, backupSha256: bytesDigest(original), recoveredDigest: digest(after), status: "stopped", recoveredAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify({ mode: "apply", stopped: plan.candidates.length, completed: 0, providerActions: 0 }) + "\n");
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "RECOVERY_FAILED"}\n`);
  process.exitCode = 1;
});
