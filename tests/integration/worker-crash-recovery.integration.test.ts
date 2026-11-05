import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/chat-contract";
import {
  AppServerRpcRouter,
  FileTransportEventJournal,
  WebSocketAppServerTransport,
} from "@/runtime/transport";
import {
  NodeWebSocketFactory,
  PrivateWorkerGateway,
} from "@/runtime/workers/local-gateway-runtime";
import type { WorkerLaunchContext } from "@/runtime/workers/types";
import { ResourceLockManager } from "@/storage";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { FileTurnProjectionStore } from "@/workbench/turn-projection-store";

vi.mock("server-only", () => ({}));

const INSTALLATION_ID = "qa-company";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const USER_MESSAGE_A = "20000000-0000-4000-8000-000000000001";
const ASSISTANT_MESSAGE_A = "30000000-0000-4000-8000-000000000001";
const USER_MESSAGE_B = "20000000-0000-4000-8000-000000000002";
const ASSISTANT_MESSAGE_B = "30000000-0000-4000-8000-000000000002";
const RUNTIME_THREAD_A = "runtime-thread-a";
const RUNTIME_THREAD_B = "runtime-thread-b";
const RUNTIME_TURN_A = "runtime-turn-a";
const RUNTIME_TURN_B = "runtime-turn-b";

const roots: string[] = [];

function message(id: string, role: "user" | "assistant", content = ""): ChatMessage {
  return {
    id,
    role,
    content,
    createdAt: "2026-08-27T08:00:00.000Z",
    status: role === "user" ? "complete" : "streaming",
    activity: [],
    plan: [],
    approvals: [],
    diff: "",
    attachments: [],
    artifacts: [],
  };
}

async function waitUntil(assertion: () => void | Promise<void>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for recovery state.");
}

function request(requestId: string, runtimeThreadId: string) {
  return {
    method: "thread/read" as const,
    id: requestId,
    params: { threadId: runtimeThreadId, includeTurns: false },
  };
}

describe("worker gateway crash and durable turn recovery", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("survives refresh, reconnect and worker restart without duplicate or cross-thread projections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-worker-crash-recovery-"));
    roots.push(root);
    const usersRoot = path.join(root, "users");
    const userRoot = path.join(usersRoot, USER_ID);
    const runtimeRoot = path.join(userRoot, "runtime");
    const transportAudit = path.join(userRoot, "audit", "transport");
    const workspace = path.join(userRoot, "workspace");
    await Promise.all([
      mkdir(transportAudit, { recursive: true, mode: 0o700 }),
      mkdir(workspace, { recursive: true, mode: 0o700 }),
    ]);
    await chmod(usersRoot, 0o700);
    await chmod(userRoot, 0o700);

    const context: WorkerLaunchContext = {
      installationId: INSTALLATION_ID,
      userId: USER_ID,
      workerId: `worker-${USER_ID}`,
      environment: {
        HOME: path.join(runtimeRoot, "home"),
        CODEX_HOME: path.join(runtimeRoot, "codex-home"),
        XDG_CACHE_HOME: path.join(runtimeRoot, "xdg", "cache"),
        XDG_CONFIG_HOME: path.join(runtimeRoot, "xdg", "config"),
        XDG_DATA_HOME: path.join(runtimeRoot, "xdg", "data"),
        XDG_STATE_HOME: path.join(runtimeRoot, "xdg", "state"),
        TMPDIR: path.join(userRoot, "staging", "tmp"),
      },
      mounts: {
        runtimeReadOnly: [path.join(root, "company"), path.join(root, "source-ro")],
        runtimeReadWrite: [runtimeRoot, workspace, transportAudit],
        browserReadWrite: [path.join(userRoot, "browser")],
      },
      workspace,
      staging: path.join(userRoot, "staging"),
      artifacts: path.join(userRoot, "artifacts"),
      transportAudit,
      browser: {
        profile: path.join(userRoot, "browser", "profile"),
        downloads: path.join(userRoot, "browser", "downloads"),
      },
    };

    const executionLog = path.join(root, "fake-app-server-executions.jsonl");
    const fakeServer = path.join(root, "fake-app-server.mjs");
    await writeFile(fakeServer, [
      'import { appendFileSync } from "node:fs";',
      'import { createInterface } from "node:readline";',
      `const executionLog = ${JSON.stringify(executionLog)};`,
      'const lines = createInterface({ input: process.stdin });',
      'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'lines.on("line", (line) => {',
      '  const request = JSON.parse(line);',
      '  appendFileSync(executionLog, `${JSON.stringify({ id: request.id, method: request.method })}\\n`);',
      '  const isA = request.params?.threadId === "runtime-thread-a";',
      '  const turnId = isA ? "runtime-turn-a" : "runtime-turn-b";',
      '  const itemId = isA ? "agent-a" : "agent-b";',
      '  const delta = request.id === "request-a-initial" ? "A1"',
      '    : request.id === "request-a-crash" ? "A2"',
      '      : request.id === "request-b-refresh" ? "B1" : "B2";',
      '  write({ id: request.id, result: { thread: { id: request.params?.threadId } } });',
      '  write({ method: "item/agentMessage/delta", params: { threadId: request.params?.threadId, turnId, itemId, delta } });',
      '  if (request.id === "request-a-crash" || request.id === "request-b-final") {',
      '    write({ method: "turn/completed", params: {',
      '      threadId: request.params?.threadId,',
      '      turn: { id: turnId, items: [], itemsView: "full", status: "completed", error: null,',
      '        startedAt: 1, completedAt: 2, durationMs: 1000 }',
      '    } });',
      '  }',
      '  if (request.id === "request-a-crash") setTimeout(() => process.exit(41), 25);',
      '});',
    ].join("\n"), { mode: 0o600 });

    const processFactory = () => spawn(process.execPath, [fakeServer], {
      cwd: context.workspace,
      env: { NODE_ENV: "test", ...context.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const createGateway = () => new PrivateWorkerGateway({ context, processFactory });
    const clientJournalPath = path.join(transportAudit, "recovery-client-events.jsonl");
    const createTransport = (gateway: PrivateWorkerGateway) => {
      if (!gateway.endpoint) throw new Error("Gateway did not start.");
      const journal = new FileTransportEventJournal({
        filePath: clientJournalPath,
        lockManager: new ResourceLockManager({
          rootDirectory: path.join(transportAudit, "recovery-client-locks"),
        }),
      });
      const transport = new WebSocketAppServerTransport({
        endpoint: gateway.endpoint,
        socketFactory: new NodeWebSocketFactory(),
        auth: {
          placement: "authorization-header",
          credentialProvider: {
            async getCredential() {
              return { kind: "capability-token" as const, token: gateway.token };
            },
          },
        },
        journal,
        heartbeatIntervalMs: 50,
        heartbeatTimeoutMs: 100,
        readyTimeoutMs: 1_000,
        reconnectBaseDelayMs: 5,
        reconnectMaxDelayMs: 20,
        reconnectJitterRatio: 0,
      });
      return { journal, transport };
    };

    const workbench = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    const project = await workbench.createProject(USER_ID, "Recovery QA");
    const threadA = await workbench.createThread(USER_ID, project.id, "Thread A");
    const threadB = await workbench.createThread(USER_ID, project.id, "Thread B");
    await workbench.beginThreadTurn(
      USER_ID,
      threadA.id,
      message(USER_MESSAGE_A, "user", "Prompt A"),
      message(ASSISTANT_MESSAGE_A, "assistant"),
    );
    await workbench.beginThreadTurn(
      USER_ID,
      threadB.id,
      message(USER_MESSAGE_B, "user", "Prompt B"),
      message(ASSISTANT_MESSAGE_B, "assistant"),
    );
    const projections = new FileTurnProjectionStore({
      installationId: INSTALLATION_ID,
      userId: USER_ID,
      usersRoot,
    });
    await projections.initialize(threadA.id, message(ASSISTANT_MESSAGE_A, "assistant"));
    await projections.initialize(threadB.id, message(ASSISTANT_MESSAGE_B, "assistant"));

    let crashAfterProjection = false;
    let crashObserved = false;
    const replayApplications: boolean[] = [];
    const failures: Error[] = [];
    const registerRoutes = (router: AppServerRpcRouter) => {
      const register = (
        runtimeThreadId: string,
        localThreadId: string,
        assistantMessageId: string,
        runtimeTurnId: string,
      ) => {
        const registration = router.registerTurn(runtimeThreadId, assistantMessageId, {
          async onNotification(notification, envelope) {
            if (notification.method === "item/agentMessage/delta") {
              const result = await projections.applyTransportEvent(
                localThreadId,
                assistantMessageId,
                envelope,
                `delta:${notification.params.itemId}`,
                { type: "delta", value: notification.params.delta },
              );
              if (notification.params.delta === "A2") replayApplications.push(result.applied);
              if (crashAfterProjection && notification.params.delta === "A2") {
                crashAfterProjection = false;
                crashObserved = true;
                throw new Error("Synthetic backend crash after durable projection and before ACK.");
              }
              return;
            }
            if (notification.method === "turn/completed") {
              await projections.applyTransportEvent(
                localThreadId,
                assistantMessageId,
                envelope,
                "turn:done",
                { type: "done" },
              );
            }
          },
          async onServerRequest() {
            return {};
          },
          onFailure(error) {
            failures.push(error);
          },
        });
        registration.bindRuntimeTurn(runtimeTurnId);
      };
      register(RUNTIME_THREAD_A, threadA.id, ASSISTANT_MESSAGE_A, RUNTIME_TURN_A);
      register(RUNTIME_THREAD_B, threadB.id, ASSISTANT_MESSAGE_B, RUNTIME_TURN_B);
    };

    const firstGateway = createGateway();
    await firstGateway.start();
    const firstClient = createTransport(firstGateway);
    const firstRouter = new AppServerRpcRouter(firstClient.transport);
    registerRoutes(firstRouter);
    await firstRouter.request(request("request-a-initial", RUNTIME_THREAD_A));
    await waitUntil(async () => {
      expect((await projections.read(threadA.id, ASSISTANT_MESSAGE_A))?.message.content).toBe("A1");
      expect(await firstClient.journal.readUndelivered(20)).toEqual([]);
    });

    // A browser refresh/backend reconnect creates fresh in-memory queues while
    // preserving the worker, journal cursor and file-backed projection.
    await firstRouter.close();
    await firstClient.transport.close();
    const refreshedWorkbench = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    expect((await refreshedWorkbench.getThread(USER_ID, threadA.id)).messages).toHaveLength(2);
    expect((await refreshedWorkbench.getThread(USER_ID, threadA.id)).messages.at(-1)?.content).toBe("A1");

    const refreshedClient = createTransport(firstGateway);
    const refreshedRouter = new AppServerRpcRouter(refreshedClient.transport);
    registerRoutes(refreshedRouter);
    await refreshedRouter.request(request("request-b-refresh", RUNTIME_THREAD_B));
    await waitUntil(async () => {
      expect((await projections.read(threadB.id, ASSISTANT_MESSAGE_B))?.message.content).toBe("B1");
      expect(await refreshedClient.journal.readUndelivered(20)).toEqual([]);
    });
    expect((await projections.read(threadA.id, ASSISTANT_MESSAGE_A))?.message.content).toBe("A1");

    // The child exits for real after emitting this turn. The projection hook
    // deliberately fails after its atomic write so sequence A2 remains
    // undelivered and must be replayed after the whole gateway restarts.
    crashAfterProjection = true;
    await refreshedRouter.request(request("request-a-crash", RUNTIME_THREAD_A));
    await waitUntil(async () => {
      expect(crashObserved).toBe(true);
      expect((await projections.read(threadA.id, ASSISTANT_MESSAGE_A))?.message.content).toBe("A1A2");
      expect((await firstGateway.health()).state).toBe("failed");
    });
    await refreshedRouter.close();
    await refreshedClient.transport.close();
    await firstGateway.stop();

    const restartedGateway = createGateway();
    await restartedGateway.start();
    const restartedClient = createTransport(restartedGateway);
    const restartedRouter = new AppServerRpcRouter(restartedClient.transport);
    registerRoutes(restartedRouter);
    await restartedRouter.start();
    await waitUntil(async () => {
      const projection = await projections.read(threadA.id, ASSISTANT_MESSAGE_A);
      expect(projection?.message).toMatchObject({ content: "A1A2", status: "complete" });
      expect(await restartedClient.journal.readUndelivered(20)).toEqual([]);
    });
    expect(replayApplications).toEqual([true, false]);

    // Retrying the same logical request after restart returns its persisted
    // response and never executes the new child a second time.
    await restartedRouter.request(request("request-a-crash", RUNTIME_THREAD_A));
    await restartedRouter.request(request("request-b-final", RUNTIME_THREAD_B));
    await waitUntil(async () => {
      const projection = await projections.read(threadB.id, ASSISTANT_MESSAGE_B);
      expect(projection?.message).toMatchObject({ content: "B1B2", status: "complete" });
      expect(await restartedClient.journal.readUndelivered(20)).toEqual([]);
    });

    const executions = (await readFile(executionLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string });
    expect(executions.filter((entry) => entry.id === "request-a-crash")).toHaveLength(1);

    const finalWorkbench = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    const [finalA, finalB] = await Promise.all([
      finalWorkbench.getThread(USER_ID, threadA.id),
      finalWorkbench.getThread(USER_ID, threadB.id),
    ]);
    expect(finalA.messages).toHaveLength(2);
    expect(finalB.messages).toHaveLength(2);
    expect(finalA.messages.at(-1)).toMatchObject({
      id: ASSISTANT_MESSAGE_A,
      content: "A1A2",
      status: "complete",
    });
    expect(finalB.messages.at(-1)).toMatchObject({
      id: ASSISTANT_MESSAGE_B,
      content: "B1B2",
      status: "complete",
    });
    expect(finalA.messages.at(-1)?.content).not.toContain("B");
    expect(finalB.messages.at(-1)?.content).not.toContain("A");
    expect(failures.some((error) => error.message.includes("Synthetic backend crash"))).toBe(true);

    await restartedRouter.close();
    await restartedClient.transport.close();
    await restartedGateway.stop();
  }, 20_000);
});
