import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import { loadInstallationConfig } from "@/config/installation";
import { UserProvisioner } from "@/users/provisioner";
import { WORKBENCH_HISTORY_MIGRATION_ENABLED } from "@/workbench/history-format-policy";
import { WORKBENCH_FILE_LIMIT } from "@/workbench/segmented-history";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { FileAutomationStore } from "@/automations/store";
import { FileAutomationAudienceStore } from "@/automations/audience-store";
import { executeScheduledTurn } from "@/automations/executor";
import { getThreadRuntimeContext, prepareThreadTurn } from "@/workbench/store";
import { listAtomicTemporaryFiles } from "@/storage/atomic-file";
import type { AuthSession } from "@/auth/types";

const root = path.resolve(process.argv[3]);
const configPath = path.join(root, "installation.json");
const userId = "00000000-0000-4000-8000-000000000011";
const installationId = "heap-fixture";
const session: AuthSession = {
  provider: "local",
  user: { id: userId, email: "owner@example.test", name: "Owner" },
  tenant: { id: installationId, name: "Heap fixture" },
  expiresAt: "2030-01-01T00:00:00.000Z",
};
process.env.AIBRAIN_INSTALLATION_CONFIG = configPath;
process.env.CHAT_RUNTIME = "codex";
process.env.AIBRAIN_ADMIN_USER_IDS = userId;
process.env.AIBRAIN_HEAP_FIXTURE = "1";
const targetBytes = Number(process.env.AIBRAIN_HEAP_FIXTURE_BYTES ?? 62_627_367);
assert(Number.isSafeInteger(targetBytes) && targetBytes >= 16 * 1024 * 1024 && targetBytes <= 62_627_367);
function report(stage: string) {
  console.log(JSON.stringify({ stage, heapLimit: getHeapStatistics().heap_size_limit, maxRssKiB: process.resourceUsage().maxRSS, ...process.memoryUsage() }));
}
async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

if (process.argv[2] === "setup") {
  const dataRoot = path.join(root, "data");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1, installationId, companyName: "Heap fixture", companySlug: installationId,
    publicUrl: "http://localhost:3000",
    branding: { productName: "AiBrain", logoPath: "/logo.svg", faviconPath: "/favicon.ico", accentColor: "#111111" },
    paths: { dataRoot, usersRoot: path.join(dataRoot, "users"), companyContextRoot: path.join(dataRoot, "company"),
      sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(dataRoot, "backups") },
  }));
  const installation = await loadInstallationConfig();
  await new UserProvisioner(installation).provision({ userId, email: session.user.email, displayName: "Owner" });
  const store = FileWorkbenchStore.fromInstallation(installation);
  await store.load(userId);
  const project = await store.createProject(userId, "Heap fixture");
  const thread = await store.createThread(userId, project.id, "Programada · Heap fixture");
  const taskStore = new FileAutomationStore({ installationId, usersRoot: installation.paths.usersRoot, userId });
  const task = await taskStore.create({ name: "Heap fixture", prompt: "Return synthetic result.", projectId: project.id,
    projectName: project.name, timeZone: "Europe/Madrid", schedule: { kind: "once", runAt: "2030-08-30T09:00:00.000Z" } });
  const runKey = `${task.id}:2030-08-30T09:00:00.000Z`;
  await new FileAutomationAudienceStore({ installationId, dataRoot }).record({ runKey, taskId: task.id, ownerUserId: userId,
    projectId: project.id, threadId: thread.id });
  await writeFile(path.join(root, "receipt.json"), JSON.stringify({ task, runKey, threadId: thread.id }));
  const statePath = path.join(installation.paths.usersRoot, userId, "state", "workbench.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const handle = await open(statePath, "w", 0o600);
  let bytes = 0;
  const write = async (text: string) => { await handle.writeFile(text); bytes += Buffer.byteLength(text); };
  const blockFor = (value: unknown) => JSON.stringify(value, null, 2).replace(/^/gm, "    ");
  await write(`${JSON.stringify({ ...state, threads: undefined }, null, 2).slice(0, -2)},\n  "threads": [\n${blockFor({ ...thread, runtimeThreadToken: null })}`);
  let count = 0;
  while (bytes < targetBytes - 7) {
    const message = { id: randomUUID(), role: "assistant", content: `Synthetic summary — € ${"Synthetic history ".repeat(5800)}`,
      createdAt: thread.createdAt, status: "complete", activity: [],
      plan: [],
      approvals: [], diff: "", attachments: [], artifacts: [], sources: [], toolResults: [] };
    const historical = { ...thread, id: randomUUID(), title: "Synthetic historical conversation",
      messages: [message], runtimeThreadToken: null };
    let block = `,\n${blockFor(historical)}`;
    if (bytes >= targetBytes - 200_000) {
      historical.messages[0].content = "";
      const overhead = Buffer.byteLength(`,\n${blockFor(historical)}`);
      historical.messages[0].content = "x".repeat(targetBytes - 7 - bytes - overhead);
      block = `,\n${blockFor(historical)}`;
    }
    await write(block);
    count++;
  }
  await write("\n  ]\n}\n");
  await handle.close();
  assert.equal((await stat(statePath)).size, targetBytes);
  const receiptPath = path.join(root, "receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, legacyStateDigest: await digest(statePath) }));
  console.log(JSON.stringify({ targetBytes, historicalThreads: count }));
} else {
  const { task, runKey, threadId, legacyStateDigest } = JSON.parse(await readFile(path.join(root, "receipt.json"), "utf8"));
  const installation = await loadInstallationConfig();
  report("start");
  if (process.argv[2] === "access-burst") {
    const concurrency = Number(process.env.AIBRAIN_HEAP_FIXTURE_CONCURRENCY ?? 8);
    assert(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 8);
    const snapshots = await Promise.all(Array.from({ length: concurrency }, () => FileWorkbenchStore.fromInstallation(installation).loadAccessSnapshot(userId)));
    assert(snapshots.every(snapshot => snapshot.threads.every(thread => thread.messages.length === 0)));
    assert(snapshots.every(snapshot => snapshot.projects.some(project => project.id === task.projectId)));
    assert.equal(await digest(path.join(installation.paths.usersRoot, userId, "state", "workbench.json")), legacyStateDigest);
    report("access-burst-complete");
  } else if (process.argv[2] === "runtime") {
    const context = await getThreadRuntimeContext(session, threadId);
    assert.equal(context.projectId, task.projectId);
    assert(context.visibleProjects.some(({ id }) => id === task.projectId));
    report("runtime-context");
  } else if (process.argv[2] === "prepare") {
    const prepared = await prepareThreadTurn(session, threadId);
    assert.equal(prepared.context.projectId, task.projectId);
    assert.equal(prepared.rebootstrapHistory, null);
    report("prepared-turn");
  } else {
    // Enter through the real runner boundary: the state store requires a
    // current fenced claim, including when inference itself is synthetic.
    const taskStore = new FileAutomationStore({ installationId, usersRoot: installation.paths.usersRoot, userId });
    await taskStore.runNow(task.id, randomUUID());
    const claims = await taskStore.claimDue("heap-fixture-worker", 1);
    assert.equal(claims.length, 1);
    const claim = claims[0];
    assert.equal(claim.task.id, task.id);
    assert(claim.task.lease?.fenceToken);
    const newRunKey = claim.runKey;
    const result = await executeScheduledTurn({ installation, session, task: claim.task, runKey: newRunKey });
    assert(result.threadId);
    report("scheduled-turn");
    const recovered = await executeScheduledTurn({ installation, session, task: claim.task, runKey: newRunKey, existingThreadId: result.threadId });
    assert.equal(recovered.threadId, result.threadId);
    const persisted = await FileWorkbenchStore.fromInstallation(installation).getThread(userId, result.threadId);
    assert.equal(persisted.messages.length, 2);
    assert.equal(persisted.messages[0].content, task.prompt);
    assert.equal(persisted.messages[1].content, "SYNTHETIC-HEAP-OK");
    assert.equal(persisted.messages[1].status, "complete");
    assert.equal((globalThis as typeof globalThis & { __aibrainHeapInferenceCalls?: number }).__aibrainHeapInferenceCalls, 1);
    report("recovered-turn");
    const stateFile = path.join(installation.paths.usersRoot, userId, "state", "workbench.json");
    const before = await digest(stateFile);
    if (WORKBENCH_HISTORY_MIGRATION_ENABLED) {
      // Aggregate history may now exceed the old single-file ceiling, while
      // every head/object remains bounded and the complete v1 is preserved.
      await FileWorkbenchStore.fromInstallation(installation).finishThreadTurn(userId, result.threadId,
        { ...persisted.messages[1], content: "x".repeat(5 * 1024 * 1024) }, null);
      const head = JSON.parse(await readFile(stateFile, "utf8"));
      assert.equal(head.schemaVersion, 2);
      assert((await stat(stateFile)).size < WORKBENCH_FILE_LIMIT);
      for (const ref of head.histories as Array<{ digest: string; bytes: number }>) {
        assert(ref.bytes <= WORKBENCH_FILE_LIMIT);
        const objectFile = path.join(path.dirname(stateFile), "workbench-history", `${ref.digest}.json`);
        assert.equal((await stat(objectFile)).size, ref.bytes);
        assert.equal(await digest(objectFile), ref.digest);
      }
      const updated = await FileWorkbenchStore.fromInstallation(installation).getThread(userId, result.threadId);
      assert.equal(updated.messages[1].content.length, 5 * 1024 * 1024);
      assert.equal((await stat(stateFile + ".v1-preserved.json")).size, targetBytes);
      assert.equal(await digest(stateFile + ".v1-preserved.json"), legacyStateDigest);
    } else {
      await assert.rejects(FileWorkbenchStore.fromInstallation(installation).finishThreadTurn(userId, result.threadId,
        { ...persisted.messages[1], content: "x".repeat(5 * 1024 * 1024) }, null), /límit operatiu segur/);
      assert.equal(await digest(stateFile), before);
    }
    assert.deepEqual(await listAtomicTemporaryFiles(stateFile), []);
    report("write-limit-preserved");
  }
}
