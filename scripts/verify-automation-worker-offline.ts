import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AUTOMATION_EXECUTION_CONTEXT, type AutomationTaskInput } from "../src/automations/contracts";
import { FileAutomationProposalStore } from "../src/automations/chat-proposal-store";
import { runAutomationSweep } from "../src/automations/runner";
import { FileAutomationStore } from "../src/automations/store";
import type { ChatMessage } from "../src/lib/chat-contract";
import { FileWorkbenchStore } from "../src/workbench/filesystem-store";

const INSTALLATION_ID = "automation-offline-acceptance";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const RESULT_THREAD_ID = "20000000-0000-4000-8000-000000000001";
const SOURCE_THREAD_ID = "30000000-0000-4000-8000-000000000001";
const PROPOSAL_TURN_ID = "40000000-0000-4000-8000-000000000001";
const CONFIRMATION_TURN_ID = "40000000-0000-4000-8000-000000000002";
const RESULT_USER_MESSAGE_ID = "50000000-0000-4000-8000-000000000001";
const RESULT_ASSISTANT_MESSAGE_ID = "50000000-0000-4000-8000-000000000002";
const EXPECTED_RESULT = "TEST-AUTO-P0-OK";
const MIN_DELAY_MS = 120_000;
const MAX_DELAY_MS = 180_000;
const scriptPath = fileURLToPath(import.meta.url);
const serverOnlyStubPath = fileURLToPath(new URL("./register-server-only-stub.mjs", import.meta.url));

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string) {
  const value = argument(name);
  if (!value) throw new Error(`Falta ${name}.`);
  return value;
}

function store(usersRoot: string) {
  return new FileAutomationStore({ installationId: INSTALLATION_ID, userId: USER_ID, usersRoot });
}

function chatMessage(id: string, role: ChatMessage["role"], content: string, status: ChatMessage["status"]): ChatMessage {
  return {
    id, role, content, status, createdAt: new Date().toISOString(), activity: [], plan: [], approvals: [],
    diff: "", attachments: [], artifacts: [], sources: [], toolResults: [],
  };
}

async function worker() {
  const usersRoot = path.resolve(requiredArgument("--users-root"));
  if (process.argv.includes("--expect-no-replay")) {
    const output = await runAutomationSweep({
      store: store(usersRoot),
      ownerId: `offline-replay-${process.pid}`,
      maxAttempts: 1,
      execute: async () => { throw new Error("Una ejecución terminal nunca debe repetirse."); },
    });
    if (output.length !== 0) throw new Error("Un segundo worker encontró una ejecución repetible.");
    process.stdout.write(`${JSON.stringify({ worker: "no-replay", replayExecutions: 0, processId: process.pid })}\n`);
    return;
  }
  const receiptPath = path.resolve(requiredArgument("--receipt"));
  const deadline = Number(requiredArgument("--deadline"));
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error("El deadline del worker no es válido.");
  const automationStore = store(usersRoot);
  while (Date.now() <= deadline) {
    const output = await runAutomationSweep({
      store: automationStore,
      ownerId: `offline-acceptance-${process.pid}`,
      maxAttempts: 1,
      execute: async (claim, existingThreadId, onThreadPrepared) => {
        const workbench = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
        const threadId = existingThreadId ?? RESULT_THREAD_ID;
        await workbench.createThread(USER_ID, claim.task.projectId, `Programada · ${claim.task.name}`, threadId);
        await onThreadPrepared(threadId);
        const userMessage = chatMessage(RESULT_USER_MESSAGE_ID, "user", claim.task.prompt, "complete");
        const pending = chatMessage(RESULT_ASSISTANT_MESSAGE_ID, "assistant", "", "streaming");
        const begun = await workbench.beginThreadTurn(USER_ID, threadId, userMessage, pending, { retryExistingFailure: true });
        const completed = { ...begun.assistantMessage, content: EXPECTED_RESULT, status: "complete" as const };
        await workbench.finishThreadTurn(USER_ID, threadId, completed, null);
        await mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
        const descriptor = await open(receiptPath, "wx", 0o600);
        try {
          await descriptor.writeFile(`${JSON.stringify({
            schemaVersion: 1,
            runKey: claim.runKey,
            prompt: claim.task.prompt,
            result: EXPECTED_RESULT,
            threadId,
            executedAt: new Date().toISOString(),
            processId: process.pid,
          })}\n`, "utf8");
          await descriptor.sync();
        } finally {
          await descriptor.close();
        }
        return { threadId };
      },
    });
    if (output.some((item) => item.status === "succeeded")) {
      process.stdout.write(`${JSON.stringify({ worker: "completed", output })}\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("La automatización no se ejecutó dentro de la ventana controlada.");
}

async function orchestrate() {
  const delayMs = Number(argument("--delay-ms") ?? MIN_DELAY_MS);
  if (!Number.isSafeInteger(delayMs) || delayMs < MIN_DELAY_MS || delayMs > MAX_DELAY_MS) {
    throw new Error(`--delay-ms debe estar entre ${MIN_DELAY_MS} y ${MAX_DELAY_MS}.`);
  }
  const acceptanceRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-automation-offline-"));
  const usersRoot = path.join(acceptanceRoot, "users");
  const receiptPath = path.join(acceptanceRoot, "controlling-store", "hello.json");
  const automationStore = store(usersRoot);
  const scheduledFor = new Date(Date.now() + delayMs).toISOString();
  const startedAt = Date.now();
  try {
    await mkdir(path.join(usersRoot, USER_ID), { recursive: true, mode: 0o700 });
    const workbench = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    const project = await workbench.createProject(USER_ID, "Offline acceptance");
    const input: AutomationTaskInput = {
      name: "Hello offline acceptance",
      prompt: `hello: responde exactamente ${EXPECTED_RESULT}`,
      projectId: project.id,
      projectName: project.name,
      timeZone: "Europe/Madrid",
      schedule: { kind: "once", runAt: scheduledFor },
      executionContext: DEFAULT_AUTOMATION_EXECUTION_CONTEXT,
      audience: { membershipPolicy: "current", userIds: [USER_ID], groupIds: [] },
    };
    const proposalStore = new FileAutomationProposalStore({ installationId: INSTALLATION_ID, userId: USER_ID, usersRoot });
    const proposal = await proposalStore.propose(input, {
      sourceThreadId: SOURCE_THREAD_ID,
      sourceTurnId: PROPOSAL_TURN_ID,
      callId: "offline-acceptance-propose",
    });
    const restartedProposalStore = new FileAutomationProposalStore({ installationId: INSTALLATION_ID, userId: USER_ID, usersRoot });
    const confirmed = await restartedProposalStore.confirm(proposal.id, {
      sourceThreadId: SOURCE_THREAD_ID,
      currentTurnId: CONFIRMATION_TURN_ID,
      currentMessage: "Sí, confírmala",
    }, async (item) => {
      await automationStore.create(item.input, { id: item.taskId });
    });
    const task = await automationStore.get(confirmed.taskId);
    process.stdout.write(`${JSON.stringify({
      chatProposal: "confirmed",
      client: "absent-before-worker-start",
      browserRequired: false,
      taskId: task.id,
      scheduledFor,
    })}\n`);

    const child = spawn(process.execPath, [
      "--import", serverOnlyStubPath,
      "--import", "tsx",
      scriptPath,
      "--worker",
      "--users-root", usersRoot,
      "--receipt", receiptPath,
      "--deadline", String(new Date(scheduledFor).getTime() + 30_000),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (exitCode !== 0) throw new Error(stderr.trim() || `El worker terminó con código ${exitCode}.`);

    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      runKey: string;
      prompt: string;
      result: string;
      threadId: string;
      executedAt: string;
    };
    const runs = await automationStore.listRuns(task.id);
    const resultThread = await new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot })
      .getThread(USER_ID, receipt.threadId);
    const persistedPrompt = resultThread.messages.find(({ id }) => id === RESULT_USER_MESSAGE_ID);
    const persistedResult = resultThread.messages.find(({ id }) => id === RESULT_ASSISTANT_MESSAGE_ID);
    const replayChild = spawn(process.execPath, [
      "--import", serverOnlyStubPath,
      "--import", "tsx",
      scriptPath,
      "--worker",
      "--expect-no-replay",
      "--users-root", usersRoot,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let replayStdout = "";
    let replayStderr = "";
    replayChild.stdout.on("data", (chunk) => { replayStdout += String(chunk); });
    replayChild.stderr.on("data", (chunk) => { replayStderr += String(chunk); });
    const replayExitCode = await new Promise<number | null>((resolve, reject) => {
      replayChild.once("error", reject);
      replayChild.once("exit", resolve);
    });
    if (replayExitCode !== 0) throw new Error(replayStderr.trim() || `El worker de replay terminó con código ${replayExitCode}.`);
    const replayEvidence = JSON.parse(replayStdout.trim()) as { replayExecutions: number; processId: number };
    const terminal = runs.filter((run) => run.status === "succeeded");
    const executionDelayMs = new Date(receipt.executedAt).getTime() - new Date(scheduledFor).getTime();
    if (receipt.prompt !== input.prompt || receipt.result !== EXPECTED_RESULT || receipt.threadId !== RESULT_THREAD_ID ||
        persistedPrompt?.role !== "user" || persistedPrompt.content !== input.prompt ||
        persistedResult?.role !== "assistant" || persistedResult.status !== "complete" || persistedResult.content !== EXPECTED_RESULT ||
        terminal.length !== 1 || terminal[0]?.threadId !== RESULT_THREAD_ID || replayEvidence.replayExecutions !== 0 ||
        receipt.runKey !== terminal[0]?.runKey || executionDelayMs < 0 || executionDelayMs > 10_000) {
      throw new Error("La evidencia exactly-once o de temporización no coincide con la tarea.");
    }
    process.stdout.write(stdout);
    process.stdout.write(`${JSON.stringify({
      accepted: true,
      clientSessionPresent: false,
      browserRequired: false,
      chatProposalConfirmed: true,
      scheduledDelayMs: delayMs,
      executionDelayMs,
      runKey: receipt.runKey,
      terminalExecutions: terminal.length,
      replayExecutions: replayEvidence.replayExecutions,
      workerProcessId: child.pid,
      replayWorkerProcessId: replayEvidence.processId,
      resultThreadId: receipt.threadId,
      resultContent: receipt.result,
      persistedPrompt: persistedPrompt.content,
      persistedResult: persistedResult.content,
      historyStatuses: runs.map((run) => run.status),
      elapsedMs: Date.now() - startedAt,
    })}\n`);
  } finally {
    await rm(acceptanceRoot, { recursive: true, force: true });
  }
}

void (process.argv.includes("--worker") ? worker() : orchestrate()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "La aceptación offline ha fallado."}\n`);
  process.exitCode = 1;
});
