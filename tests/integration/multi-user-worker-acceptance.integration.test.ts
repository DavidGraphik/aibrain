import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientRequest } from "../../contracts/codex/0.162.1/types/ClientRequest";
import {
  AppServerRpcRouter,
  FileTransportEventJournal,
  WebSocketAppServerTransport,
  type AppServerEvent,
} from "@/runtime/transport";
import {
  NodeWebSocketFactory,
  PrivateWorkerGateway,
} from "@/runtime/workers/local-gateway-runtime";
import type { WorkerLaunchContext } from "@/runtime/workers/types";
import { ResourceLockManager } from "@/storage";

vi.mock("server-only", () => ({}));

const INSTALLATION_ID = "multi-user-qa";
const USER_1 = "10000000-0000-4000-8000-000000000001";
const USER_2 = "10000000-0000-4000-8000-000000000002";
const roots: string[] = [];
const gateways = new Set<PrivateWorkerGateway>();
const transports = new Set<WebSocketAppServerTransport>();
const routers = new Set<AppServerRpcRouter>();

async function waitUntil(assertion: () => void | Promise<void>, timeoutMs = 4_000) {
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
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for multi-user acceptance state.");
}

async function workerContext(root: string, userId: string): Promise<WorkerLaunchContext> {
  const usersRoot = path.join(root, "users");
  const userRoot = path.join(usersRoot, userId);
  const runtimeRoot = path.join(userRoot, "runtime");
  const workspace = path.join(userRoot, "workspace");
  const transportAudit = path.join(userRoot, "audit", "transport");
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(transportAudit, { recursive: true, mode: 0o700 }),
    mkdir(path.join(userRoot, "staging", "tmp"), { recursive: true, mode: 0o700 }),
  ]);
  await chmod(usersRoot, 0o700);
  await chmod(userRoot, 0o700);
  return {
    installationId: INSTALLATION_ID,
    userId,
    workerId: `worker-${userId}`,
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
}

async function fakeAppServer(root: string, label: string) {
  const executionLog = path.join(root, `${label}-executions.jsonl`);
  const script = path.join(root, `${label}-app-server.mjs`);
  await writeFile(script, [
    'import { appendFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    `const label = ${JSON.stringify(label)};`,
    `const executionLog = ${JSON.stringify(executionLog)};`,
    'const lines = createInterface({ input: process.stdin });',
    'const serverRequestScopes = new Map();',
    'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
    'lines.on("line", (line) => {',
    '  const rpc = JSON.parse(line);',
    '  appendFileSync(executionLog, `${JSON.stringify(rpc)}\\n`);',
    '  if (!rpc.method) {',
    '    const scope = serverRequestScopes.get(rpc.id);',
    '    if (scope) write({ method: "item/agentMessage/delta", params: { ...scope, itemId: `approval-${label}`, delta: `${label}:${scope.threadId}:approval-processed` } });',
    '    return;',
    '  }',
    '  const threadId = rpc.params?.threadId;',
    '  const turnId = rpc.params?.turnId || `turn-${threadId}`;',
    '  if (rpc.method === "turn/interrupt") {',
    '    write({ id: rpc.id, result: {} });',
    '    write({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: `stop-${label}`, delta: `${label}:${threadId}:interrupt-confirmed` } });',
    '    write({ method: "item/agentMessage/delta", params: { threadId: `runtime-${label}-stream`, turnId: `turn-runtime-${label}-stream`, itemId: `stream-${label}`, delta: `${label}:stream-after-stop` } });',
    '    return;',
    '  }',
    '  write({ id: rpc.id, result: { thread: { id: threadId } } });',
    '  if (rpc.id === "u1-approval-start") {',
    '    serverRequestScopes.set("approval-u1", { threadId, turnId });',
    '    write({ method: "item/commandExecution/requestApproval", id: "approval-u1", params: { threadId, turnId, itemId: "command-u1", startedAtMs: 1, environmentId: null, command: "pwd" } });',
    '  }',
    '  write({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: `agent-${label}`, delta: `${label}:${threadId}:${rpc.id}` } });',
    '  if (rpc.id === "u1-crash") setTimeout(() => process.exit(41), 30);',
    '});',
  ].join("\n"), { mode: 0o600 });
  return { executionLog, script };
}

function request(id: string, threadId: string): ClientRequest {
  return { method: "thread/read", id, params: { threadId, includeTurns: false } };
}

async function runtime(
  context: WorkerLaunchContext,
  script: string,
  clientJournalName: string,
) {
  const gateway = new PrivateWorkerGateway({
    context,
    processFactory: () => spawn(process.execPath, [script], {
      cwd: context.workspace,
      env: { NODE_ENV: "test", ...context.environment },
      stdio: ["pipe", "pipe", "pipe"],
    }),
  });
  gateways.add(gateway);
  await gateway.start();
  if (!gateway.endpoint) throw new Error("Gateway did not expose a private endpoint.");
  const journal = new FileTransportEventJournal({
    filePath: path.join(context.transportAudit, clientJournalName),
    lockManager: new ResourceLockManager({
      rootDirectory: path.join(context.transportAudit, `${clientJournalName}.locks`),
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
  transports.add(transport);
  const router = new AppServerRpcRouter(transport);
  routers.add(router);
  return { gateway, journal, router, transport };
}

afterEach(async () => {
  await Promise.all([...routers].map((router) => router.close().catch(() => undefined)));
  await Promise.all([...transports].map((transport) => transport.close().catch(() => undefined)));
  await Promise.all([...gateways].map((gateway) => gateway.stop().catch(() => undefined)));
  routers.clear();
  transports.clear();
  gateways.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("multi-user private worker acceptance", () => {
  it("keeps four turns isolated through approval, stop, crash, replay and restart", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "aibrain-multi-user-worker-")));
    roots.push(root);
    const [context1, context2, server1, server2] = await Promise.all([
      workerContext(root, USER_1),
      workerContext(root, USER_2),
      fakeAppServer(root, "u1"),
      fakeAppServer(root, "u2"),
    ]);
    const [user1, user2] = await Promise.all([
      runtime(context1, server1.script, "acceptance-client.jsonl"),
      runtime(context2, server2.script, "acceptance-client.jsonl"),
    ]);
    expect(user1.gateway.token).not.toBe(user2.gateway.token);
    expect(user1.gateway.endpoint).not.toBe(user2.gateway.endpoint);

    const values = new Map<string, string[]>();
    const delivered = new Set<string>();
    const deliveryAttempts = new Map<string, number>();
    let crashEventId: string | null = null;
    let approvalSeen = false;
    let approvalResolved = false;
    let releaseApproval!: () => void;
    const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
    let failCrashDelivery = true;

    const register = (
      router: AppServerRpcRouter,
      threadId: string,
      allowApproval: boolean,
    ) => {
      const registration = router.registerTurn(threadId, `local-${threadId}`, {
        async onNotification(notification, event: AppServerEvent) {
          if (notification.method !== "item/agentMessage/delta") return;
          deliveryAttempts.set(event.eventId, (deliveryAttempts.get(event.eventId) ?? 0) + 1);
          if (!delivered.has(event.eventId)) {
            delivered.add(event.eventId);
            const current = values.get(threadId) ?? [];
            current.push(notification.params.delta);
            values.set(threadId, current);
          }
          if (notification.params.delta.endsWith(":u1-crash") && failCrashDelivery) {
            crashEventId = event.eventId;
            failCrashDelivery = false;
            throw new Error("Synthetic projection crash before transport ACK.");
          }
        },
        async onServerRequest(serverRequest) {
          if (!allowApproval || serverRequest.method !== "item/commandExecution/requestApproval") {
            throw new Error("Approval escaped its owning user/thread/turn.");
          }
          approvalSeen = true;
          await approvalGate;
          approvalResolved = true;
          return { decision: "accept" };
        },
        onFailure() {},
      });
      registration.bindRuntimeTurn(`turn-${threadId}`);
    };

    const registerAll = (router1: AppServerRpcRouter, router2: AppServerRpcRouter) => {
      register(router1, "runtime-u1-approval", true);
      register(router1, "runtime-u1-stream", false);
      register(router2, "runtime-u2-stop", false);
      register(router2, "runtime-u2-stream", false);
    };
    registerAll(user1.router, user2.router);

    await Promise.all([
      user1.router.request(request("u1-approval-start", "runtime-u1-approval")),
      user1.router.request(request("u1-stream-start", "runtime-u1-stream")),
      user2.router.request(request("u2-stop-start", "runtime-u2-stop")),
      user2.router.request(request("u2-stream-start", "runtime-u2-stream")),
    ]);
    await waitUntil(() => {
      expect(approvalSeen).toBe(true);
      expect(values.get("runtime-u1-stream")).toHaveLength(1);
      expect(values.get("runtime-u2-stream")).toHaveLength(1);
    });
    expect(approvalResolved).toBe(false);

    const stopRequest: Extract<ClientRequest, { method: "turn/interrupt" }> = {
      method: "turn/interrupt",
      id: "u2-stop-control",
      params: { threadId: "runtime-u2-stop", turnId: "turn-runtime-u2-stop" },
    };
    let stopPersisted = false;
    await user2.router.request(stopRequest, 2_000, async () => {
      stopPersisted = true;
    });
    await waitUntil(() => {
      expect(stopPersisted).toBe(true);
      expect(values.get("runtime-u2-stop")).toContain("u2:runtime-u2-stop:interrupt-confirmed");
      expect(values.get("runtime-u2-stream")).toContain("u2:stream-after-stop");
    });
    expect(approvalResolved).toBe(false);
    releaseApproval();
    await waitUntil(() => expect(approvalResolved).toBe(true));

    await user1.router.request(request("u1-crash", "runtime-u1-stream"));
    await waitUntil(async () => {
      expect(values.get("runtime-u1-stream")).toContain("u1:runtime-u1-stream:u1-crash");
      expect((await user1.gateway.health()).state).toBe("failed");
    });
    await user1.router.close();
    await user1.transport.close();
    await user1.gateway.stop();

    const restarted = await runtime(context1, server1.script, "acceptance-client.jsonl");
    register(restarted.router, "runtime-u1-approval", false);
    register(restarted.router, "runtime-u1-stream", false);
    await restarted.router.start();
    await waitUntil(async () => {
      expect(crashEventId).not.toBeNull();
      expect(deliveryAttempts.get(crashEventId!)).toBe(2);
      expect(await restarted.journal.readUndelivered(20)).toEqual([]);
    });

    await Promise.all([
      restarted.router.request(request("u1-crash", "runtime-u1-stream")),
      user2.router.request(request("u2-after-u1-crash", "runtime-u2-stream")),
    ]);
    await waitUntil(() => {
      expect(values.get("runtime-u2-stream")).toContain("u2:runtime-u2-stream:u2-after-u1-crash");
    });

    const executions = (await readFile(server1.executionLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { id?: string; result?: { decision?: string } });
    expect(executions.filter(({ id }) => id === "u1-crash")).toHaveLength(1);
    expect(executions.filter(({ id, result }) =>
      id === "approval-u1" && result?.decision === "accept")).toHaveLength(1);
    expect(values.get("runtime-u1-stream")?.filter((value) => value.endsWith(":u1-crash"))).toHaveLength(1);
    for (const [threadId, threadValues] of values) {
      const expectedUser = threadId.includes("u1") ? "u1:" : "u2:";
      expect(threadValues.every((value) => value.startsWith(expectedUser))).toBe(true);
    }
    expect(context1.environment.CODEX_HOME).not.toBe(context2.environment.CODEX_HOME);
    expect(context1.workspace).not.toBe(context2.workspace);
    expect(context1.transportAudit).not.toBe(context2.transportAudit);
  // This exercises four isolated worker processes, an approval round-trip and a
  // durable replay. CI contention can make the end-to-end path exceed the
  // default integration-test budget without indicating a behavioural failure.
  }, 45_000);
});
