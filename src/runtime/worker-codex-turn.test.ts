import { DurableTurnSubmission } from "@/runtime/turn-submission-store";
import * as coldRecovery from "@/runtime/cold-thread-recovery";
import * as authContext from "@/auth/auth-context";
import { FileApprovalStore } from "@/runtime/approval-store";
import type { AuthSession } from "@/auth/types";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRequest } from "@/lib/chat-contract";
import type { MemoryService } from "@/memory";
import type { ResolvedPermissions } from "@/permissions";
import type { DynamicToolSpec } from "../../contracts/codex/0.162.1/types/v2/DynamicToolSpec";
import type {
  MemoryTurnAuditEvent,
  WorkerTurnMemoryDependencies,
} from "@/runtime/memory-turn";
import { AppServerRequestTimeoutError, AppServerRpcResponseError } from "@/runtime/transport/app-server-rpc-router";
import { TransportRequestTooLargeError } from "@/runtime/transport/websocket-app-server-transport";
import { createQuotaToolPermissions } from "@/runtime/quota-tool-permissions";
import { generatedPngFixture } from "../../tests/helpers/png-fixture";
import { RuntimeProjectionAdmissionDeferred } from "@/runtime/transport/projection-readiness";
import { FileModelTurnQueue, BackgroundModelAdmissionDeferred, type ModelTurnAdmission } from "@/runtime/model-turn-queue";
import type { ResolvedConnectorMention } from "@/connectors/mentions-contract";
import { GMAIL_CATALOG_RESOURCE } from "@/connectors/gmail-contracts";
import { OUTLOOK_CATALOG_RESOURCE } from "@/connectors/outlook-contracts";
import { MAIL_CATALOG_RESOURCE } from "@/connectors/mail-contracts";
import { markConnectedAppConfigApplied } from "@/runtime/connected-app-config";
import { MODEL_RATE_LIMIT_MESSAGE, MODEL_RATE_LIMIT_PENDING_MESSAGE } from "@/runtime/model-capacity-retry";
import type { ResolvedTurnDocument } from "@/documents/turn-attachments";
import { cancelPendingWorkerTurn } from "@/runtime/turn-control";
import { FileTurnProjectionStore } from "@/workbench/turn-projection-store";

const mocked = vi.hoisted(() => ({
  runtime: null as unknown,
  startupFailures: 0,
  maintenanceReleases: 0,
  maintenanceLease: null as unknown,
  cancelTurn: null as ((remoteInterruptConfirmed: boolean) => void) | null,
  pendingCancellation: false,
  capacityWaits: null as number[] | null,
  capacityAbort: null as (() => void) | null,
  availableConnectors: vi.fn<(...args: unknown[]) => Promise<ResolvedConnectorMention[]>>(),
  mailCapability: vi.fn(),
  nativeMcpConfig: vi.fn().mockResolvedValue({}),
  nativeAppTools: vi.fn().mockResolvedValue({}),
}));
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: async (...args: Parameters<typeof actual.setTimeout>) => {
    if (mocked.capacityWaits && args[0] === 10_000) {
      mocked.capacityWaits.push(args[0]);
      mocked.capacityAbort?.();
      if (args[2]?.signal?.aborted) throw new Error("Aborted wait");
      return args[1];
    }
    return actual.setTimeout(...args);
  } };
});
vi.mock("server-only", () => ({}));
vi.mock("@/connectors/mentions", () => ({ resolveAvailableConnectorsForTurn: mocked.availableConnectors }));
vi.mock("@/connectors/mail-server-service", async importOriginal => ({
  ...await importOriginal<typeof import("@/connectors/mail-server-service")>(), mailCapabilityForSession: mocked.mailCapability,
}));
vi.mock("@/runtime/native-mcp-config", () => ({ nativeMcpConfigForTurn: mocked.nativeMcpConfig }));
vi.mock("@/runtime/native-app-tools", async importOriginal => ({
  ...await importOriginal<typeof import("@/runtime/native-app-tools")>(), nativeAppToolsForTurn: mocked.nativeAppTools,
}));
vi.mock("@/insijets/operator-server", () => ({
  loadOperatorConfiguration: async () => ({ enabled: true, installationId: "insijets-demo", storageRoot: "/unused",
    approvedResearchOrigins: [], approvedVerificationProviders: [] }),
}));
vi.mock("@/auth/session", () => ({
  getSigningSecret: () => "test-signing-secret-with-at-least-thirty-two-bytes",
}));
vi.mock("@/runtime/thread-token", () => ({
  CURRENT_THREAD_TOOLSET_REVISION: "test-current-toolset",
  issueThreadToken: () => "user-bound-runtime-thread-token",
  toolsetRevisionForIssuedThreadToken: (threadId: string | null, revision: string | null) => threadId ? revision : "test-current-toolset",
}));
vi.mock("@/runtime/worker-runtime-service", () => ({
  acquireWorkerTurnActivity: async () => {
    const lease = {
      activityId: "00000000-0000-4000-8000-000000000099",
      kind: "turn",
      acquiredAt: "2026-08-27T00:00:00.000Z",
      release: () => { mocked.maintenanceReleases += 1; },
    };
    mocked.maintenanceLease = lease;
    return lease;
  },
  workerAppServerForUser: async (_userId: string, lease: unknown, beforeInitialize?: (value: unknown) => Promise<void>) => {
    if (lease !== mocked.maintenanceLease) throw new Error("Worker activity lease was not forwarded.");
    const fixture = mocked.runtime as { config: unknown; handle?: { roots: { userRoot?: string; workspace: string } } } | null;
    if (fixture?.handle) fixture.handle.roots.userRoot ??= fixture.handle.roots.workspace;
    if (fixture?.handle) await beforeInitialize?.({ config: fixture.config, roots: fixture.handle.roots });
    if (mocked.startupFailures > 0) { mocked.startupFailures--; throw new Error("Owner authentication returned an invalid account."); }
    return mocked.runtime;
  },
  cancelWorkerTurnLocally: () => false,
  requestPendingWorkerTurnCancellation: () => { mocked.pendingCancellation = true; return true; },
  registerWorkerTurnCancellation: (
    _userId: string,
    _runtimeThreadId: string,
    _localTurnId: string,
    cancel: (remoteInterruptConfirmed: boolean) => void,
  ) => {
    mocked.cancelTurn = cancel;
    if (mocked.pendingCancellation) { mocked.pendingCancellation = false; cancel(false); }
    return () => { mocked.cancelTurn = null; };
  },
}));

import {
  documentToolTerminalGraceMs,
  runWorkerCodexTurn,
  workerTurnTimeoutMs,
  WorkerTurnRecoveryPendingError,
  WorkerThreadStartRejectedError,
  WorkerTurnRequestRejectedBeforeSendError,
  WorkerTurnPreparationFailedError,
  type WorkerCodexTurnEvent,
} from "@/runtime/worker-codex-turn";

const installationId = "qa-company";
const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000011";
const threadId = "00000000-0000-4000-8000-000000000021";
const userMessageId = "00000000-0000-4000-8000-000000000031";
const assistantMessageId = "00000000-0000-4000-8000-000000000041";
const fingerprint = "a".repeat(64);
const memoryId = "00000000-0000-4000-8000-000000000051";
const documentUploadId = "00000000-0000-4000-8000-000000000061";
const installationPaths = {
  companyContextRoot: "/company-context",
  sourceReadRoot: "/source-knowledge",
};

function memoryDependencies(
  overrides: {
    buildPromptSnapshot?: MemoryService["buildPromptSnapshot"];
    record?: (event: MemoryTurnAuditEvent) => Promise<MemoryTurnAuditEvent>;
  } = {},
): WorkerTurnMemoryDependencies {
  return {
    memoryService: {
      buildPromptSnapshot: overrides.buildPromptSnapshot ?? (async () => ({
        text: JSON.stringify({
          schemaVersion: 1,
          trust: "untrusted-data-only",
          companyContext: [],
          knowledgeIndex: { content: "" },
          employeeContext: { profile: "Employee A", preferences: "Direct" },
          explicitMemories: [{ memoryId, content: "Approved preference" }],
        }),
        memoryIds: [memoryId],
        truncated: false,
      })),
    } as MemoryService,
    auditSink: {
      record: overrides.record ?? (async (event) => event),
    },
  };
}

function chatRequest(): ChatRequest {
  return {
    projectId,
    threadId,
    userMessageId,
    assistantMessageId,
    message: "Resume el document",
    preferences: { tone: "direct", language: "ca", showActivity: true },
    options: {
      mode: "agent",
      model: null,
      effort: null,
      webSearch: false,
      imageGeneration: false,
      skill: null,
      attachments: [],
    },
  };
}

function permissions(rules: ResolvedPermissions["rules"] = []): ResolvedPermissions {
  return {
    schemaVersion: 1,
    installationId,
    userId,
    roleId: null,
    projectId,
    turnId: assistantMessageId,
    resolvedAt: new Date().toISOString(),
    fingerprint,
    sources: [],
    rules,
    developerInstructions: `Policy fingerprint: ${fingerprint}`,
  };
}

function projectGuidance() {
  return {
    projectId,
    projectName: "Testing 1",
    projectInstructions: "",
    projectMemory: "",
    projectSources: [],
    visibleProjects: [{ id: projectId, name: "Testing 1" }],
    branchHistory: null,
  };
}

describe("worker Codex turn", () => {
  it.each(["runtime", "automation", "absent"] as const)(
    "binds Trinalum authenticatedEmail to the server session, never tool arguments (%s)", async (identitySource) => {
      const { rm } = await import("node:fs/promises");
      const businessTools = await import("@/runtime/trinalum-dynamic-tools");
      const { requiresExactEmailReview } = await import("@/runtime/trinalum-chat-actions");
      const automationTools = await import("@/automations/chat-tools");
      // This test exercises worker identity wiring, without loading native catalogs/tasks.
      const automationInstructions = vi.spyOn(automationTools, "automationChatDeveloperInstructions").mockResolvedValue("");
      const action = vi.spyOn(businessTools, "handleTrinalumTool").mockResolvedValue({ success: true, contentItems: [{ type: "inputText", text: "Prepared synthetic action" }] });
      const root = await mkdtemp(path.join(tmpdir(), "aibrain-trinalum-session-wiring-"));
      const nativeEmail = "manager@example.invalid";
      const spoofedEmail = "administration@example.invalid";
      const session = (email: string): AuthSession => ({ provider: "local", user: { id: userId, name: "Synthetic employee", email },
        tenant: { id: installationId, name: "Synthetic installation" }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const runtimeSession = identitySource === "runtime" ? session(nativeEmail) : undefined;
      const automationSession = identitySource === "absent" ? undefined : session(identitySource === "runtime" ? "sales@example.invalid" : nativeEmail);
      let handlers: {
        onServerRequest(request: unknown, envelope: unknown): Promise<unknown> | unknown;
        onNotification(notification: unknown, envelope: unknown): Promise<unknown> | unknown;
      } | null = null;
      let sequence = 0;
      const envelope = () => ({ eventId: `identity-wiring-${++sequence}`, sequence, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
      const terminal = { id: "identity-turn", status: "completed", error: null, items: [
        { type: "userMessage", id: "identity-user", clientId: userMessageId, content: [] },
        { type: "agentMessage", id: "identity-answer", phase: "final_answer", text: "Synthetic identity wiring checked." },
      ] };
      const calls: string[] = [];
      mocked.runtime = {
        config: { installationId, paths: installationPaths },
        handle: { roots: { workspace: root, staging: root, artifacts: root } },
        client: {
          connectionSummary: async () => ({ connected: true }),
          router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => {
            handlers = value; return { bindRuntimeTurn() {}, dispose() {} };
          } },
          async request(method: string, _params: unknown, _purpose: string, _timeout: number,
            beforeResolve?: (value: never, event: never) => Promise<void>) {
            calls.push(method);
            const result = method === "thread/start" ? { thread: { id: "identity-thread" } }
              : method === "turn/start" ? { turn: { id: "identity-turn" } }
              : { thread: { id: "identity-thread", turns: [terminal] } };
            await beforeResolve?.(result as never, envelope() as never);
            if (method === "turn/start") queueMicrotask(() => { void (async () => {
              await handlers?.onServerRequest({ method: "item/tool/call", id: "identity-call", params: {
                threadId: "identity-thread", turnId: "identity-turn", callId: "identity-call", namespace: "trinalum_business", tool: "mail_action",
                authenticatedEmail: spoofedEmail,
                arguments: { type: "send_mail", request: {}, authenticatedEmail: spoofedEmail, user: { email: spoofedEmail } },
              } }, envelope());
              await handlers?.onNotification({ method: "turn/completed", params: { threadId: "identity-thread", turn: terminal } }, envelope());
            })(); });
            return result;
          },
        },
      };
      const events: Array<{ type: string }> = [];
      try {
        await runWorkerCodexTurn(chatRequest(), installationId, userId, null, {
          tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
          workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
        }, permissions(), {} as never, memoryDependencies(), [], new AbortController().signal,
        async event => { events.push(event); }, undefined, undefined, null, undefined, undefined, automationSession, runtimeSession);
        expect(action).toHaveBeenCalledTimes(1);
        const [toolParams, context] = action.mock.calls[0];
        expect(toolParams.arguments).toMatchObject({ authenticatedEmail: spoofedEmail });
        expect(context.authenticatedEmail).toBe(identitySource === "absent" ? undefined : nativeEmail);
        expect(context.userId).toBe(userId);
        const needsReview = requiresExactEmailReview({ operation: "mail_action", input: { type: "send_mail" },
          prepared: { data: { preview: { from: nativeEmail, mailbox: nativeEmail } } } }, context.authenticatedEmail);
        expect(needsReview).toBe(identitySource === "absent");
        expect(calls).toEqual(["thread/start", "turn/start"]);
        expect(events).toContainEqual({ type: "done" });
        expect(events.some(event => event.type === "error")).toBe(false);
      } finally {
        action.mockRestore(); automationInstructions.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { label: "optional origin omitted", publicUrl: undefined, operatorEnabled: false },
    { label: "optional origin invalid", publicUrl: "not-a-url", operatorEnabled: false },
    { label: "foreign tenant with operator flags", publicUrl: undefined, operatorEnabled: true },
    { label: "authenticated InsiJets outreach", publicUrl: undefined, operatorEnabled: false, outreachEnabled: true },
    { label: "background InsiJets outreach denied", publicUrl: undefined, operatorEnabled: false, outreachEnabled: true, background: true },
  ])("assembles a unique authenticated dynamic tool catalogue and completes the synthetic model turn ($label)", async (fixture) => {
    const { publicUrl, operatorEnabled } = fixture;
    const outreachEnabled = "outreachEnabled" in fixture && fixture.outreachEnabled;
    const background = "background" in fixture && fixture.background;
    const turnInstallationId = outreachEnabled ? "insijets-demo" : installationId;
    vi.stubEnv("AIBRAIN_INSIJETS_WEBSITE_CHAT_LOCAL_DEMO", String(operatorEnabled));
    vi.stubEnv("AIBRAIN_INSIJETS_MULTISOURCE_V2_ENABLED", String(operatorEnabled));
    vi.stubEnv("AIBRAIN_INSIJETS_OPERATOR_ENABLED", String(outreachEnabled));
    vi.stubEnv("AIBRAIN_INSIJETS_OUTREACH_SYSTEM_ENABLED", String(outreachEnabled));
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-authenticated-tool-catalogue-"));
    let handlers: { onNotification(value: unknown, envelope?: unknown): Promise<void> | void } | null = null;
    let catalogue: readonly DynamicToolSpec[] = [];
    const calls: string[] = [];
    const terminal = { id: "catalogue-turn", status: "completed", error: null, items: [
      { type: "userMessage", id: "catalogue-user", clientId: userMessageId, content: [] },
      { type: "agentMessage", id: "catalogue-answer", phase: "final_answer", text: "Synthetic catalogue accepted" },
    ] };
    mocked.runtime = {
      config: { installationId: turnInstallationId, paths: installationPaths, ...(publicUrl === undefined ? {} : { publicUrl }) },
      handle: { roots: { workspace: root, staging: root, artifacts: root } },
      client: {
        connectionSummary: async () => ({ connected: true }),
        router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => {
          handlers = value; return { bindRuntimeTurn() {}, dispose() {} };
        } },
        async request(method: string, params: { dynamicTools?: readonly DynamicToolSpec[] }, purpose: string, _timeout: number,
          beforeResolve?: (value: never, event: never) => Promise<void>) {
          calls.push(method);
          const result = method === "thread/loaded/list" ? {data:[],nextCursor:null} : method === "thread/unsubscribe" ? {status:"unsubscribed"} : method === "thread/start" ? { thread: { id: "catalogue-thread" } }
            : method === "turn/start" ? { turn: { id: "catalogue-turn" } }
            : { thread: { id: "catalogue-thread", turns: [terminal] } };
          if (method === "thread/start") catalogue = params.dynamicTools ?? [];
          await beforeResolve?.(result as never, { eventId: `${method}-response`, sequence: calls.length,
            occurredAt: new Date().toISOString(), message: { kind: "rpc-response", rpc: { id: purpose, result } } } as never);
          if (method === "turn/start") queueMicrotask(() => { void handlers?.onNotification({ method: "turn/completed", params: {
            threadId: "catalogue-thread", turn: terminal,
          } }); });
          return result;
        },
      },
    };
    const events: Array<{ type: string }> = [];
    await runWorkerCodexTurn(chatRequest(), turnInstallationId, userId, null, {
      tenantId: turnInstallationId, mode: "codex", codexBinary: "unused", codexHome: null,
      workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
    }, { ...permissions(), installationId: turnInstallationId }, {} as never, memoryDependencies(), [], new AbortController().signal,
    async event => { events.push(event); }, undefined, undefined, null, undefined, undefined, undefined,
    { provider: "local", user: { id: userId, name: "Fixture", email: outreachEnabled ? "operator@example.invalid" : "fixture@example.test" },
      tenant: { id: turnInstallationId, name: "Fixture" }, expiresAt: new Date(Date.now() + 60_000).toISOString() }, Boolean(background));
    expect(catalogue.map(tool => tool.name)).toEqual(expect.arrayContaining([
      "aibrain_documents", "aibrain_horaria",
    ]));
    expect(catalogue.map(tool => tool.name)).not.toContain("aibrain_gmail");
    expect(catalogue.map(tool => tool.name)).not.toContain("aibrain_outlook");
    expect(catalogue.some(tool => tool.name === "aibrain_browser")).toBe(false);
    expect(new Set(catalogue.map(tool => tool.name)).size).toBe(catalogue.length);
    expect(catalogue.some(tool => tool.name === "insijets_operator_local_review")).toBe(false);
    expect(catalogue.some(tool => tool.name === "insijets_outreach_preparation")).toBe(Boolean(outreachEnabled && !background));
    if (outreachEnabled && !background) {
      const outreach = catalogue.find(tool => tool.type === "namespace" && tool.name === "insijets_outreach_preparation");
      expect(outreach?.type === "namespace" && outreach.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
        "live_campaigns", "live_campaign", "live_replies", "prepare_research_plan",
      ]));
    }
    const names = catalogue.flatMap(tool => tool.type === "namespace"
      ? tool.tools.map(child => `${tool.name}.${child.name}`) : [tool.name]);
    expect(new Set(names).size).toBe(names.length);
    const documents = catalogue.find(tool => tool.type === "namespace" && tool.name === "aibrain_documents");
    if (!documents || documents.type !== "namespace") throw Error("document tools missing");
    const schedule = documents.tools.filter(tool => tool.name === "create_arnall_schedule");
    expect(schedule).toHaveLength(1);
    expect(JSON.stringify(schedule[0].inputSchema)).toContain('"maxWeeklyHours"');
    expect(calls.filter(method => method === "thread/start")).toHaveLength(1);
    expect(calls.filter(method => method === "turn/start")).toHaveLength(1);
    expect(events).toContainEqual({ type: "done" });
  });

  it.each(["projection-defer", "foreground-projection-defer", "background-queue-defer", "recover", "recover-smart", "fallback", "fallback-smart", "fallback-exhaust", "queue-cancel", "lost-retry-ack", "exhaust", "partial", "wrong-code", "read-partial", "lost-read", "cancel", "rate-limit", "rate-limit-retrying", "rate-limit-after-work", "http-429", "fallback-staged-image"])(
    "handles capacity admission with %s without replaying partial work", async (outcome) => {
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-capacity-retry-"));
    const workspace = path.join(userRoot, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const documents: ResolvedTurnDocument[] = [];
    if (outcome === "fallback-staged-image") {
      const image = generatedPngFixture();
      const uploadId = "00000000-0000-4000-8000-000000000099";
      const relativePath = `threads/${threadId}/uploads/${uploadId}/qa.png`;
      const absolutePath = path.join(userRoot, "staging", relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      await writeFile(absolutePath, image, { mode: 0o600 });
      documents.push({ document: { schemaVersion: 1, uploadId, threadId, fileName: "qa.png", relativePath,
        kind: "image", mediaType: "image/png", size: image.length,
        sha256: createHash("sha256").update(image).digest("hex"), status: "staged", createdAt: "2026-10-26T00:00:00.000Z" },
        absolutePath, codexInputs: [{ type: "image", url: `data:image/png;base64,${image.toString("base64")}` }] });
    }
    const blockers: ModelTurnAdmission[] = [];
    if (["queue-cancel","background-queue-defer"].includes(outcome)) {
      const queue = new FileModelTurnQueue(path.join(userRoot, "runtime", "model-turn-queue"));
      for (const turnId of ["00000000-0000-4000-8000-000000000081", "00000000-0000-4000-8000-000000000082"]) {
        blockers.push(await queue.acquire({ installationId, userId, threadId, turnId },
          { signal: new AbortController().signal, recovering: false, onWaiting: async () => {} }));
      }
    }
    let handlers: { onNotification(value: unknown, envelope: unknown): Promise<void> | void } | null = null;
    const calls: Array<{ method: string; params: Record<string, unknown>; purpose: string }> = [];
    const controller = new AbortController();
    let started = 0;
    let lastTurn: Record<string, unknown> | null = null;
    let sequence = 0;
    const envelope = () => ({ eventId: `capacity-event-${++sequence}`, sequence, occurredAt: new Date().toISOString(),
      message: { kind: "rpc-notification", rpc: {} } });
    const client = {
      canReuseLoadedThread: () => true,
      router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => {
        handlers = value;
        return { bindRuntimeTurn() {}, dispose() { handlers = null; } };
      } },
      connectionSummary: async () => ({ connected: true }),
      connection: async () => ({ models: outcome.startsWith("fallback")
        ? (outcome === "fallback-staged-image" ? ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"] : ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"]).map(id => ({ id,
          inputModalities: outcome === "fallback-staged-image" && !["gpt-6.1-sol", "gpt-5.6-terra"].includes(id) ? ["text"] : ["text", "image"],
          supportedReasoningEfforts: ["low", "medium"], defaultReasoningEffort: "low" })) : [] }),
      resolvedSkills: async () => [],
      async request(method: string, params: Record<string, unknown>, purpose: string, _timeout?: number,
        beforeResolve?: (result: never, event: never) => Promise<void> | void) {
        calls.push({ method, params, purpose });
        if (method === "thread/read") {
          if (outcome === "lost-read") throw new Error("Transport read failed");
          const observed = outcome === "read-partial" ? { ...lastTurn, items: [
            ...(lastTurn!.items as unknown[]), { type: "commandExecution", id: "prior-effect" }] } : lastTurn;
          const result = { thread: { id: "runtime-thread-capacity", turns: [observed] } };
          await beforeResolve?.(result as never, envelope() as never);
          return result;
        }
        if (method !== "turn/start") throw new Error(`Unexpected ${method}`);
        started += 1;
        const turnId = `capacity-turn-${started}`;
        const succeeds = ["recover", "recover-smart", "fallback", "fallback-smart", "lost-retry-ack", "fallback-staged-image"].includes(outcome) && started === 2;
        lastTurn = { id: turnId, status: succeeds ? "completed" : "failed", items: [
          { type: "userMessage", id: `input-${started}`, clientId: params.clientUserMessageId },
          ...(succeeds ? [{ type: "agentMessage", id: "answer", phase: "final_answer", text: "RECOVERED" }] :
            ["partial", "rate-limit-after-work"].includes(outcome) ? [{ type: "commandExecution", id: "prior-effect" }] : []),
        ], error: succeeds ? null : { message: "Selected model is at capacity. Please try a different model.",
          codexErrorInfo: outcome === "wrong-code" ? "usageLimitExceeded" : outcome.startsWith("rate-limit") ? "rateLimitExceeded" : outcome === "http-429" ? { responseStreamConnectionFailed: { httpStatusCode: 429 } } : "serverOverloaded" } };
        const result = { turn: { id: turnId } };
        if (outcome === "lost-retry-ack" && started === 2) throw new AppServerRequestTimeoutError("turn/start", purpose, 60_000);
        await beforeResolve?.(result as never, envelope() as never);
        const terminal = lastTurn;
        queueMicrotask(() => { void (async () => {
          if (outcome === "rate-limit-retrying") await handlers?.onNotification({ method: "error", params: {
            threadId: "runtime-thread-capacity", turnId, error: terminal!.error, willRetry: true } }, envelope());
          if (["partial", "rate-limit-after-work"].includes(outcome)) await handlers?.onNotification({ method: "item/started", params: {
            threadId: "runtime-thread-capacity", turnId, item: { type: "commandExecution", id: "prior-effect" } } }, envelope());
          await handlers?.onNotification({ method: "turn/completed", params: {
            threadId: "runtime-thread-capacity", turn: terminal } }, envelope());
        })(); });
        return result;
      },
    };
    // This fixture represents an already loaded thread with the current empty
    // managed-app inventory attested; admission retries should not reconfigure it.
    Object.assign(client, {assertProjectionReady: async () => {
      if (outcome.includes("projection-defer")) throw new RuntimeProjectionAdmissionDeferred();
    }});
    markConnectedAppConfigApplied(client, "runtime-thread-capacity", []);
    mocked.runtime = { config: { installationId, ...(["queue-cancel","background-queue-defer"].includes(outcome) ? {} : { companySlug: "arnall" }), branding: { productName: "Arnall AI" },
      paths: { ...installationPaths, ...(["queue-cancel","background-queue-defer"].includes(outcome) ? { dataRoot: userRoot } : {}) } },
      handle: { roots: { userRoot, workspace, staging: path.join(userRoot, "staging"), artifacts: path.join(userRoot, "artifacts") } },
      client, workerWasWarm: true };
    mocked.capacityWaits = [];
    mocked.capacityAbort = outcome === "cancel" ? () => controller.abort() : null;
    const events: Array<Record<string, unknown>> = [];
    const model = outcome === "fallback-staged-image" ? "gpt-6.1-sol" : outcome.endsWith("smart") ? "gpt-5.6-sol" : "gpt-6-astra";
    const effort = outcome.endsWith("smart") ? "low" as const : "medium" as const;
    const request = { ...chatRequest(), options: { ...chatRequest().options, model, effort,
      ...(documents.length ? { documentUploadIds: documents.map(({ document }) => document.uploadId) } : {}) } };
    const turnPermissions = documents.length ? permissions([{ ruleId: "documents.read", action: "consult", effect: "allow",
      instruction: "Read the admitted fixture", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 100 }]) : permissions();
    const run = runWorkerCodexTurn(request, installationId, userId, "runtime-thread-capacity",
      { tenantId: installationId, mode: "codex", codexBinary: "codex", codexHome: null, workspace, model: null,
        approvalPolicy: "on-request", sandbox: "workspace-write" }, turnPermissions, {} as never, memoryDependencies(), documents,
      controller.signal, async event => {
        events.push(event);
        if (outcome === "queue-cancel" && event.type === "activity" && event.item.id === "runtime-model-queue") mocked.cancelTurn?.(false);
      },undefined,undefined,undefined,undefined,undefined,undefined,undefined,["background-queue-defer","projection-defer"].includes(outcome));
    try {
      if(["background-queue-defer","projection-defer","foreground-projection-defer"].includes(outcome)){
        await expect(run).rejects.toBeInstanceOf(outcome === "foreground-projection-defer" ? WorkerTurnRecoveryPendingError : BackgroundModelAdmissionDeferred);
        expect(calls.some(call=>["thread/start","turn/start","turn/steer"].includes(call.method))).toBe(false);
        expect(events.some(event=>["toolResult","approval","done","error"].includes(String(event.type)))).toBe(false);
        return;
      }
      if (outcome === "lost-read") await expect(run).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
      else await run;
      const succeeds = ["recover", "recover-smart", "fallback", "fallback-smart", "lost-retry-ack", "fallback-staged-image"].includes(outcome);
      const expected = outcome === "queue-cancel" ? 0 : succeeds ? 2 : outcome.endsWith("exhaust") ? 3 : 1;
      expect(started).toBe(expected);
      const starts = calls.filter(c => c.method === "turn/start");
      expect(new Set(starts.map(c => c.purpose)).size).toBe(expected);
      expect(new Set(starts.map(c => c.params.clientUserMessageId)).size).toBe(expected);
      expect(starts.every(c => c.params.effort === effort)).toBe(true);
      if (outcome.startsWith("fallback")) {
        expect(starts.map(c => c.params.model)).toEqual(outcome === "fallback-exhaust"
          ? ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"] : [model, outcome === "fallback-staged-image" ? "gpt-5.6-terra" : outcome === "fallback-smart" ? "gpt-6-astra" : "gpt-5.6-sol"]);
        expect(events.some(e => e.type === "activity" && JSON.stringify(e).includes("modelo alternativo"))).toBe(true);
      } else expect(starts.every(c => c.params.model === model)).toBe(true);
      if (succeeds) {
        expect(events).toContainEqual({ type: "done" });
        expect(events.some(e => e.type === "error")).toBe(false);
        expect(events).toContainEqual({ type: "runtimeTurn", turnId: "capacity-turn-2", rejectedTurnId: "capacity-turn-1" });
      }
      if (outcome === "exhaust" || outcome === "fallback-exhaust") expect(mocked.capacityWaits).toEqual([10_000, 10_000]);
      if (succeeds || outcome.endsWith("exhaust") || outcome === "cancel") {
        const notices = events.filter(e => e.type === "activity" && (e.item as { id?: string; status?: string }).id === "runtime-capacity-retry" &&
          (e.item as { status?: string }).status === "waiting");
        expect(notices).toHaveLength(outcome.endsWith("exhaust") ? 2 : 1);
        expect(mocked.capacityWaits).toEqual(outcome.endsWith("exhaust") ? [10_000, 10_000] : [10_000]);
        for (const notice of notices) expect(notice).toMatchObject({ item: { detail: expect.stringContaining("10 segundos") } });
      }
      if (outcome === "fallback-staged-image") {
        expect(request.options.attachments).toHaveLength(0);
        expect((starts[0].params.input as Array<{ type: string }>).some(input => input.type === "localImage")).toBe(true);
      }
      if (outcome.startsWith("rate-limit") || outcome === "http-429") {
        expect(mocked.capacityWaits).toEqual([]);
        expect(started).toBe(1);
        expect(events.filter(e => e.type === "error")).toEqual([expect.objectContaining({ message: MODEL_RATE_LIMIT_MESSAGE })]);
        expect(calls.some(call => call.purpose.startsWith("turn-capacity-check:"))).toBe(false);
      }
      if (outcome === "rate-limit-retrying") {
        const waiting = events.findIndex(e => e.type === "activity" && (e.item as { id?: string }).id === "runtime-provider-rate-limit");
        const terminal = events.findIndex(e => e.type === "error");
        expect(waiting).toBeGreaterThanOrEqual(0);
        expect(waiting).toBeLessThan(terminal);
        expect(events[waiting]).toMatchObject({ type: "activity", item: { status: "waiting", detail: MODEL_RATE_LIMIT_PENDING_MESSAGE } });
      }
      if (["cancel", "queue-cancel"].includes(outcome)) expect(events).toContainEqual({ type: "stopped" });
      if (["exhaust", "partial", "wrong-code", "read-partial"].includes(outcome)) {
        expect(events.filter(e => e.type === "error")).toHaveLength(1);
      }
    } finally {
      mocked.capacityWaits = null;
      mocked.capacityAbort = null;
      await Promise.all(blockers.map(blocker => blocker.complete()));
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it.each([1, 20].flatMap(count => ["warm", "cold", "missing", "finished", "before-accept", "lost-ack"].map(fault => ({ count, fault }))))(
    "recovers $count XLSX inputs after $fault without replaying a model turn", async ({ count, fault }) => {
    const { createHash } = await import("node:crypto");
    const { mkdir, writeFile, rm, access } = await import("node:fs/promises");
    const { generateLocalDocument } = await import("@/runtime/documents/local-document-generator");
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-durable-retry-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await mkdir(workspace, { mode: 0o700 });
    const generated = await generateLocalDocument({ format: "xlsx", title: "Fictional invoice", content: "Synthetic only", rows: [["Total"], [48.28]] });
    const edited = await generateLocalDocument({ format: "xlsx", title: "Fictional edited invoice", content: "Synthetic only", rows: [["Total"], [49.28]] });
    const documents = await Promise.all(Array.from({ length: count }, async (_, index) => {
      const uploadId = `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
      const relativePath = `threads/${threadId}/uploads/${uploadId}/fictional.xlsx`;
      const absolutePath = path.join(staging, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      await writeFile(absolutePath, generated.data, { mode: 0o600 });
      return { document: { schemaVersion: 1 as const, uploadId, threadId, fileName: "fictional.xlsx", relativePath,
        kind: "xlsx" as const, mediaType: generated.mimeType, size: generated.data.length,
        sha256: createHash("sha256").update(generated.data).digest("hex"), status: "staged" as const,
        createdAt: "2026-10-01T00:00:00.000Z" }, absolutePath,
        codexInputs: [{ type: "text" as const, text: "Server-bound fictional XLSX", text_elements: [] }] };
    }));
    const calls: Array<{ method: string; purpose: string }> = [];
    let handlers: { onFailure(error: Error): void; onNotification(value: unknown, envelope: unknown): Promise<void> };
    let copy = "";
    let attempt = 0;
    let sequence = 0;
    const envelope = () => ({ eventId: `retry-${++sequence}`, sequence,
      occurredAt: "2026-10-01T00:00:00.000Z", message: { kind: "rpc-notification", rpc: {} } });
    const missing = fault === "missing" || fault === "before-accept";
    const client = {
      canReuseLoadedThread: () => !(fault === "cold" && attempt > 1),
      connectionSummary: async () => ({ connected: true }),
      router: { registerTurn(_thread: string, _local: string, value: typeof handlers) {
        handlers = value;
        if (attempt > 1) setTimeout(() => { void handlers.onNotification({ method: "turn/completed",
          params: { threadId: "fictional-existing-thread", turn: { id: "fictional-remote-turn", status: "completed", items: [{ type: "agentMessage", id: "synthetic-final", phase: "final_answer", text: "Verified synthetic workbook recovery." }], error: null } },
        }, envelope()); }, 10);
        return { bindRuntimeTurn() {}, dispose() {} };
      } },
      async request(method: string, params: { input?: Array<{ type: string; text?: string }> }, purpose: string, _timeout: number,
        beforeResolve?: (value: never, event: never) => Promise<void>) {
        calls.push({ method, purpose });
        if (method === "thread/turns/list") {
          const result = { data: [], nextCursor: null };
          await beforeResolve?.(result as never, envelope() as never);
          return result;
        }
        if (method === "thread/read" || method === "thread/resume") {
          expect(await readFile(copy)).toEqual(fault === "before-accept" ? generated.data : edited.data);
          const turn = { id: "fictional-remote-turn", status: fault === "finished" ? "completed" : "inProgress", error: null,
            items: [{ type: "userMessage", clientId: userMessageId, id: "fictional-user-item", content: [] }] };
          const result = { thread: { id: "fictional-existing-thread", turns: missing ? [] : [turn] } };
          await beforeResolve?.(result as never, envelope() as never);
          return result;
        }
        if (method !== "turn/start" || attempt !== 1) throw new Error(`A model effect was replayed: ${method}`);
        const text = params.input!.find(item => item.text?.startsWith("Authorized Excel attachments"))!.text!;
        const files = JSON.parse(text.split("\n").at(-1)!) as Array<{ relativePath: string }>;
        expect(files).toHaveLength(count);
        copy = path.join(workspace, "projects", projectId, files[0].relativePath);
        if (fault === "before-accept") throw new Error("Connection lost before acceptance was observed");
        await writeFile(copy, edited.data, { mode: 0o600 });
        if (fault === "lost-ack") throw new Error("Remote acceptance occurred but the ACK was lost");
        const result = { turn: { id: "fictional-remote-turn" } };
        await beforeResolve?.(result as never, envelope() as never);
        queueMicrotask(() => handlers.onFailure(new Error("Fictional transport loss")));
        return result;
      },
    };
    markConnectedAppConfigApplied(client, "fictional-existing-thread", []);
    mocked.runtime = { config: { installationId, paths: installationPaths },
      handle: { roots: { userRoot, workspace, staging, artifacts: path.join(userRoot, "artifacts") } }, client };
    const request = { ...chatRequest(), options: { ...chatRequest().options, documentUploadIds: documents.map(({ document }) => document.uploadId) } };
    const run = () => {
      attempt += 1;
      return runWorkerCodexTurn(request, installationId, userId, "fictional-existing-thread", {
        tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null, workspace,
        model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
      }, permissions([{ ruleId: "documents.read", action: "consult", effect: "allow", instruction: "Synthetic access",
        sourceScope: "installation", sourcePolicyVersion: 1, precedence: 100 }]), {} as never,
      memoryDependencies(), documents, new AbortController().signal, async () => undefined);
    };
    try {
      await expect(run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
      await expect(access(copy)).resolves.toBeUndefined();
      // The fresh runner reloads app-owned admission from disk; the fake worker
      // has no accepted-request cache at all, as after restart/compaction.
      if (missing) {
        await expect(run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
        await expect(run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
        expect(await readFile(copy)).toEqual(fault === "before-accept" ? generated.data : edited.data);
        const observations = calls.filter(({ method }) => method === "thread/read").map(({ purpose }) => purpose);
        expect(new Set(observations).size).toBe(2);
      } else {
        await expect(run()).resolves.toBeUndefined();
        await expect(access(copy)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(calls.filter(({ method }) => method === "turn/start")).toEqual([
        { method: "turn/start", purpose: `turn-start:${assistantMessageId}` },
      ]);
      expect(calls[1].method).toBe(fault === "cold" ? "thread/resume" : "thread/read");
      for (const document of documents) expect(await readFile(document.absolutePath)).toEqual(generated.data);
    } finally { await rm(userRoot, { recursive: true, force: true }); }
  });

  it.each(["new", "existing", "host", "host-abort", "code-mode-new", "code-mode-existing"] as const)("attests quota profiles for a %s thread and downgrades the next turn without widening writes", async (kind) => {
    const isHost = kind.startsWith("host");
    const codeMode = kind.startsWith("code-mode"), isNew = kind === "new" || kind === "code-mode-new";
    let controller = new AbortController();
    const workspace = await mkdtemp(path.join(tmpdir(), "aibrain-quota-tools-"));
    const roots = { workspace, staging: workspace, artifacts: path.join(workspace, "artifacts"),
      codexHome: path.join(workspace, "runtime/codex-home"), transportAudit: path.join(workspace, "audit/transport") };
    const policy = createQuotaToolPermissions({ ...roots, workspace: path.join(workspace, "projects", projectId) });
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const denials: unknown[] = [];
    const violation = vi.fn();
    const blocked: unknown[] = [];
    let handlers: {
      onNotification(value: unknown, event: unknown): Promise<void>;
      onServerRequest(value: unknown, event: unknown): Promise<unknown>;
    };
    let sequence = 0;
    const envelope = () => ({ eventId: `quota-${++sequence}`, sequence, occurredAt: new Date().toISOString(),
      message: { kind: "rpc-notification", rpc: {} } });
    const client = {
      // Exercise a loaded resume that reports the preceding turn's profile.
      canReuseLoadedThread: () => codeMode,
      connectionSummary: async () => ({ connected: true }),
      router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => {
        handlers = value; return { bindRuntimeTurn() {}, dispose() {} };
      } },
      async request(method: string, params: Record<string, unknown>, _purpose: string, _timeout: number,
        beforeResolve?: (value: never, event: never) => Promise<void>) {
        calls.push({ method, params });
        if (method === "config/read") return { config: { mcp_servers: { private_mcp: {} } } };
        if (method === "thread/unsubscribe") return {status:"unsubscribed"};
        if (method === "thread/loaded/list") return {data:[],nextCursor:null};
        const result = method.startsWith("thread/") ? {
          thread: { id: "quota-thread", turns: [] }, cwd: policy.workspace,
          activePermissionProfile: { id: isHost ? policy.readOnlyId : policy.workspaceWriteId }, approvalPolicy: "never",
        } : { turn: { id: "quota-turn" } };
        await beforeResolve?.(result as never, envelope() as never);
        if (method === "turn/start") queueMicrotask(() => { void (async () => {
          for (const approvalMethod of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
            denials.push(await handlers.onServerRequest({ id: `request-${approvalMethod}`, method: approvalMethod, params: {
              threadId: "quota-thread", turnId: "quota-turn", itemId: "private-item",
              command: "read private runtime state", reason: "Inspect runtime files", permissions: { fileSystem: { read: ["/"], write: null } },
            } }, envelope()));
          }
          if (kind === "host-abort") {
            controller.abort(Error("HOST_EXECUTION_TIMEOUT"));
            blocked.push(await handlers.onServerRequest({ id: "late-host-read", method: "item/tool/call", params: {
              namespace: "trinalum_business", tool: "sibema_read", arguments: {}, threadId: "quota-thread", turnId: "quota-turn", callId: "late-host-read",
            } }, envelope()).catch(error => error));
          }
          if (kind === "host") blocked.push(await handlers.onServerRequest({ id: "blocked-host-write", method: "item/tool/call", params: {
            namespace: "trinalum_business", tool: "attio_action", arguments: {}, threadId: "quota-thread", turnId: "quota-turn", callId: "blocked-host-write",
          } }, envelope()));
          await handlers.onNotification({ method: "turn/completed", params: { threadId: "quota-thread",
            turn: { id: "quota-turn", status: "completed", items: [{ type: "agentMessage", id: "fixture-final", phase: "final_answer", text: "Fixture completed answer." }], error: null } } }, envelope());
        })(); });
        return result;
      },
    };
    mocked.runtime = { config: { installationId, paths: installationPaths,
      usageLimits: { weeklyTokens: 7_500_000, timeZone: "Europe/Madrid" } }, handle: { roots }, client };
    for (const [index, mode] of (["agent", "ask"] as const).entries()) {
      controller = new AbortController();
      const localTurnId = index === 0 ? assistantMessageId : "00000000-0000-4000-8000-000000000042";
      const request = chatRequest();
      request.assistantMessageId = localTurnId;
      request.options.mode = mode;
      await runWorkerCodexTurn(request, installationId, userId, index === 0 && isNew ? null : "quota-thread", {
        tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
        workspace, model: null, approvalPolicy: "on-request", sandbox: "workspace-write", codeMode,
      }, { ...permissions(), turnId: localTurnId }, {} as never, memoryDependencies(), [], controller.signal, async () => {},
        undefined, "AiBrain", null, undefined, undefined, undefined, undefined, true, null, false,
        isHost ? { businessReads: true, webSearch: false, onViolation: violation } : undefined);
    }
    const threads = calls.filter(({ method }) => method === "thread/start" || method === "thread/resume");
    expect(threads.map(({ method }) => method)).toEqual([isNew ? "thread/start" : "thread/resume", "thread/resume"]);
    expect(threads[0].params).toMatchObject({ permissions: isHost ? policy.readOnlyId : policy.workspaceWriteId, approvalPolicy: "never", config: { web_search: isHost ? "disabled" : "live" } });
    expect(threads[1].params).toMatchObject({ permissions: policy.readOnlyId, approvalPolicy: "never", config: { web_search: isHost ? "disabled" : "live" } });
    for (const thread of threads) expect(thread.params).not.toHaveProperty("sandbox");
    for (const thread of threads) {
      // Assert guidance reaches actual fresh/resumed RPC payloads alongside
      // the independently checked per-turn permissions; this is not a model eval.
      expect(thread.params.developerInstructions).toContain("Check every material requested constraint against source evidence");
      if (codeMode) {
        expect(thread.params.config).toMatchObject({ "features.code_mode": true, "features.code_mode_only": true });
        expect(thread.params.developerInstructions).toContain("Filter and aggregate in JavaScript");
      } else {
        expect(thread.params.config).not.toHaveProperty("features.code_mode");
        expect(thread.params.config).not.toHaveProperty("features.code_mode_only");
        expect(thread.params.developerInstructions).not.toContain("Native code mode is enabled");
      }
    }
    const turns = calls.filter(({ method }) => method === "turn/start");
    expect(turns.map(({ params }) => params.permissions)).toEqual([isHost ? policy.readOnlyId : policy.workspaceWriteId, policy.readOnlyId]);
    for (const { params } of turns) {
      expect(params).not.toHaveProperty("sandboxPolicy");
      expect(params.approvalPolicy).toBe("never");
      expect(params.runtimeWorkspaceRoots).toEqual([policy.workspace]);
    }
    if (isHost) {
      for (const thread of threads) expect(thread.params.config).toMatchObject({ "features.shell_tool": false, "features.apps": false, "mcp_servers.private_mcp.enabled": false });
      expect(violation).toHaveBeenCalledTimes(kind === "host-abort" ? 0 : 2);
      expect(blocked).toEqual(kind === "host-abort"
        ? [expect.objectContaining({ message: "HOST_EXECUTION_TIMEOUT" }), expect.objectContaining({ message: "HOST_EXECUTION_TIMEOUT" })]
        : [expect.objectContaining({ success: false }), expect.objectContaining({ success: false })]);
    }
    expect(denials).toEqual([
      { decision: "decline" }, { decision: "decline" }, { permissions: {}, scope: "turn" },
      { decision: "decline" }, { decision: "decline" }, { permissions: {}, scope: "turn" },
    ]);
  });

  it("enforces a read-only runtime and rechecks a revoked support preview before product access", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "g03-support-preview-runtime-"));
    const roots = { workspace, staging: workspace, artifacts: path.join(workspace, "artifacts"),
      codexHome: path.join(workspace, "runtime/codex-home"), transportAudit: path.join(workspace, "audit/transport") };
    const quota = createQuotaToolPermissions({ ...roots, workspace: path.join(workspace, "projects", projectId) });
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const answers: unknown[] = [];
    const isActiveBinding = vi.fn().mockResolvedValue(false);
    const lookup = vi.spyOn(authContext, "createLocalSessionContext").mockResolvedValue({ sessions: { isActiveBinding } } as never);
    let handlers: { onNotification(value: unknown, event: unknown): Promise<void>; onServerRequest(value: unknown, event: unknown): Promise<unknown> };
    let sequence = 0;
    const envelope = () => ({ eventId: `qa-preview-${++sequence}`, sequence, occurredAt: new Date().toISOString(),
      message: { kind: "rpc-notification", rpc: {} } });
    const client = {
      canReuseLoadedThread: () => false,
      connectionSummary: async () => ({ connected: true }),
      router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => {
        handlers = value; return { bindRuntimeTurn() {}, dispose() {} };
      } },
      async request(method: string, params: Record<string, unknown>, _purpose: string, _timeout: number,
        beforeResolve?: (value: never, event: never) => Promise<void>) {
        calls.push({ method, params });
        if (method === "config/read") return { config: { mcp_servers: { private_mcp: {} } } };
        const result = method === "thread/start" ? { thread: { id: "qa-preview-runtime", turns: [] }, cwd: quota.workspace,
          activePermissionProfile: { id: quota.readOnlyId }, approvalPolicy: "never" } : { turn: { id: "qa-preview-turn" } };
        await beforeResolve?.(result as never, envelope() as never);
        if (method === "turn/start") queueMicrotask(() => { void (async () => {
          for (const [namespace, tool] of [["aibrain_mail", "send"], ["aibrain_g03_sage", "execute"],
            ["aibrain_g03_production", "receiving"], ["aibrain_g03_apps", "design_apply"], ["aibrain_g03_production", "read"]]) {
            answers.push(await handlers.onServerRequest({ id: `${namespace}-${tool}`, method: "item/tool/call", params: {
              namespace, tool, arguments: {}, threadId: "qa-preview-runtime", turnId: "qa-preview-turn", callId: `${namespace}-${tool}`,
            } }, envelope()));
          }
          await handlers.onNotification({ method: "turn/completed", params: { threadId: "qa-preview-runtime",
            turn: { id: "qa-preview-turn", status: "completed", items: [{ type: "agentMessage", id: "fixture-final", phase: "final_answer", text: "Synthetic result." }], error: null } } }, envelope());
        })(); });
        return result;
      },
    };
    mocked.runtime = { config: { installationId: "g03-qa", paths: installationPaths,
      usageLimits: { weeklyTokens: 7_500_000, timeZone: "Europe/Madrid" } }, handle: { roots }, client };
    const supportPreview = { installationId: "g03-qa", userId, sessionHash: "a".repeat(64), supportActorEmail: "operator@example.test",
      supportExpiresAt: "2099-01-01T00:00:00.000Z", publicThreadId: threadId, previewAppId: "00000000-0000-4000-8000-000000000071" };
    try {
      await runWorkerCodexTurn(chatRequest(), "g03-qa", userId, null, {
        tenantId: "g03-qa", mode: "codex", codexBinary: "unused", codexHome: null,
        workspace, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
      }, { ...permissions(), installationId: "g03-qa" }, {} as never, memoryDependencies(), [], new AbortController().signal, async () => {},
        undefined, "AiBrain", null, undefined, undefined, undefined, undefined, false, null, false,
        { businessReads: true, webSearch: true, supportPreview });
      const start = calls.find(({ method }) => method === "thread/start")?.params;
      expect(start).toMatchObject({ permissions: quota.readOnlyId, config: { web_search: "disabled", "features.shell_tool": false,
        "features.apps": false, "mcp_servers.private_mcp.enabled": false } });
      expect((start?.dynamicTools as Array<{ name: string }>).map(tool => tool.name)).toEqual(["aibrain_g03_production"]);
      expect(answers).toHaveLength(5);
      expect(answers).toEqual(Array.from({ length: 5 }, () => expect.objectContaining({ success: false })));
      expect(isActiveBinding).toHaveBeenCalledWith("g03-qa", userId, supportPreview.sessionHash);
      expect(isActiveBinding).toHaveBeenCalledTimes(1);
    } finally {
      lookup.mockRestore();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["Cas completament fictici. Genera un horari per a la Botiga Demo amb sis persones inventades.", true],
    ["Genera un horario real de Girona, excluye PROVA y no amplíes mínimos ficticios.", false],
  ])("applies the invented-schedule template gate only to an affirmative request (%s)", async (message, required) => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-fictional-schedule-"));
    let handlers: { onNotification(value: unknown, envelope: unknown): Promise<void> };
    const events: Array<{ type: string; value?: string; message?: unknown }> = [];
    let sequence = 0;
    const envelope = () => ({ eventId: `fictional-${++sequence}`, sequence,
      occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
    mocked.runtime = {
      config: { installationId, companySlug: "arnall", branding: { productName: "Arnall AI" }, paths: installationPaths },
      handle: { roots: { workspace: root, staging: root, artifacts: root } },
      client: {
        canReuseLoadedThread: () => false,
        connectionSummary: async () => ({ connected: true }),
        router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => {
          handlers = value; return { bindRuntimeTurn() {}, dispose() {} };
        } },
        async request(method: string, _params: unknown, _purpose: string, _timeout: number,
          beforeResolve?: (value: never, event: never) => Promise<void>) {
          const result = method === "thread/start" ? { thread: { id: "fictional-thread" } } : { turn: { id: "fictional-turn" } };
          await beforeResolve?.(result as never, envelope() as never);
          if (method === "turn/start") queueMicrotask(() => { void (async () => {
            await handlers.onNotification({ method: "item/started", params: { item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "" } } }, envelope());
            await handlers.onNotification({ method: "item/agentMessage/delta", params: { itemId: "answer", delta: "Aquí tens la taula sense Excel." } }, envelope());
            await handlers.onNotification({ method: "item/completed", params: { item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Aquí tens la taula sense Excel." } } }, envelope());
            await handlers.onNotification({ method: "turn/completed", params: { turn: { id: "fictional-turn", status: "completed", items: [], error: null } } }, envelope());
          })(); });
          return result;
        },
      },
    };
    const request = { ...chatRequest(), message };
    await runWorkerCodexTurn(request, installationId, userId, null, {
      tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
      workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
    }, permissions(), {} as never, memoryDependencies(), [], new AbortController().signal,
    async (event) => { events.push(event); });
    if (required) {
      expect(events.filter((event) => event.type === "content" || event.type === "delta")).toEqual([]);
      expect(events.find((event) => event.type === "error")?.message).toContain("HORARI SAGARO");
    } else {
      expect(events.some((event) => event.type === "content" || event.type === "delta")).toBe(true);
      expect(events.some((event) => event.type === "error")).toBe(false);
    }
  });

  it.each(["ordinary", "private", "legacy"])("publishes safe prefixes and keeps explicit final over legacy (%s)", async (mode) => {
    const privateRoot = mode === "private";
    const phase = mode === "legacy" ? undefined : "final_answer";
    const root = await mkdtemp(path.join(tmpdir(), privateRoot
      ? 'aibrain "QA_PRIVATE_MARKER" stream-' : "aibrain-r2-stream-"));
    let handlers: { onNotification(value: unknown, envelope: unknown): Promise<void> };
    const events: Array<{ type: string; value?: string }> = [];
    const observations: string[] = [];
    let sequence = 0;
    const envelope = () => ({ eventId: `stream-${++sequence}`, sequence,
      occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
    const text = () => events.reduce((value, event) => event.type === "content"
      ? event.value ?? "" : event.type === "delta" ? value + event.value : value, "");
    const notify = (method: string, item: Record<string, unknown>) => handlers.onNotification({ method,
      params: method === "item/agentMessage/delta"
        ? { threadId: "r2-thread", turnId: "r2-turn", ...item }
        : { threadId: "r2-thread", turnId: "r2-turn", item } }, envelope());
    mocked.runtime = {
      config: { installationId, paths: installationPaths },
      handle: { roots: { workspace: root, staging: root, artifacts: root } },
      client: {
        canReuseLoadedThread: () => false,
        connectionSummary: async () => ({ connected: true }),
        router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => {
          handlers = value; return { bindRuntimeTurn() {}, dispose() {} };
        } },
        async request(method: string, _params: unknown, _purpose: string, _timeout: number,
          beforeResolve?: (value: never, event: never) => Promise<void>) {
          const result = method === "thread/start" ? { thread: { id: "r2-thread" } } : { turn: { id: "r2-turn" } };
          await beforeResolve?.(result as never, envelope() as never);
          if (method === "turn/start") queueMicrotask(() => { void (async () => {
            await notify("item/started", { id: "first", type: "agentMessage", phase, text: "" });
            const chunks = privateRoot ? [...`Archivo ${root}/informe.pdf`] : ["Primera palabra"];
            for (const delta of chunks) await notify("item/agentMessage/delta", { itemId: "first", delta });
            observations.push(text());
            await new Promise((resolve) => setTimeout(resolve, 15));
            await notify("item/agentMessage/delta", { itemId: "first", delta: " segunda palabra" });
            observations.push(text());
            await notify("item/completed", { id: "first", type: "agentMessage", phase, text: "Primera palabra segunda palabra." });
            await notify("item/started", { id: "replacement", type: "agentMessage", phase, text: "" });
            await notify("item/agentMessage/delta", { itemId: "replacement", delta: "Respuesta corregida. " });
            observations.push(text());
            // Missing completion metadata must not erase a known explicit phase.
            await notify("item/completed", { id: "replacement", type: "agentMessage", ...(privateRoot ? {} : { phase }), text: "Respuesta corregida." });
            await notify("item/started", { id: "unclassified", type: "agentMessage", text: "" });
            await notify("item/agentMessage/delta", { itemId: "unclassified", delta: "Unclassified trailing message " });
            await notify("item/completed", { id: "unclassified", type: "agentMessage", text: "Unclassified trailing message" });
            await handlers.onNotification({ method: "turn/completed", params: { threadId: "r2-thread",
              turn: { id: "r2-turn", status: "completed", items: [], error: null } } }, envelope());
          })(); });
          return result;
        },
      },
    };
    await runWorkerCodexTurn(chatRequest(), installationId, userId, null, {
      tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
      workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
    }, permissions(), {} as never, memoryDependencies(), [], new AbortController().signal,
    async (event) => { events.push(event); });
    expect(observations).toEqual(privateRoot
      ? ["Archivo ", "Archivo ./informe.pdf segunda ", "Respuesta corregida. "]
      : ["Primera ", "Primera palabra segunda ", "Respuesta corregida. "]);
    expect(text()).toBe(mode === "legacy" ? "Unclassified trailing message" : "Respuesta corregida.");
    expect(events.filter((event) => event.type === "content" || event.type === "delta")
      .some((event) => event.value?.includes("Unclassified"))).toBe(mode === "legacy");
    expect(events.filter((event) => event.type === "content" || event.type === "delta")
      .map((event) => event.value).join("")).not.toContain("QA_PRIVATE_MARKER");
  });

  beforeEach(() => {
    mocked.startupFailures = 0;
    mocked.runtime = null;
    mocked.maintenanceLease = null;
    mocked.maintenanceReleases = 0;
    mocked.cancelTurn = null;
    mocked.pendingCancellation = false;
    mocked.availableConnectors.mockReset().mockResolvedValue([]);
    mocked.mailCapability.mockReset().mockResolvedValue({ effectiveOperations: ["folders", "list", "search", "read", "attachment", "reply", "draft", "prepare_send", "send", "flags", "move"] });
    mocked.nativeMcpConfig.mockReset().mockResolvedValue({});
    mocked.nativeAppTools.mockReset().mockResolvedValue({});
  });

  it.each(["terminal-snapshot", "empty-terminal", "lost-events", "still-running", "foreign-turn", "racing-terminal"])(
    "persists the real final answer without another model submission (%s)", async (mode) => {
      const root = await mkdtemp(path.join(tmpdir(), "aibrain-completion-loss-"));
      const originalTimeout = globalThis.setTimeout;
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay: number | undefined, ...args: unknown[]) =>
        originalTimeout(callback, delay === 15_000 ? 1 : delay, ...args)) as typeof setTimeout);
      let handlers: { onNotification(value: unknown, event: unknown): Promise<void> };
      let sequence = 0;
      let reads = 0;
      let racingNotification: Promise<void> | null = null;
      const calls: string[] = [];
      const events: Array<{ type: string; value?: string }> = [];
      const envelope = () => ({ eventId: `completion-${++sequence}`, sequence,
        occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
      const items = [
        { type: "userMessage", clientId: userMessageId },
        { type: "agentMessage", id: "comment", phase: "commentary", text: "Working" },
        { type: "agentMessage", id: "final", phase: "final_answer", text: "Verified invoice result." },
      ];
      mocked.runtime = {
        config: { installationId, paths: installationPaths },
        handle: { roots: { workspace: root, staging: root, artifacts: root } },
        client: {
          canReuseLoadedThread: () => false,
          connectionSummary: async () => ({ connected: true }),
          router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => {
            handlers = value; return { bindRuntimeTurn() {}, dispose() {} };
          } },
          async request(method: string, _params: unknown, _purpose: string, _timeout: number,
            beforeResolve?: (value: never, event: never) => Promise<void>) {
            calls.push(method);
            let result: unknown;
            if (method === "thread/start") result = { thread: { id: "completion-thread" } };
            else if (method === "turn/start") result = { turn: { id: "completion-turn" } };
            else if (method === "thread/read") {
              reads += 1;
              const preliminary = reads === 1 && (mode === "still-running" || mode === "foreign-turn");
              result = { thread: { id: "completion-thread", turns: [{
                id: preliminary && mode === "foreign-turn" ? "different-turn" : "completion-turn",
                status: preliminary && mode === "still-running" ? "inProgress" : "completed",
                error: null, items,
              }] } };
              if (preliminary) expect(events.some((event) => event.type === "done")).toBe(false);
            } else throw new Error(`Unexpected request ${method}`);
            await beforeResolve?.(result as never, envelope() as never);
            if (method === "turn/start" && (mode === "terminal-snapshot" || mode === "empty-terminal")) queueMicrotask(() => {
              void handlers.onNotification({ method: "turn/completed", params: {
                threadId: "completion-thread", turn: { id: "completion-turn", status: "completed", error: null,
                  items: mode === "empty-terminal" ? [] : items },
              } }, envelope());
            });
            return result;
          },
        },
      };
      try {
        await runWorkerCodexTurn(chatRequest(), installationId, userId, null, {
          tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
          workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
        }, permissions(), {} as never, memoryDependencies(), [], new AbortController().signal,
        async (event) => {
          events.push(event);
          if (mode === "racing-terminal" && event.type === "content" && !racingNotification) {
            racingNotification = handlers.onNotification({ method: "turn/completed", params: {
              threadId: "completion-thread", turn: { id: "completion-turn", status: "completed", error: null, items },
            } }, envelope());
            await new Promise((resolve) => originalTimeout(resolve, 1));
          }
        });
        if (racingNotification) await racingNotification;
        expect(events.reduce((text, event) => event.type === "content" ? event.value ?? "" :
          event.type === "delta" ? text + event.value : text, "")).toBe("Verified invoice result.");
        expect(events.filter((event) => event.type === "done")).toHaveLength(1);
        expect(calls.filter((method) => method === "turn/start")).toHaveLength(1);
        expect(calls).not.toContain("turn/interrupt");
        if (mode === "still-running" || mode === "foreign-turn") expect(reads).toBe(2);
      } finally {
        timeoutSpy.mockRestore();
      }
    },
  );

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["agent", "ask", "denied", "preparing", "raced", "unknown"] as const)("makes verified connections available with %s turn permissions and refreshes after reconnect", async (nativeMode) => {
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-automatic-connectors-"));
    const { mkdir, rm } = await import("node:fs/promises");
    const workspace = path.join(userRoot, "workspace"), staging = path.join(userRoot, "staging");
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(staging, "threads"), { recursive: true });
    const resources = [GMAIL_CATALOG_RESOURCE, OUTLOOK_CATALOG_RESOURCE, MAIL_CATALOG_RESOURCE, {
      id: "qa-native-app", label: "QA Files", kind: "app" as const, credentialMode: "personal-oauth" as const,
      managedBy: "company" as const, sharedResource: false, appId: "qa-files", connectorId: null, mcp: null,
    }];
    const available = resources.map<ResolvedConnectorMention>(resource => ({
      resource,
      mention: { id: resource.id, label: resource.label, kind: resource.kind as "app" | "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: false },
    }));
    mocked.availableConnectors.mockResolvedValue(available);
    const numericPolicy = { "qa-files": { allowed: ["search"], known: ["search"], numericBounds: {
      search: { tool: "files.search", parameters: [{ schemaPath: "/properties/limit", maximum: 10 }] },
    } } };
    mocked.nativeAppTools.mockResolvedValue(numericPolicy);
    let ready: (() => void) | undefined;
    if (nativeMode === "preparing") mocked.nativeAppTools.mockImplementationOnce(() => new Promise(resolve => {
      ready = () => resolve({ "qa-files": { allowed: ["search"], known: ["search"] } });
    }));
    if (nativeMode === "raced") mocked.nativeAppTools.mockResolvedValue({ "qa-files": { allowed: [], known: ["search"] } });
    if (nativeMode === "unknown") mocked.availableConnectors.mockRejectedValue(Object.assign(new Error("Connections preparing"), { code: "NATIVE_APP_READINESS_UNAVAILABLE" }));
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let handlers: { onNotification(value: unknown, envelope: unknown): Promise<void> };
    let sequence = 0;
    const envelope = () => ({ eventId: `automatic-connectors-${++sequence}`, sequence, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
    const completedTurns: Array<Record<string, unknown>> = [];
    const client = {
      canReuseLoadedThread: () => true,
      router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => { handlers = value; return { bindRuntimeTurn() {}, dispose() {} }; } },
      connectionSummary: async () => ({ connected: true }), resolvedSkills: async () => [],
      async request(method: string, params: Record<string, unknown>, _purpose: string, _timeout: number, beforeResolve?: (value: never, event: never) => Promise<void>) {
        calls.push({ method, params });
        const turn = { id: `automatic-turn-${completedTurns.length + 1}`, status: "completed", error: null, items: [
          { type: "userMessage", id: `automatic-input-${completedTurns.length + 1}`, clientId: params.clientUserMessageId, content: [] },
          { type: "agentMessage", id: `automatic-answer-${completedTurns.length + 1}`, phase: "final_answer", text: "Verified connection inventory." },
        ] };
        const result = method === "thread/turns/list" ? { data: [...completedTurns].reverse(), nextCursor: null }
          : method.startsWith("thread/") ? { thread: { id: "automatic-thread", turns: [...completedTurns] } }
          : { turn: { id: turn.id } };
        await beforeResolve?.(result as never, envelope() as never);
        if (method === "turn/start") {
          completedTurns.push(turn);
          queueMicrotask(() => { void handlers.onNotification({ method: "turn/completed", params: {
            threadId: "automatic-thread", turn,
          } }, envelope()); });
        }
        return result;
      },
    };
    mocked.runtime = { config: { installationId, paths: installationPaths, connectors: { mail: { enabled: true, provider: "nominalia" } } }, handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } }, client };
    const session = { provider: "local", tenant: { id: installationId }, user: { id: userId }, expiresAt: new Date(Date.now() + 3600000).toISOString() } as AuthSession;
    const request = chatRequest();
    request.message = "Find the project files and the latest message from the customer";
    request.options.mode = nativeMode === "ask" ? "ask" : "agent";
    const nativeAllowed = nativeMode !== "denied";
    const nativeRule = { ruleId: "tools.execute", action: "execute" as const, effect: nativeAllowed ? "allow" as const : "deny" as const, instruction: "Synthetic turn execution policy", sourceScope: "installation" as const, sourcePolicyVersion: 1, precedence: 100 };
    expect(request.options.connectorMentions).toBeUndefined();
    const events: Array<Record<string, unknown>> = [];
    const run = (value: ChatRequest, runtimeThreadId: string | null) => runWorkerCodexTurn(value, installationId, userId, runtimeThreadId, {
      tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null, workspace, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
    }, { ...permissions([nativeRule]), turnId: value.assistantMessageId }, {} as never, memoryDependencies(), [], new AbortController().signal, async event => { events.push(event); }, undefined, "Assistant", null, undefined, undefined, undefined, session);
    try {
      const first = run(request, null);
      if (nativeMode === "unknown" || nativeMode === "raced") {
        await expect(first).rejects.toMatchObject({ code: "NATIVE_APP_READINESS_UNAVAILABLE" });
        expect(calls).toEqual([]); // Neither thread/start nor turn/start can admit a missing toolset.
        return;
      }
      if (nativeMode === "preparing") {
        await vi.waitFor(() => expect(ready).toBeTypeOf("function"));
        expect(calls).toEqual([]);
        ready!();
      }
      await first;
      expect(mocked.availableConnectors).toHaveBeenCalledExactlyOnceWith(installationId, userId, [], session, expect.any(Function));
      expect(calls.map(({ method }) => method)).toEqual(["thread/start", "turn/start"]);
      const params = calls[0].params;
      expect(params.config).toMatchObject({ web_search: "live", apps: {
        _default: { enabled: false, destructive_enabled: false, open_world_enabled: false },
        "qa-files": { enabled: nativeAllowed, destructive_enabled: false, open_world_enabled: false, default_tools_approval_mode: "writes",
          default_tools_enabled: false, tools: { search: { enabled: nativeAllowed } } },
      } });
      expect(Object.keys((params.config as { apps: object }).apps).sort()).toEqual(["_default", "qa-files"]);
      const nativeMentions = (value: typeof calls[number]) => (value.params.input as Array<{ type: string }>).filter(item => item.type === "mention");
      expect(nativeMentions(calls[1])).toEqual(nativeAllowed ? [{ type: "mention", name: "QA Files", path: "app://qa-files" }] : []);
      expect(params.dynamicTools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "aibrain_gmail" }), expect.objectContaining({ name: "aibrain_outlook" }), expect.objectContaining({ name: "aibrain_mail" }),
      ]));
      expect(params.developerInstructions).toContain("Conexiones disponibles automáticamente");
      expect(params.developerInstructions).toContain("aunque el usuario no las mencione ni las seleccione");
      expect(params.developerInstructions).toContain("No exijas @");
      for (const resource of resources) expect(params.developerInstructions).toContain(`"id":"${resource.id}"`);
      if (nativeAllowed && nativeMode !== "preparing") {
        expect(params.developerInstructions).toContain('"tool":"files.search"');
        expect(params.developerInstructions).toContain('"maximum":10');
      } else expect(params.developerInstructions).not.toContain("Native tool numeric inputSchema data");
      expect(events).toContainEqual({ type: "done" });

      expect(mocked.nativeAppTools).toHaveBeenLastCalledWith(client, expect.any(Function), nativeAllowed ? ["qa-files"] : [], expect.any(String), nativeAllowed && nativeMode !== "ask", {});
      expect(mocked.nativeMcpConfig).toHaveBeenLastCalledWith(client, expect.any(Function), new Set(), expect.any(String), nativeAllowed && nativeMode !== "ask");
      mocked.availableConnectors.mockResolvedValue([]);
      mocked.nativeAppTools.mockResolvedValue({ "qa-files": { allowed: [], known: ["search"] } });
      await run({ ...request, userMessageId: "00000000-0000-4000-8000-000000000032", assistantMessageId: "00000000-0000-4000-8000-000000000042" }, "automatic-thread");
      expect(calls[2]).toMatchObject({ method: "thread/resume", params: {
        threadId: "automatic-thread", config: { apps: { _default: { enabled: false } } },
      } });
      expect((calls[2].params.config as { apps: object }).apps).toMatchObject({ "qa-files": { enabled: false, tools: { search: { enabled: false } } } });
      expect(calls[2].params.developerInstructions).not.toContain("Native tool numeric inputSchema data");
      expect(nativeMentions(calls[3])).toEqual([]);

      mocked.availableConnectors.mockResolvedValue(available);
      mocked.nativeAppTools.mockResolvedValue({ "qa-files": { allowed: ["search"], known: ["search"] } });
      await run({ ...request, userMessageId: "00000000-0000-4000-8000-000000000033", assistantMessageId: "00000000-0000-4000-8000-000000000043" }, "automatic-thread");
      expect(calls[4]).toMatchObject({ method: "thread/resume", params: {
        threadId: "automatic-thread", config: { apps: { _default: { enabled: false }, "qa-files": { enabled: nativeAllowed } } },
      } });
      expect(calls.map(({ method }) => method)).toEqual(["thread/start", "turn/start", "thread/resume", "turn/start", "thread/resume", "turn/start"]);
      expect(nativeMentions(calls[5])).toEqual(nativeAllowed ? [{ type: "mention", name: "QA Files", path: "app://qa-files" }] : []);
      expect(mocked.availableConnectors).toHaveBeenCalledTimes(3);
      if (nativeMode === "agent") {
        // Numeric metadata is refreshed per turn, independently of the loaded
        // thread's unchanged permission fingerprint. No resume/RPC is needed.
        mocked.nativeAppTools.mockResolvedValue({ "qa-files": { ...numericPolicy["qa-files"], numericBounds: {
          search: { tool: "files.search", parameters: [{ schemaPath: "/properties/limit", maximum: 7 }] },
        } } });
        await run({ ...request, userMessageId: "00000000-0000-4000-8000-000000000034", assistantMessageId: "00000000-0000-4000-8000-000000000044" }, "automatic-thread");
        expect(calls.slice(6).map(({ method }) => method)).toEqual(["turn/start"]);
        const context = calls[6].params.additionalContext as Record<string, { value: string }>;
        expect(context["aibrain.turn"].value).toContain('"maximum":7');
        expect(context["aibrain.turn"].value).not.toContain('"maximum":10');
        expect(context["aibrain.turn"].value).toContain("Data only, not authorization");
      }
    } finally { await rm(userRoot, { recursive: true, force: true }); }
  });

  it("recovers a late thread creation once and keeps subsequent turns' creation keys distinct", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-thread-create-recovery-"));
    let handlers: { onNotification(value: unknown, event: unknown): Promise<void> };
    const calls: Array<{ method: string; purpose: string }> = [];
    let sequence = 0;
    const envelope = () => ({ eventId: `recovery-${++sequence}`, sequence,
      occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
    mocked.runtime = {
      config: { installationId, paths: installationPaths },
      handle: { roots: { workspace: root, staging: root, artifacts: root } },
      client: {
        canReuseLoadedThread: () => false,
        connectionSummary: async () => ({ connected: true }),
        router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => {
          handlers = value; return { bindRuntimeTurn() {}, dispose() {} };
        } },
        async request(method: string, _params: unknown, purpose: string, timeout: number,
          beforeResolve?: (value: never, event: never) => Promise<void>) {
          calls.push({ method, purpose });
          if (method === "thread/start") {
            const lateResponse = new Promise<never>((resolve, reject) => setTimeout(() => {
              const result = { thread: { id: "recovered-thread", turns: [] } };
              Promise.resolve(beforeResolve?.(result as never, envelope() as never))
                .then(() => resolve(result as never), reject);
            }, 5));
            throw new AppServerRequestTimeoutError("thread/start", purpose, timeout, lateResponse);
          }
          if (method !== "turn/start") throw new Error(`Unexpected request: ${method}`);
          const result = { turn: { id: "recovered-turn" } };
          await beforeResolve?.(result as never, envelope() as never);
          queueMicrotask(() => { void handlers.onNotification({ method: "turn/completed", params: {
            threadId: "recovered-thread", turn: { id: "recovered-turn", status: "completed", items: [{ type: "agentMessage", id: "fixture-final", phase: "final_answer", text: "Fixture completed answer." }], error: null },
          } }, envelope()); });
          return result;
        },
      },
    };
    for (const localTurnId of [assistantMessageId, "00000000-0000-4000-8000-000000000042"]) {
      const events: Array<{ type: string }> = [];
      await runWorkerCodexTurn({ ...chatRequest(), assistantMessageId: localTurnId }, installationId, userId, null, {
        tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
        workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
      }, { ...permissions(), turnId: localTurnId }, {} as never, memoryDependencies(), [], new AbortController().signal,
      async event => { events.push(event); });
      expect(events.filter(event => event.type === "runtimeThread")).toHaveLength(1);
      expect(events.some(event => event.type === "done")).toBe(true);
      expect(events.some(event => event.type === "error")).toBe(false);
    }
    expect(calls.filter(call => call.method === "thread/start").map(call => call.purpose)).toEqual([
      `thread-start:${assistantMessageId}`, "thread-start:00000000-0000-4000-8000-000000000042",
    ]);
    expect(calls.filter(call => call.method === "turn/start")).toHaveLength(2);
  });

  it.each(["direct-invalid-request", "direct-invalid-params", "late", "recovered"])(
    "closes a confirmed pre-creation rejection %s and never replays it on reconnect", async mode => {
      const root = await mkdtemp(path.join(tmpdir(), "aibrain-thread-rejected-"));
      const calls: string[] = [];
      let recoveries = 0;
      const purpose = `thread-start:${assistantMessageId}`;
      const message = "Invalid request: unknown variant ``, expected user/auto_review/guardian_subagent\n\tin apps._default.approvals_reviewer";
      const failure = () => new AppServerRpcResponseError("thread/start", purpose, { code: mode === "direct-invalid-params" ? -32602 : -32600, message });
      const run = (recoveryOnly = false) => {
        mocked.runtime = {
          config: { installationId, paths: installationPaths },
          handle: { roots: { userRoot: root, workspace: root, staging: root, artifacts: root } },
          client: {
            connectionSummary: async () => ({ connected: true }),
            async request(method: string, _params: unknown, requestPurpose: string, timeout: number) {
              calls.push(method);
              expect(method).toBe("thread/start"); expect(requestPurpose).toBe(purpose);
              if (mode === "late" || mode === "recovered") {
                const lateError = mode === "late" ? failure() : new AppServerRequestTimeoutError("thread/start", purpose, timeout, new Promise(() => {}));
                throw new AppServerRequestTimeoutError("thread/start", purpose, timeout, Promise.reject(lateError));
              }
              throw failure();
            },
            async recoverThreadStart(_params: unknown, requestPurpose: string) {
              recoveries += 1; expect(requestPurpose).toBe(purpose); throw failure();
            },
          },
        };
        return runWorkerCodexTurn(chatRequest(), installationId, userId, null, {
          tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
          workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
        }, permissions(), {} as never, memoryDependencies(), [], new AbortController().signal,
        async () => {}, undefined, undefined, null, undefined, undefined, undefined, undefined, false, null, recoveryOnly);
      };
      try {
        if (mode === "recovered") await expect(run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
        await expect(run(mode === "recovered")).rejects.toBeInstanceOf(WorkerThreadStartRejectedError);
        const file = path.join(root, "state", "turn-submissions", threadId, `${assistantMessageId}.json`);
        const saved = JSON.parse(await readFile(file, "utf8"));
        expect(saved).toMatchObject({ phase: "terminal", terminal: "failed", runtimeThreadId: null, runtimeTurnId: null, turnRequest: null });
        expect(JSON.parse(saved.threadRequest).id).toBe(purpose);
        const beforeReconnect = await readFile(file, "utf8");
        await expect(run(true)).rejects.toMatchObject({ code: "THREAD_START_REJECTED" });
        expect(await readFile(file, "utf8")).toBe(beforeReconnect);
        expect(calls).toEqual(["thread/start"]);
        expect(recoveries).toBe(mode === "recovered" ? 1 : 0);
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );

  it("settles the same stopped pre-creation admission from its COMPLETED rejection without replay or streaming", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-stopped-rejection-"));
    const usersRoot = path.join(root, "users");
    const userRoot = path.join(usersRoot, userId);
    const workspace = path.join(userRoot, "workspace");
    const projections = new FileTurnProjectionStore({ installationId, userId, usersRoot });
    const initial = { id: assistantMessageId, role: "assistant" as const, content: "", createdAt: new Date().toISOString(),
      status: "streaming" as const, activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [] };
    const calls: string[] = [];
    const purpose = `thread-start:${assistantMessageId}`;
    const completed = { id: purpose, error: { code: -32600, message: "Invalid request\nin apps._default.approvals_reviewer" } };
    const recoverThreadStart = vi.fn(async () => { throw new AppServerRpcResponseError("thread/start", completed.id, completed.error); });
    const client = {
      connectionSummary: async () => ({ connected: true }), recoverThreadStart,
      async request(method: string) {
        calls.push(method);
        const late = Promise.reject(new AppServerRequestTimeoutError("thread/start", purpose, 120_000, new Promise(() => {})));
        void late.catch(() => {});
        throw new AppServerRequestTimeoutError("thread/start", purpose, 60_000, late);
      },
    };
    const emit = async (event: WorkerCodexTurnEvent) => {
      if (event.type === "runtimeThread" || event.type === "runtimeTurn" || event.type === "runtimeUsage") throw new Error("No remote identity exists.");
      await projections.applyLocalEvent(threadId, assistantMessageId, event);
    };
    const run = (recover = false, queue = false) => {
      mocked.runtime = { config: { installationId, paths: { ...installationPaths, ...(queue ? { dataRoot: root } : {}) } },
        handle: { roots: { userRoot, workspace, staging: workspace, artifacts: workspace } }, client };
      return runWorkerCodexTurn(chatRequest(), installationId, userId, null, {
        tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
        workspace, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
      }, permissions(), {} as never, memoryDependencies(), [], new AbortController().signal, emit,
      undefined, undefined, null, undefined, undefined, undefined, undefined, false, null, recover);
    };
    try {
      await mkdir(usersRoot, { recursive: true, mode: 0o700 });
      await mkdir(userRoot, { mode: 0o700 });
      await mkdir(workspace, { mode: 0o700 });
      await projections.initialize(threadId, initial);
      await expect(run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
      await cancelPendingWorkerTurn({ installationId, userId, runtimeThreadId: null },
        { action: "stop", threadId, assistantMessageId, clientRequestId: userMessageId }, emit);
      const requested = await projections.read(threadId, assistantMessageId);
      expect(requested).toMatchObject({ runtimeThreadToken: null, runtimeTurnId: null, message: { status: "streaming" } });
      expect(requested?.message.activity).toContainEqual(expect.objectContaining({ id: `stop:${userMessageId}`, label: "Aturada sol·licitada" }));
      const file = path.join(userRoot, "state", "turn-submissions", threadId, `${assistantMessageId}.json`);
      const originalIntent = JSON.parse(await readFile(file, "utf8")).threadRequest;
      // The API projects this terminal error through applyLocalEvent. The real
      // worker, control, durable submission and projection store run here.
      const failure = await run(true, true).then(() => null, error => error);
      expect(failure).toBeInstanceOf(WorkerThreadStartRejectedError);
      await projections.applyLocalEvent(threadId, assistantMessageId, { type: "error", message: failure.message });
      const terminal = await projections.read(threadId, assistantMessageId);
      expect(terminal).toMatchObject({ runtimeThreadToken: null, runtimeTurnId: null, message: { status: "error" } });
      expect(terminal?.message.activity).toContainEqual(expect.objectContaining({ id: `stop:${userMessageId}` }));
      const saved = JSON.parse(await readFile(file, "utf8"));
      expect(saved).toMatchObject({ phase: "terminal", terminal: "failed", threadRequest: originalIntent,
        runtimeThreadId: null, runtimeTurnId: null, turnRequest: null });
      await expect(run(true, true)).rejects.toBeInstanceOf(WorkerThreadStartRejectedError);
      expect(await projections.read(threadId, assistantMessageId)).toMatchObject({
        threadId, assistantMessageId, runtimeThreadToken: null, runtimeTurnId: null, message: terminal!.message,
      });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(saved);
      expect(recoverThreadStart).toHaveBeenCalledOnce();
      expect(calls).toEqual(["thread/start"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["uncorrelated", "initialization", "generic-code", "server-error"])(
    "keeps uncertain pre-creation %s failures recoverable without replay", async mode => {
      const root = await mkdtemp(path.join(tmpdir(), "aibrain-thread-uncertain-"));
      const purpose = `thread-start:${assistantMessageId}`;
      const calls: string[] = [];
      mocked.runtime = {
        config: { installationId, paths: installationPaths },
        handle: { roots: { userRoot: root, workspace: root, staging: root, artifacts: root } },
        client: {
          connectionSummary: async () => ({ connected: true }),
          async request(method: string) {
            calls.push(method);
            if (mode === "generic-code") throw Object.assign(new Error("local failure"), { code: -32600 });
            throw new AppServerRpcResponseError(mode === "initialization" ? "initialize" : "thread/start",
              mode === "uncorrelated" ? "foreign-request" : purpose, { code: mode === "server-error" ? -32603 : -32600, message: "unconfirmed outcome" });
          },
        },
      };
      try {
        await expect(runWorkerCodexTurn(chatRequest(), installationId, userId, null, {
          tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
          workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
        }, permissions(), {} as never, memoryDependencies(), [], new AbortController().signal, async () => {}))
          .rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
        const saved = JSON.parse(await readFile(path.join(root, "state", "turn-submissions", threadId, `${assistantMessageId}.json`), "utf8"));
        expect(saved.terminal).toBeNull(); expect(saved.runtimeThreadId).toBeNull(); expect(saved.turnRequest).toBeNull();
        expect(JSON.parse(saved.threadRequest).id).toBe(purpose); expect(calls).toEqual(["thread/start"]);
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );

  it("keeps an admitted thread-open timeout recoverable without submitting or duplicating a model turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-thread-open-failed-"));
    const calls: string[] = [];
    mocked.runtime = {
      config: { installationId, paths: installationPaths },
      handle: { roots: { workspace: root, staging: root, artifacts: root } },
      client: {
        connectionSummary: async () => ({ connected: true }),
        async request(method: string, _params: unknown, purpose: string, timeout: number) {
          calls.push(method);
          const lateError = new AppServerRequestTimeoutError("thread/start", purpose, timeout, new Promise(() => {}));
          const lateResponse = Promise.reject(lateError);
          throw new AppServerRequestTimeoutError("thread/start", purpose, timeout, lateResponse);
        },
      },
    };
    const failure = runWorkerCodexTurn(chatRequest(), installationId, userId, null, {
      tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
      workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
    }, permissions(), {} as never, memoryDependencies(), [], new AbortController().signal, async () => {});
    await expect(failure).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
    expect(calls).toEqual(["thread/start"]);
  });

  it("recovers creation beyond both deadlines across reconnects and dispatches the admitted turn only once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-expired-creation-"));
    const calls: string[] = [];
    const recoveries: Array<{ params: unknown; purpose: string }> = [];
    let originalParams: unknown;
    let creationCompleted = false;
    let turnDispatched = false;
    let sequence = 0;
    const envelope = () => ({ eventId: `restart-${++sequence}`, sequence,
      occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
    const makeClient = () => ({
      canReuseLoadedThread: () => false,
      connectionSummary: async () => ({ connected: true }),
      router: { registerTurn: () => ({ bindRuntimeTurn() {}, dispose() {} }) },
      async recoverThreadStart(params: unknown, purpose: string) {
        recoveries.push({ params, purpose });
        expect(params).toEqual(originalParams);
        expect(purpose).toBe(`thread-start:${assistantMessageId}`);
        return creationCompleted ? { thread: { id: "original-thread", turns: [] } } : null;
      },
      async request(method: string, params: unknown, purpose: string, timeout: number,
        beforeResolve?: (value: never, event: never) => Promise<void>) {
        calls.push(method);
        if (method === "thread/start") {
          originalParams = params;
          throw new AppServerRequestTimeoutError(method, purpose, timeout);
        }
        if (method === "thread/turns/list") return { data: [], nextCursor: null };
        if (method === "thread/resume") {
          const result = { thread: { id: "original-thread", turns: turnDispatched ? [{
            id: "original-turn", status: "completed", error: null,
            items: [{ type: "userMessage", clientId: userMessageId, id: "user-item", content: [] },
              { type: "agentMessage", id: "answer", text: "Recovered answer", phase: "final_answer" }],
          }] : [] } };
          await beforeResolve?.(result as never, envelope() as never);
          return result;
        }
        if (method === "turn/start") {
          expect(turnDispatched).toBe(false);
          turnDispatched = true;
          throw new Error("App restart after remote model submission, before acknowledgement");
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    });
    const events: Array<{ type: string; value?: string }> = [];
    const run = (recoveryOnly: boolean) => {
      // Each attempt has a fresh client; only the receipt and gateway evidence survive.
      mocked.runtime = { config: { installationId, paths: installationPaths },
        handle: { roots: { userRoot: root, workspace: root, staging: root, artifacts: root } }, client: makeClient() };
      return runWorkerCodexTurn(chatRequest(), installationId, userId, null, {
        tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
        workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
      }, permissions(), {} as never, memoryDependencies(), [], new AbortController().signal,
      async event => { events.push(event); }, undefined, undefined, null, undefined, undefined,
      undefined, undefined, false, null, recoveryOnly);
    };
    await expect(run(false)).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
    await expect(run(true)).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
    expect(calls).toEqual(["thread/start"]);
    creationCompleted = true;
    await expect(run(true)).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
    const receipt = JSON.parse(await readFile(path.join(root, "state", "turn-submissions", threadId, `${assistantMessageId}.json`), "utf8"));
    expect(receipt).toMatchObject({ runtimeThreadId: "original-thread", phase: "dispatched" });
    await run(true);
    expect(calls.filter(method => method === "thread/start")).toHaveLength(1);
    expect(calls.filter(method => method === "turn/start")).toHaveLength(1);
    expect(recoveries).toHaveLength(2);
    expect(events.filter(event => event.type === "done")).toHaveLength(1);
    expect(events.some(event => event.type === "content" && event.value === "Recovered answer")).toBe(true);
  });

  it("uses a bounded configurable lifetime for every worker turn", () => {
    expect(workerTurnTimeoutMs({})).toBe(30 * 60_000);
    expect(workerTurnTimeoutMs({ AIBRAIN_WORKER_TURN_TIMEOUT_MS: " " })).toBe(30 * 60_000);
    expect(workerTurnTimeoutMs({ AIBRAIN_WORKER_TURN_TIMEOUT_MS: "30000" })).toBe(30_000);
    expect(workerTurnTimeoutMs({ AIBRAIN_WORKER_TURN_TIMEOUT_MS: "1800000" })).toBe(1_800_000);
    expect(() => workerTurnTimeoutMs({ AIBRAIN_WORKER_TURN_TIMEOUT_MS: "29999" })).toThrow(/between/u);
    expect(() => workerTurnTimeoutMs({ AIBRAIN_WORKER_TURN_TIMEOUT_MS: "1800001" })).toThrow(/between/u);
    expect(() => workerTurnTimeoutMs({ AIBRAIN_WORKER_TURN_TIMEOUT_MS: "secret" })).toThrow(/invalid/u);
  });

  it("uses a short bounded reconciliation grace after local document tools", () => {
    expect(documentToolTerminalGraceMs({})).toBe(45_000);
    expect(documentToolTerminalGraceMs({ AIBRAIN_DOCUMENT_TOOL_TERMINAL_GRACE_MS: "1000" })).toBe(1_000);
    expect(documentToolTerminalGraceMs({ AIBRAIN_DOCUMENT_TOOL_TERMINAL_GRACE_MS: "120000" })).toBe(120_000);
    expect(documentToolTerminalGraceMs({ AIBRAIN_DOCUMENT_TOOL_TERMINAL_GRACE_MS: "999" })).toBe(45_000);
    expect(documentToolTerminalGraceMs({ AIBRAIN_DOCUMENT_TOOL_TERMINAL_GRACE_MS: "secret" })).toBe(45_000);
  });

  it("creates four local formats in one tool call, projects one card per file and closes with no private path", async () => {
    const userRoot = await mkdtemp(path.join(tmpdir(), 'aibrain "QA_PRIVATE_MARKER" document-batch-'));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.join(staging, "threads"), { recursive: true, mode: 0o700 });
    });
    let handlers: {
      onNotification(value: unknown, envelope: unknown): Promise<void> | void;
      onServerRequest(value: unknown, envelope: unknown): Promise<unknown> | unknown;
    } | null = null;
    const calls: string[] = [];
    const envelope = (eventId: string, sequence: number) => ({
      eventId,
      sequence,
      occurredAt: new Date().toISOString(),
      message: { kind: "rpc-notification", rpc: {} },
    });
    const client = {
      router: {
        registerTurn(_runtimeThreadId: string, _localTurnId: string, value: typeof handlers) {
          handlers = value;
          return { bindRuntimeTurn() {}, dispose() {} };
        },
      },
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: true,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async resolvedSkills() { return []; },
      async request(
        method: string,
        _params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        calls.push(method);
        if (method === "thread/start") {
          const result = { thread: { id: "runtime-thread-documents", turns: [] } };
          await beforeResolve?.(result as never, envelope("documents-thread", 1) as never);
          return result;
        }
        if (method === "turn/start") {
          const result = { turn: { id: "runtime-turn-documents" } };
          await beforeResolve?.(result as never, envelope("documents-turn", 2) as never);
          queueMicrotask(() => {
            void (async () => {
              if (!handlers) throw new Error("Turn handlers were not registered.");
              const toolResult = await handlers.onServerRequest({
                method: "item/tool/call",
                id: "document-batch-request",
                params: {
                  threadId: "runtime-thread-documents",
                  turnId: "runtime-turn-documents",
                  callId: "document-batch-call",
                  namespace: "aibrain_documents",
                  tool: "create_batch",
                  arguments: {
                    files: (["pdf", "docx", "pptx", "xlsx"] as const).map((format) => ({
                      format,
                      fileName: `hello-world.${format}`,
                      title: "Hello world",
                      content: "Hello world",
                      ...(format === "xlsx" ? { rows: [["Message"], ["Hello world"]] } : {}),
                    })),
                  },
                },
              }, envelope("documents-tool-request", 3));
              const privatePath = path.join(
                workspace,
                "projects",
                projectId,
                "documents",
                "hello-world.pdf",
              );
              await handlers.onNotification({
                method: "item/completed",
                params: {
                  threadId: "runtime-thread-documents",
                  turnId: "runtime-turn-documents",
                  item: {
                    id: "document-batch-call",
                    type: "dynamicToolCall",
                    namespace: "aibrain_documents",
                    tool: "create_batch",
                    status: "completed",
                    aggregatedOutput: privatePath,
                    ...(toolResult as Record<string, unknown>),
                  },
                },
              }, envelope("documents-tool-completed", 4));
              await handlers.onNotification({
                method: "item/started",
                params: {
                  threadId: "runtime-thread-documents",
                  turnId: "runtime-turn-documents",
                  item: { id: "documents-final", type: "agentMessage", phase: "final_answer", text: "" },
                },
              }, envelope("documents-final-started", 5));
              await handlers.onNotification({
                method: "item/agentMessage/delta",
                params: {
                  threadId: "runtime-thread-documents",
                  turnId: "runtime-turn-documents",
                  itemId: "documents-final",
                  delta: `Listo: ${privatePath}`,
                },
              }, envelope("documents-final-delta", 6));
              await handlers.onNotification({
                method: "item/completed",
                params: {
                  threadId: "runtime-thread-documents",
                  turnId: "runtime-turn-documents",
                  item: {
                    id: "documents-final",
                    type: "agentMessage",
                    phase: "final_answer",
                    status: "completed",
                    text: `Listo: ${privatePath}`,
                  },
                },
              }, envelope("documents-final", 7));
              await handlers.onNotification({
                method: "turn/completed",
                params: {
                  threadId: "runtime-thread-documents",
                  turn: { id: "runtime-turn-documents", status: "completed", items: [], error: null },
                },
              }, envelope("documents-completed", 8));
            })();
          });
          return result;
        }
        throw new Error(`Unexpected request ${method} (${purpose})`);
      },
    };
    mocked.runtime = {
      config: { installationId, paths: { ...installationPaths, dataRoot: userRoot } },
      handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } },
      client,
    };
    const events: Array<Record<string, unknown>> = [];
    const request = chatRequest();
    request.message = "Genera PDF, DOCX, PPTX y XLSX que digan hello world";

    await runWorkerCodexTurn(
      request,
      installationId,
      userId,
      null,
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/legacy-must-not-be-used",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions([{
        ruleId: "tools.execute",
        action: "execute",
        effect: "allow",
        instruction: "Create local documents.",
        sourceScope: "installation",
        sourcePolicyVersion: 1,
        precedence: 100,
      }]),
      {} as never,
      memoryDependencies(),
      [],
      new AbortController().signal,
      async (event) => { events.push(event); },
    );

    const artifacts = events.filter((event) => event.type === "artifact");
    expect(artifacts).toHaveLength(4);
    expect(new Set(artifacts.map((event) => (event.item as { id: string }).id))).toHaveProperty("size", 4);
    expect(artifacts.map((event) => (event.item as { kind: string }).kind)).toEqual(["pdf", "docx", "pptx", "xlsx"]);
    const finalContent = events.filter((event) => event.type === "delta");
    expect(finalContent.map((event) => event.value).join("")).toBe("Listo: ./documents/hello-world.pdf");
    expect(finalContent[0]).toEqual({ type: "delta", value: "Listo: " });
    expect(events.filter((event) => event.type === "content" || event.type === "delta")
      .map((event) => event.value).join("")).not.toContain("QA_PRIVATE_MARKER");
    expect(JSON.stringify(events)).not.toContain(userRoot);
    expect(events).toContainEqual({ type: "done" });
    expect(calls).toEqual(["thread/start", "turn/start"]);
  }, 30_000);

  it("keeps live web search without exposing computer use for a current Arnall query", async () => {
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-worker-turn-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    const documentPath = path.join(staging, "threads", threadId, "uploads", documentUploadId, "notes.txt");
    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.dirname(documentPath), { recursive: true, mode: 0o700 });
      await writeFile(documentPath, "Attachment text\n", { mode: 0o600 });
    });
    let handlers: {
      onNotification(value: unknown, envelope?: unknown): Promise<void> | void;
      onFailure(error: Error): void;
    } | null = null;
    let boundTurn: string | null = null;
    const calls: Array<{ method: string; params: unknown; purpose: string }> = [];
    const router = {
      registerTurn(runtimeThreadId: string, localTurnId: string, value: typeof handlers) {
        expect(runtimeThreadId).toBe("runtime-thread-1");
        expect(localTurnId).toBe(assistantMessageId);
        handlers = value;
        return {
          threadId: runtimeThreadId,
          localTurnId,
          bindRuntimeTurn(turnId: string) { boundTurn = turnId; },
          dispose() {},
        };
      },
    };
    let modelCatalogCalls = 0;
    const client = {
      router,
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: false,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async connection() {
        modelCatalogCalls += 1;
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: true,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async capabilities() { return { webSearch: true, imageGeneration: false }; },
      async resolvedSkills() { return []; },
      async request(
        method: string,
        params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        calls.push({ method, params, purpose });
        if (method === "thread/start") {
          const result = { thread: { id: "runtime-thread-1" } };
          await beforeResolve?.(result as never, {
            eventId: "response-thread",
            sequence: 1,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          return result;
        }
        if (method === "turn/start") {
          const result = { turn: { id: "runtime-turn-1" } };
          await beforeResolve?.(result as never, {
            eventId: "response-turn",
            sequence: 2,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          queueMicrotask(() => {
            void (async () => {
              await handlers?.onNotification({
                method: "turn/started",
                params: {
                  threadId: "runtime-thread-1",
                  turn: { id: "runtime-turn-1", status: "inProgress", items: [], error: null },
                },
              });
              await handlers?.onNotification({
                method: "item/reasoning/summaryPartAdded",
                params: {
                  threadId: "runtime-thread-1",
                  turnId: "runtime-turn-1",
                  itemId: "reasoning-1",
                  summaryIndex: 0,
                },
              });
              await handlers?.onNotification({
                method: "item/reasoning/textDelta",
                params: {
                  threadId: "runtime-thread-1",
                  turnId: "runtime-turn-1",
                  itemId: "reasoning-1",
                  delta: "private reasoning must not be exposed",
                  contentIndex: 0,
                },
              });
              await handlers?.onNotification({
                method: "item/reasoning/summaryTextDelta",
                params: {
                  threadId: "runtime-thread-1",
                  turnId: "runtime-turn-1",
                  itemId: "reasoning-1",
                  delta: "Analitzant la petició",
                  summaryIndex: 0,
                },
              });
              await handlers?.onNotification({
                method: "rawResponseItem/completed",
                params: {
                  threadId: "runtime-thread-1",
                  turnId: "runtime-turn-1",
                  item: {
                    id: "reasoning-raw-1",
                    type: "reasoning",
                    summary: [{ type: "summary_text", text: "Resum final verificat" }],
                    encrypted_content: null,
                  },
                },
              });
              await handlers?.onNotification({
                method: "item/agentMessage/delta",
                params: { threadId: "runtime-thread-1", turnId: "runtime-turn-1", itemId: "commentary-1", delta: "**Voy a comprobar la fuente autorizada.** Codex Instalación: company-qa /var/lib/aibrain/data/users/fc71a2c4-0db0-4914-af82-9564038ea964/runtime/codex-home/skills/web/SKILL.md" },
              }, { eventId: "commentary-delta", sequence: 10, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
              await handlers?.onNotification({
                method: "item/started",
                params: {
                  threadId: "runtime-thread-1",
                  turnId: "runtime-turn-1",
                  item: { id: "commentary-1", type: "agentMessage", text: "", phase: "commentary", status: "inProgress" },
                },
              }, { eventId: "commentary-started", sequence: 11, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
              await handlers?.onNotification({
                method: "item/completed",
                params: {
                  threadId: "runtime-thread-1",
                  turnId: "runtime-turn-1",
                  item: { id: "commentary-1", type: "agentMessage", text: "**Voy a comprobar la fuente autorizada.** Codex Instalación: company-qa /var/lib/aibrain/data/users/fc71a2c4-0db0-4914-af82-9564038ea964/runtime/codex-home/skills/web/SKILL.md", phase: "commentary", status: "completed" },
                },
              }, { eventId: "commentary-completed", sequence: 12, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
              await handlers?.onNotification({
                method: "item/agentMessage/delta",
                params: { threadId: "runtime-thread-1", turnId: "runtime-turn-1", itemId: "message-1", delta: "Resultado " },
              }, { eventId: "final-delta", sequence: 13, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
              await handlers?.onNotification({
                method: "item/started",
                params: {
                  threadId: "runtime-thread-1",
                  turnId: "runtime-turn-1",
                  item: { id: "message-1", type: "agentMessage", text: "", phase: "final_answer", status: "inProgress" },
                },
              }, { eventId: "final-started", sequence: 14, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
              await handlers?.onNotification({
                method: "item/agentMessage/delta",
                params: { threadId: "runtime-thread-1", turnId: "runtime-turn-1", itemId: "message-1", delta: "fc71a2c4-0db0-" },
              }, { eventId: "final-id-fragment-1", sequence: 15, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
              await handlers?.onNotification({
                method: "item/agentMessage/delta",
                params: { threadId: "runtime-thread-1", turnId: "runtime-turn-1", itemId: "message-1", delta: "4914-af82-9564038ea964." },
              }, { eventId: "final-id-fragment-2", sequence: 16, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
              await handlers?.onNotification({
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: "runtime-thread-1",
                  turnId: "runtime-turn-1",
                  tokenUsage: {
                    last: {
                      totalTokens: 120,
                      inputTokens: 80,
                      cachedInputTokens: 20,
                      cacheWriteInputTokens: 0,
                      outputTokens: 40,
                      reasoningOutputTokens: 8,
                    },
                  },
                },
              });
              await handlers?.onNotification({
                method: "item/fileChange/patchUpdated",
                params: {
                  threadId: "runtime-thread-1",
                  turnId: "runtime-turn-1",
                  itemId: "file-change-1",
                  changes: [{
                    path: "src/example.ts",
                    kind: { type: "update", move_path: null },
                    diff: "",
                  }],
                },
              });
              await handlers?.onNotification({
                method: "turn/completed",
                params: { threadId: "runtime-thread-1", turn: { id: "runtime-turn-1", status: "completed", items: [], error: null } },
              });
            })();
          });
          return result;
        }
        return {};
      },
    };
    mocked.runtime = {
      config: { installationId, companySlug: "arnall", branding: { productName: "Arnall AI" }, paths: installationPaths },
      handle: {
        roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") },
      },
      client,
    };

    const events: Array<Record<string, unknown>> = [];
    const projectionKeys: string[] = [];
    const request = chatRequest();
    request.message = "Quin és l'horari d'avui de la botiga Arnall de Palamós? Cerca'l a la web oficial.";
    // Legacy client input cannot weaken the server-owned reviewer selection.
    request.options.autoApprove = false;
    request.options.webSearch = true;
    request.options.model = "gpt-5.6-terra";
    request.options.effort = "low";
    request.options.documentUploadIds = [documentUploadId];
    const turnPermissions = permissions([{
      ruleId: "documents.read",
      action: "consult",
      effect: "allow",
      instruction: "Read the attached document.",
      sourceScope: "installation",
      sourcePolicyVersion: 1,
      precedence: 100,
    }]);
    await runWorkerCodexTurn(
      request,
      installationId,
      userId,
      null,
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/legacy-must-not-be-used",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      turnPermissions,
      {} as never,
      memoryDependencies(),
      [{
        document: {
          schemaVersion: 1,
          uploadId: documentUploadId,
          threadId,
          fileName: "notes.txt",
          relativePath: `threads/${threadId}/uploads/${documentUploadId}/notes.txt`,
          kind: "text",
          mediaType: "text/plain",
          size: 16,
          sha256: "b".repeat(64),
          status: "staged",
          createdAt: "2026-08-27T00:00:00.000Z",
        },
        absolutePath: documentPath,
        codexInputs: [{
          type: "text",
          text: "BEGIN UNTRUSTED ATTACHMENT notes.txt\nserver-derived attachment\nEND UNTRUSTED ATTACHMENT notes.txt",
          text_elements: [],
        }],
      }],
      new AbortController().signal,
      async (event, projection) => {
        events.push(event);
        if (projection) projectionKeys.push(projection.key);
      },
      undefined,
      "AiBrain",
      projectGuidance(),
    );

    const turnStart = calls.find((call) => call.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: "runtime-thread-1",
      clientUserMessageId: userMessageId,
      runtimeWorkspaceRoots: [
        path.join(workspace, "projects", projectId),
        workspace,
        path.join(userRoot, "artifacts"),
      ],
      model: "gpt-5.6-terra",
      effort: "low",
      summary: "concise",
    });
    // Read-only mounts are available through the outer sandbox only. If one is
    // promoted to an App Server workspace, nested bwrap attempts to create
    // `/source-ro/.git` and fails with "Read-only file system".
    expect((turnStart?.params as { runtimeWorkspaceRoots?: string[] }).runtimeWorkspaceRoots)
      .not.toContain(installationPaths.sourceReadRoot);
    expect((turnStart?.params as { runtimeWorkspaceRoots?: string[] }).runtimeWorkspaceRoots)
      .not.toContain(installationPaths.companyContextRoot);
    // A normal selected model/effort is validated by turn/start itself. The
    // optional five-RPC picker catalog must not delay this live web turn.
    expect(modelCatalogCalls).toBe(0);
    expect((turnStart?.params as { input: Array<{ type: string; path?: string; text?: string }> }).input)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("server-attached documents") }),
        expect.objectContaining({ type: "text", text: expect.stringContaining("server-derived attachment") }),
    ]));
    expect(JSON.stringify(turnStart?.params)).not.toContain(documentPath);
    expect(JSON.stringify(turnStart?.params)).not.toContain(path.join(staging, "tmp"));
    expect(JSON.stringify(turnStart?.params)).not.toContain("legacy-must-not-be-used");
    expect(JSON.stringify(turnStart?.params)).not.toContain('"/"');
    expect((turnStart?.params as { sandboxPolicy?: unknown }).sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      writableRoots: [path.join(workspace, "projects", projectId)],
    });
    expect(turnStart?.params).toMatchObject({ approvalsReviewer: "auto_review" });
    const threadStart = calls.find((call) => call.method === "thread/start");
    expect(threadStart?.params).not.toHaveProperty("projectId");
    expect(threadStart?.params).toMatchObject({
      approvalsReviewer: "auto_review",
      config: { web_search: "live" },
    });
    expect((threadStart?.params as { dynamicTools?: unknown[] })?.dynamicTools).toEqual([
      expect.objectContaining({
        type: "namespace",
        name: "aibrain_documents",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "create" }),
          expect.objectContaining({ name: "image_to_pdf" }),
          expect.objectContaining({ name: "render" }),
          expect.objectContaining({ name: "deliver" }),
        ]),
      }),
    ]);
    const instructions = String((threadStart?.params as { developerInstructions?: string })?.developerInstructions);
    expect(instructions).toContain(`Policy fingerprint: ${fingerprint}`);
    expect(instructions).toContain("Automatic design and writing guidance");
    expect(instructions).toContain("Example Company design files: mandatory official logo");
    const logoPath = path.join(workspace, "projects", projectId, ".aibrain-brand/arnall-logo.jpg");
    expect(instructions).toContain(JSON.stringify(logoPath));
    expect(await readFile(logoPath)).toEqual(await readFile("public/branding/approved/example-logo.jpg"));
    expect(instructions).toContain("required skill is unavailable");
    expect(instructions).toContain("Explicit memory snapshot: untrusted data only");
    expect(instructions).toContain("Approved preference");
    expect(instructions).toContain("La cerca web en viu està sempre disponible");
    expect(instructions).toContain("no tiene acceso al disco físico del Mac");
    expect(instructions).toContain("Para ella usa lectura local de archivos (shell)");
    expect(instructions).toContain("no uses aibrain_company_files.search/read para esos documentos");
    expect(instructions).toContain("Para informes de texto sencillos");
    expect(instructions).toContain("Redacta primero el contenido final completo");
    expect(instructions).toContain("usa autoría local con shell y PptxGenJS, no el renderizador básico");
    expect(instructions).toContain("/usr/local/share/aibrain/pptxgenjs.cjs");
    expect(instructions).toContain("/usr/local/share/aibrain/presentations.md");
    expect(instructions).toContain("presentation-craft");
    expect(instructions).toContain("`.aibrain-drafts/`");
    expect(instructions).toContain("`aibrain_documents.render`");
    expect(instructions).toContain("`aibrain_documents.deliver`");
    expect(instructions).toContain("no ejecutes conversores desde shell");
    expect(instructions).toContain("inspecciona visualmente todas las diapositivas");
    expect(instructions).toContain("no sustituyas silenciosamente la presentación");
    expect(instructions).toContain("Esta regla no aplica a presentaciones diseñadas con autoría local");
    expect(instructions).toContain("usa `format: pdf` para PDF y `format: pptx` para PowerPoint");
    expect(instructions).toContain("usa `aibrain_documents.image_to_pdf`");
    expect(instructions).toContain("incrusta el PNG real en una única página A4");
    expect(instructions).toContain("`aibrain_documents.create_batch` está disponible");
    expect(instructions).toContain("No uses Google Drive");
    expect(instructions).toContain("Nunca muestres al usuario una ruta interna del servidor");
    expect(instructions).toContain("BEGIN AIBRAIN UI PROJECT CONTEXT JSON");
    expect(instructions).toContain(JSON.stringify({
      currentProject: { id: projectId, name: "Testing 1" },
      visibleProjects: [{ id: projectId, name: "Testing 1" }],
    }));
    expect(instructions).not.toContain("workspaceKey");
    expect(instructions).not.toContain("snapshot-uuid-not-a-project");
    expect(instructions.indexOf(`Policy fingerprint: ${fingerprint}`))
      .toBeLessThan(instructions.indexOf("BEGIN AIBRAIN EXPLICIT MEMORY JSON DATA"));
    expect(boundTurn).toBe("runtime-turn-1");
    expect(events).toContainEqual({ type: "runtimeThread", threadToken: "user-bound-runtime-thread-token" });
    expect(events.filter((event) => event.type === "delta")).toEqual([
      { type: "delta", value: "Resultado " },
      { type: "delta", value: "identificador interno." },
    ]);
    expect(events).not.toContainEqual({ type: "delta", value: "Voy a comprobar la fuente autorizada." });
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      item: expect.objectContaining({
        id: "commentary-1",
        kind: "reasoning",
        detail: expect.stringContaining("Voy a comprobar la fuente autorizada."),
      }),
    }));
    expect(projectionKeys).toContain("commentary:completed:commentary-1");
    expect(projectionKeys.every((key) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(key))).toBe(true);
    expect(events).toContainEqual({
      type: "activity",
      item: {
        id: "file-change-1",
        kind: "file",
        label: "Preparant canvis",
        detail: "src/example.ts",
        files: [{ path: "src/example.ts", change: "update" }],
        status: "running",
      },
    });
    expect(events).toContainEqual({
      type: "runtimeUsage",
      tokenUsage: {
        totalTokens: 120,
        inputTokens: 80,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 40,
        reasoningOutputTokens: 8,
      },
    });
    expect(events).toContainEqual({ type: "done" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      item: expect.objectContaining({ label: "Preparando el contexto", status: "running" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      item: expect.objectContaining({ label: "Preparando el resumen del razonamiento" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      item: expect.objectContaining({ kind: "reasoning", detail: "Analitzant la petició" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      item: expect.objectContaining({ kind: "reasoning", detail: "Resum final verificat" }),
    }));
    expect(events.filter((event) => event.type === "content")).toEqual([]);
    expect(JSON.stringify(events)).not.toMatch(/Preparant (?:el context|l.assistent|el resum)|Assistent preparat|L.assistent|Esperant activitat de l.assistent/u);
    expect(JSON.stringify(events)).not.toMatch(/private reasoning must not be exposed|\*\*|Codex|AiBrain|\/var\/lib|company-qa|fc71a2c4/iu);
    expect(mocked.maintenanceReleases).toBe(1);
  });

  it.each(["read-terminal", "ack-running", "ack-read-failed", "foreign-thread", "foreign-turn", "foreign-user", "persistence-failed", "event-terminal"])("requires actual terminal evidence after an accepted Stop while turn/start resolves (%s)", async mode => {
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-worker-pending-stop-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.join(staging, "threads"), { recursive: true, mode: 0o700 });
    });
    const calls: string[] = [];
    let handlers: { onNotification(value: unknown, envelope: unknown): Promise<void> | void } | null = null;
    const completedAdmission = vi.fn(async () => {});
    const admission = vi.spyOn(FileModelTurnQueue.prototype, "acquire").mockResolvedValue({ complete: completedAdmission });
    const client = {
      router: {
        registerTurn(runtimeThreadId: string, localTurnId: string, value: typeof handlers) {
          handlers = value;
          return {
            threadId: runtimeThreadId,
            localTurnId,
            bindRuntimeTurn() {},
            dispose() {},
          };
        },
      },
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: false,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async resolvedSkills() { return []; },
      async request(
        method: string,
        _params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        calls.push(method);
        if (method === "thread/start") {
          const result = { thread: { id: "runtime-thread-pending-stop" } };
          await beforeResolve?.(result as never, {
            eventId: "pending-thread-response",
            sequence: 1,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          return result;
        }
        if (method === "turn/start") {
          expect(mocked.cancelTurn).not.toBeNull();
          mocked.cancelTurn!(false);
          const result = { turn: { id: "runtime-turn-pending-stop" } };
          await beforeResolve?.(result as never, {
            eventId: "pending-turn-response",
            sequence: 2,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          return result;
        }
        if (method === "turn/interrupt") {
          if (mode === "event-terminal") await handlers!.onNotification({ method: "turn/completed", params: {
            threadId: "runtime-thread-pending-stop", turn: { id: "runtime-turn-pending-stop", status: "interrupted", items: [] },
          } }, { eventId: "actual-stop-terminal", sequence: 3, occurredAt: new Date().toISOString(),
            message: { kind: "rpc-notification", rpc: {} } });
          return {}; // ACK has no status and is never terminal evidence.
        }
        if (method === "thread/read") {
          if (mode === "ack-read-failed") throw new Error("Synthetic unavailable authoritative read");
          const result = { thread: { id: mode === "foreign-thread" ? "foreign-thread" : "runtime-thread-pending-stop", turns: [{
            id: mode === "foreign-turn" ? "foreign-turn" : "runtime-turn-pending-stop",
            status: ["read-terminal", "persistence-failed", "foreign-thread", "foreign-turn", "foreign-user"].includes(mode) ? "interrupted" : "inProgress",
            items: [{ type: "userMessage", id: "original-input", clientId: mode === "foreign-user" ? "foreign-input" : userMessageId }],
          }] } };
          await beforeResolve?.(result as never, { eventId: "actual-stop-read", sequence: 4, occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } } } as never);
          return result;
        }
        throw new Error(`Unexpected request ${method}`);
      },
    };
    mocked.runtime = {
      config: { installationId, paths: { ...installationPaths, dataRoot: userRoot } },
      handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } },
      client,
    };
    const events: Array<Record<string, unknown>> = [];

    const failedPersistence = mode === "persistence-failed"
      ? vi.spyOn(DurableTurnSubmission.prototype, "observeTerminal").mockRejectedValueOnce(new Error("Synthetic settlement failure")) : null;
    const run = runWorkerCodexTurn(
      chatRequest(),
      installationId,
      userId,
      null,
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/legacy-must-not-be-used",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions(),
      {} as never,
      memoryDependencies(),
      [],
      new AbortController().signal,
      async (event) => { events.push(event); },
    );

    try {
      if (!["read-terminal", "event-terminal"].includes(mode)) await expect(run).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
      else await run;
    } finally { failedPersistence?.mockRestore(); admission.mockRestore(); }
    expect(calls).toEqual(["thread/start", "turn/start", "turn/interrupt", ...(mode === "event-terminal" ? [] : ["thread/read"])]);
    expect(events).toContainEqual({ type: "runtimeTurn", turnId: "runtime-turn-pending-stop" });
    const receipt = JSON.parse(await readFile(path.join(workspace, "state", "turn-submissions", threadId, `${assistantMessageId}.json`), "utf8"));
    if (["read-terminal", "event-terminal"].includes(mode)) {
      expect(completedAdmission).toHaveBeenCalledOnce();
      expect(events).toContainEqual({ type: "stopped" });
      expect(receipt).toMatchObject({ phase: "terminal", terminal: "interrupted", runtimeTurnId: "runtime-turn-pending-stop", turnRequest: null, inputs: null });
    } else {
      expect(completedAdmission).not.toHaveBeenCalled();
      expect(events).not.toContainEqual({ type: "stopped" });
      expect(receipt).toMatchObject({ phase: "dispatched", terminal: null, runtimeTurnId: "runtime-turn-pending-stop" });
      expect(receipt.turnRequest).not.toBeNull();
    }
    expect(events).not.toContainEqual({ type: "done" });
  });

  it("recovers a timed-out turn/start from App Server without creating a duplicate turn", async () => {
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-worker-timeout-recovery-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.join(staging, "threads"), { recursive: true, mode: 0o700 });
    });
    let handlers: { onNotification(value: unknown, envelope: unknown): Promise<void> | void } | null = null;
    const calls: string[] = [];
    const client = {
      router: {
        registerTurn(runtimeThreadId: string, localTurnId: string, value: typeof handlers) {
          handlers = value;
          return {
            threadId: runtimeThreadId,
            localTurnId,
            bindRuntimeTurn() {},
            dispose() {},
          };
        },
      },
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: false,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async resolvedSkills() { return []; },
      async request(
        method: string,
        _params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        calls.push(method);
        if (method === "thread/start") {
          const result = { thread: { id: "runtime-thread-timeout" } };
          await beforeResolve?.(result as never, {
            eventId: "timeout-thread-response",
            sequence: 1,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          return result;
        }
        if (method === "turn/start") {
          throw new AppServerRequestTimeoutError("turn/start", purpose, 60_000);
        }
        if (method === "thread/read") {
          const result = {
            thread: {
              id: "runtime-thread-timeout",
              turns: [{
                id: "runtime-turn-timeout",
                status: "inProgress",
                error: null,
                items: [{ type: "userMessage", id: "user-item", clientId: userMessageId, content: [] }],
              }],
            },
          };
          queueMicrotask(() => {
            void handlers?.onNotification({
              method: "turn/completed",
              params: {
                threadId: "runtime-thread-timeout",
                turn: { id: "runtime-turn-timeout", status: "completed", items: [{ type: "agentMessage", id: "fixture-final", phase: "final_answer", text: "Fixture completed answer." }], error: null },
              },
            }, {
              eventId: "timeout-turn-completed",
              sequence: 3,
              occurredAt: new Date().toISOString(),
              message: { kind: "rpc-notification", rpc: {} },
            });
          });
          throw new AppServerRequestTimeoutError(
            "thread/read",
            purpose,
            15_000,
            Promise.resolve(result),
          );
        }
        throw new Error(`Unexpected request ${method}`);
      },
    };
    mocked.runtime = {
      config: { installationId, paths: installationPaths },
      handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } },
      client,
    };
    const events: Array<Record<string, unknown>> = [];

    await runWorkerCodexTurn(
      chatRequest(),
      installationId,
      userId,
      null,
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/legacy-must-not-be-used",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions(),
      {} as never,
      memoryDependencies(),
      [],
      new AbortController().signal,
      async (event) => { events.push(event); },
    );

    expect(calls).toEqual(["thread/start", "turn/start", "thread/read"]);
    expect(events).toContainEqual({ type: "runtimeTurn", turnId: "runtime-turn-timeout" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      item: expect.objectContaining({
        id: "runtime-turn-recovery",
        label: "Tarea recuperada",
        status: "complete",
      }),
    }));
    expect(events).toContainEqual({ type: "done" });
  });

  it("reconciles and interrupts a document turn that never produces a final answer", async () => {
    vi.stubEnv("AIBRAIN_TURN_IDLE_TIMEOUT_MS", "5000");
    vi.stubEnv("AIBRAIN_TURN_HARD_TIMEOUT_MS", "5000");
    vi.stubEnv("AIBRAIN_DOCUMENT_TOOL_TERMINAL_GRACE_MS", "1000");
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-worker-watchdog-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.join(staging, "threads"), { recursive: true, mode: 0o700 });
    });
    const calls: string[] = [];
    let handlers: {
      onServerRequest(request: unknown, envelope: unknown): Promise<unknown> | unknown;
    } | null = null;
    const client = {
      router: {
        registerTurn(runtimeThreadId: string, localTurnId: string, value: typeof handlers) {
          handlers = value;
          return {
            threadId: runtimeThreadId,
            localTurnId,
            bindRuntimeTurn() {},
            dispose() {},
          };
        },
      },
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: true,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async resolvedSkills() { return []; },
      prewarmConnection() {},
      async request(
        method: string,
        _params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        calls.push(method);
        if (method === "thread/start") {
          const result = { thread: { id: "runtime-thread-watchdog", turns: [] } };
          await beforeResolve?.(result as never, {
            eventId: "watchdog-thread",
            sequence: 1,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          return result;
        }
        if (method === "turn/start") {
          const result = { turn: { id: "runtime-turn-watchdog" } };
          await beforeResolve?.(result as never, {
            eventId: "watchdog-turn",
            sequence: 2,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          queueMicrotask(() => {
            void handlers?.onServerRequest({
              method: "item/tool/call",
              id: "watchdog-document-call",
              params: {
                threadId: "runtime-thread-watchdog",
                turnId: "runtime-turn-watchdog",
                callId: "watchdog-document-call",
                namespace: "aibrain_documents",
                tool: "create",
                arguments: {
                  format: "pdf",
                  fileName: "hello-world.pdf",
                  title: "Hello world",
                  content: "Hello world",
                },
              },
            }, {
              eventId: "watchdog-document-request",
              sequence: 3,
              occurredAt: new Date().toISOString(),
              message: { kind: "rpc-request", rpc: {} },
            });
          });
          return result;
        }
        if (method === "thread/read") {
          return {
            thread: {
              id: "runtime-thread-watchdog",
              turns: [{
                id: "runtime-turn-watchdog",
                status: "inProgress",
                error: null,
                items: [{ type: "userMessage", id: "user-item", clientId: userMessageId, content: [] }],
              }],
            },
          };
        }
        if (method === "turn/interrupt") return {};
        throw new Error(`Unexpected request ${method}`);
      },
    };
    mocked.runtime = {
      config: { installationId, paths: installationPaths },
      handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } },
      client,
    };
    const events: Array<Record<string, unknown>> = [];

    await runWorkerCodexTurn(
      chatRequest(),
      installationId,
      userId,
      null,
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/legacy-must-not-be-used",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions([{
        ruleId: "tools.execute",
        action: "execute",
        effect: "allow",
        instruction: "Create local documents.",
        sourceScope: "installation",
        sourcePolicyVersion: 1,
        precedence: 100,
      }]),
      {} as never,
      memoryDependencies(),
      [],
      new AbortController().signal,
      async (event) => { events.push(event); },
    );

    expect(calls).toEqual(["thread/start", "turn/start", "thread/read", "turn/interrupt"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("sin repetir ninguna creación"),
    }));
    expect(events).not.toContainEqual({ type: "done" });
  }, 15_000);

  it("keeps a Trinalum approval tool active beyond the idle timeout without replaying it", async () => {
    vi.stubEnv("AIBRAIN_TURN_IDLE_TIMEOUT_MS", "5000");
    vi.stubEnv("AIBRAIN_TURN_HARD_TIMEOUT_MS", "15000");
    const businessTools = await import("@/runtime/trinalum-dynamic-tools");
    const action = vi.spyOn(businessTools, "handleTrinalumTool").mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5500));
      await handlers?.onNotification({ method: "turn/completed", params: { threadId: "runtime-thread-watchdog", turn: { id: "runtime-turn-watchdog", status: "completed", items: [{ type: "agentMessage", id: "synthetic-final", phase: "final_answer", text: "Verified synthetic approval completed once." }], error: null } } }, { eventId: "approved-completed", sequence: 4, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
      return { contentItems: [{ type: "inputText", text: "approved once" }], success: true };
    });
    vi.stubEnv("AIBRAIN_DOCUMENT_TOOL_TERMINAL_GRACE_MS", "1000");
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-worker-watchdog-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.join(staging, "threads"), { recursive: true, mode: 0o700 });
    });
    const calls: string[] = [];
    let handlers: {
      onServerRequest(request: unknown, envelope: unknown): Promise<unknown> | unknown;
      onNotification(request: unknown, envelope: unknown): Promise<unknown> | unknown;
    } | null = null;
    const client = {
      router: {
        registerTurn(runtimeThreadId: string, localTurnId: string, value: typeof handlers) {
          handlers = value;
          return {
            threadId: runtimeThreadId,
            localTurnId,
            bindRuntimeTurn() {},
            dispose() {},
          };
        },
      },
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: true,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async resolvedSkills() { return []; },
      prewarmConnection() {},
      async request(
        method: string,
        _params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        calls.push(method);
        if (method === "thread/start") {
          const result = { thread: { id: "runtime-thread-watchdog", turns: [] } };
          await beforeResolve?.(result as never, {
            eventId: "watchdog-thread",
            sequence: 1,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          return result;
        }
        if (method === "turn/start") {
          const result = { turn: { id: "runtime-turn-watchdog" } };
          await beforeResolve?.(result as never, {
            eventId: "watchdog-turn",
            sequence: 2,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          queueMicrotask(() => {
            void handlers?.onServerRequest({
              method: "item/tool/call",
              id: "watchdog-document-call",
              params: {
                threadId: "runtime-thread-watchdog",
                turnId: "runtime-turn-watchdog",
                callId: "watchdog-document-call",
                namespace: "trinalum_business",
                tool: "attio_action",
                arguments: {
                  format: "pdf",
                  fileName: "hello-world.pdf",
                  title: "Hello world",
                  content: "Hello world",
                },
              },
            }, {
              eventId: "watchdog-document-request",
              sequence: 3,
              occurredAt: new Date().toISOString(),
              message: { kind: "rpc-request", rpc: {} },
            });
          });
          return result;
        }
        if (method === "thread/read") {
          return {
            thread: {
              id: "runtime-thread-watchdog",
              turns: [{
                id: "runtime-turn-watchdog",
                status: "inProgress",
                error: null,
                items: [{ type: "userMessage", id: "user-item", clientId: userMessageId, content: [] }],
              }],
            },
          };
        }
        if (method === "turn/interrupt") return {};
        throw new Error(`Unexpected request ${method}`);
      },
    };
    mocked.runtime = {
      config: { installationId, paths: installationPaths },
      handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } },
      client,
    };
    const events: Array<Record<string, unknown>> = [];

    await runWorkerCodexTurn(
      chatRequest(),
      installationId,
      userId,
      null,
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/legacy-must-not-be-used",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions([{
        ruleId: "tools.execute",
        action: "execute",
        effect: "allow",
        instruction: "Create local documents.",
        sourceScope: "installation",
        sourcePolicyVersion: 1,
        precedence: 100,
      }]),
      {} as never,
      memoryDependencies(),
      [],
      new AbortController().signal,
      async (event) => { events.push(event); },
    );

    expect(calls).toEqual(["thread/start", "turn/start"]);
    expect(action).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "done" });
    expect(events.some(event => event.type === "error")).toBe(false);
    action.mockRestore();
  }, 15_000);

  it.each([false, true])("keeps review active after an intermediate delivery (%s) and never delivers listed documents", async (deliveredEarlier) => {
    vi.stubEnv("AIBRAIN_TURN_IDLE_TIMEOUT_MS", "5000");
    vi.stubEnv("AIBRAIN_TURN_HARD_TIMEOUT_MS", "5000");
    vi.stubEnv("AIBRAIN_DOCUMENT_TOOL_TERMINAL_GRACE_MS", "1000");
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-worker-render-review-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(workspace, { mode: 0o700 });
      const documents = path.join(workspace, "projects", projectId, "documents");
      await mkdir(documents, { recursive: true, mode: 0o700 });
      const { generateLocalDocument } = await import("@/runtime/documents/local-document-generator");
      const old = await generateLocalDocument({ format: "pdf", title: "Previous presentation", content: "This is an existing document, not a requested delivery." });
      await writeFile(path.join(documents, "old-deck.pdf"), old.data);
      await mkdir(path.join(staging, "threads"), { recursive: true, mode: 0o700 });
    });
    const calls: string[] = [];
    let handlers: {
      onNotification(request: unknown, envelope: unknown): Promise<unknown> | unknown;
    } | null = null;
    const client = {
      router: {
        registerTurn(runtimeThreadId: string, localTurnId: string, value: typeof handlers) {
          handlers = value;
          return {
            threadId: runtimeThreadId,
            localTurnId,
            bindRuntimeTurn() {},
            dispose() {},
          };
        },
      },
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: true,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async resolvedSkills() { return []; },
      prewarmConnection() {},
      async request(
        method: string,
        _params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        calls.push(method);
        if (method === "thread/start") {
          const result = { thread: { id: "runtime-thread-watchdog", turns: [] } };
          await beforeResolve?.(result as never, {
            eventId: "watchdog-thread",
            sequence: 1,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          return result;
        }
        if (method === "turn/start") {
          const result = { turn: { id: "runtime-turn-watchdog" } };
          await beforeResolve?.(result as never, {
            eventId: "watchdog-turn",
            sequence: 2,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          queueMicrotask(() => {
            void (async () => {
              if (deliveredEarlier) {
                await handlers?.onNotification({
                  method: "item/completed",
                  params: {
                    threadId: "runtime-thread-watchdog", turnId: "runtime-turn-watchdog",
                    item: { id: "intermediate-pdf", type: "dynamicToolCall", namespace: "aibrain_documents", tool: "create", status: "completed", contentItems: [] },
                  },
                }, { eventId: "intermediate-pdf-completed", sequence: 3, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
              }
              await handlers?.onNotification({
                method: "item/completed",
                params: {
                  threadId: "runtime-thread-watchdog",
                  turnId: "runtime-turn-watchdog",
                  item: { id: "render-review", type: "dynamicToolCall", namespace: "aibrain_documents", tool: "render", status: "completed", contentItems: [{ type: "inputText", text: '{"status":"review","page":1,"pages":3}' }] },
                },
              }, { eventId: "render-review-completed", sequence: 3, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
              await handlers?.onNotification({
                method: "item/completed",
                params: {
                  threadId: "runtime-thread-watchdog", turnId: "runtime-turn-watchdog",
                  item: { id: "list-existing", type: "commandExecution", command: "ls documents/", status: "completed", aggregatedOutput: "documents/old-deck.pdf\n" },
                },
              }, { eventId: "list-existing-completed", sequence: 4, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
              // Reviewing the rendered image can legitimately outlast both
              // terminal grace windows; this is not a final delivery tool.
              await new Promise((resolve) => setTimeout(resolve, 2300));
              await handlers?.onNotification({
                method: "turn/completed",
                params: { threadId: "runtime-thread-watchdog", turn: { id: "runtime-turn-watchdog", status: "completed", items: [{ type: "agentMessage", id: "fixture-final", phase: "final_answer", text: "Fixture completed answer." }], error: null } },
              }, { eventId: "render-review-turn-completed", sequence: 5, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
            })();
          });
          return result;
        }
        if (method === "thread/read") {
          return {
            thread: {
              id: "runtime-thread-watchdog",
              turns: [{
                id: "runtime-turn-watchdog",
                status: "inProgress",
                error: null,
                items: [{ type: "userMessage", id: "user-item", clientId: userMessageId, content: [] }],
              }],
            },
          };
        }
        if (method === "turn/interrupt") return {};
        throw new Error(`Unexpected request ${method}`);
      },
    };
    mocked.runtime = {
      config: { installationId, paths: { ...installationPaths, dataRoot: userRoot } },
      handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } },
      client,
    };
    const events: Array<Record<string, unknown>> = [];

    await runWorkerCodexTurn(
      chatRequest(),
      installationId,
      userId,
      null,
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/legacy-must-not-be-used",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions([{
        ruleId: "tools.execute",
        action: "execute",
        effect: "allow",
        instruction: "Create local documents.",
        sourceScope: "installation",
        sourcePolicyVersion: 1,
        precedence: 100,
      }]),
      {} as never,
      memoryDependencies(),
      [],
      new AbortController().signal,
      async (event) => { events.push(event); },
    );

    expect(calls).toEqual(["thread/start", "turn/start"]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "artifact")).toEqual([]);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(userRoot)).not.toContain("generated-document-artifacts");
    expect(events).toContainEqual({ type: "done" });
  });

  it.each(["missing", "replacement-lost-ack", "replacement-before-token", "different-thread", "transport", "recovery-only", "pending-model", "no-history-snapshot", "oversized-presend", "resume-hangs", "recovery-read-hangs", "metadata-lost-ack", "metadata-late-callback", "metadata-no-history", "metadata-cancel-signal", "metadata-cancel-registry", "cancelled-admission"] as const)(
    "replaces an absent provider rollout only before a new admitted model turn (%s)", async (fault) => {
      const root = await mkdtemp(path.join(tmpdir(), "aibrain-missing-rollout-"));
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const events: Array<Record<string, unknown>> = [];
      let attempt = 0;
      const metadataFault = ["resume-hangs","recovery-read-hangs","metadata-lost-ack","metadata-late-callback","metadata-no-history","metadata-cancel-signal","metadata-cancel-registry"].includes(fault);
      const cancellationController = new AbortController();
      const originalDeadline = coldRecovery.withColdThreadRecoveryDeadline;
      const deadline = metadataFault ? vi.spyOn(coldRecovery,"withColdThreadRecoveryDeadline").mockImplementation((operation,expired,_timeout,signal)=>originalDeadline(operation,expired,25,signal)) : null;
      let sequence = 0;
      let handlers: { onNotification(value: unknown, envelope: unknown): Promise<void> };
      const envelope = () => ({ eventId: `rollout-${++sequence}`, sequence,
        occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
      const missingError = (purpose: string) => new AppServerRpcResponseError("thread/resume", purpose,
        { code: -32600, message: `no rollout found for thread id ${fault === "different-thread" ? "another-user-thread" : "missing-thread"}` });
      const client = {
        canReuseLoadedThread: () => false,
        connectionSummary: async () => ({ connected: true }),
        async recoverThreadStart(_params: unknown, purpose: string) {
          expect(purpose).toBe(`thread-start:${assistantMessageId}:${metadataFault?"metadata-timeout":"missing"}:missing-thread`);
          return { thread: { id: "replacement-thread", turns: [] } };
        },
        router: { registerTurn(_thread: string, _turn: string, value: typeof handlers) {
          handlers = value; return { bindRuntimeTurn() {}, dispose() {} };
        } },
        async request(method: string, params: Record<string, unknown>, purpose: string, _timeout: number,
          beforeResolve?: (value: never, event: never) => Promise<void>) {
          calls.push({ method, params });
          if (method === "thread/resume") {
            if ((fault === "pending-model" && attempt === 1) || params.threadId === "replacement-thread") {
              const result = { thread: { id: String(params.threadId), turns: [] } };
              await beforeResolve?.(result as never, envelope() as never);
              return result;
            }
            if (metadataFault) {
              if(fault === "metadata-cancel-signal")setTimeout(()=>cancellationController.abort(),5);
              if(fault === "metadata-cancel-registry")setTimeout(()=>mocked.cancelTurn?.(false),5);
              if (fault === "recovery-read-hangs") throw new AppServerRequestTimeoutError("thread/resume",purpose,60_000);
              if (fault === "metadata-late-callback") {
                await new Promise(resolve=>setTimeout(resolve,75));
                const old={thread:{id:"missing-thread",turns:[]}};
                await beforeResolve?.(old as never,envelope() as never);return old;
              }
              return new Promise<never>(()=>{});
            }
            if (fault === "transport") throw new Error("Connection lost while reading rollout");
            throw missingError(purpose);
          }
          if (method === "thread/read" && fault === "recovery-read-hangs") return new Promise<never>(()=>{});
          if (method === "thread/start") {
            if (fault === "metadata-lost-ack" && attempt === 1) throw new AppServerRequestTimeoutError("thread/start",purpose,60_000);
            if (fault === "replacement-lost-ack") throw new AppServerRequestTimeoutError("thread/start", purpose, 60_000);
            const result = { thread: { id: "replacement-thread", turns: [] } };
            await beforeResolve?.(result as never, envelope() as never);
            return result;
          }
          if (method === "turn/start") {
            if (fault === "oversized-presend") throw new TransportRequestTooLargeError(purpose, 9_728_471, 8_388_608);
            if (fault === "pending-model") throw new Error("Model request outcome unknown");
            const result = { turn: { id: "replacement-turn" } };
            await beforeResolve?.(result as never, envelope() as never);
            queueMicrotask(() => { void handlers.onNotification({ method: "turn/completed", params: {
              threadId: "replacement-thread", turn: { id: "replacement-turn", status: "completed", error: null,
                items: [{ type: "agentMessage", id: "answer", phase: "final_answer", text: "Existing conversation continued." }] },
            } }, envelope()); });
            return result;
          }
          throw new Error(`Unexpected ${method}`);
        },
      };
      mocked.runtime = { config: { installationId, paths: installationPaths },
        handle: { roots: { userRoot: root, workspace, staging: path.join(root, "staging"), artifacts: path.join(root, "artifacts") } }, client };
      const run = () => {
        attempt += 1;
        return runWorkerCodexTurn(chatRequest(), installationId, userId, "missing-thread", {
          tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
          workspace, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
        }, permissions(), {} as never, memoryDependencies(), [], cancellationController.signal,
        async event => {
          if (fault === "replacement-before-token" && attempt === 1 && event.type === "runtimeThread") throw new Error("Connection lost before replacement token publication");
          events.push(event);
        }, undefined, "Assistant", projectGuidance(), undefined,
        undefined, undefined, undefined, false, "test-current-toolset", fault === "recovery-only", undefined,
        ["no-history-snapshot","metadata-no-history"].includes(fault) ? undefined : "USER: Keep existing catalogue prices.\nASSISTANT: Existing saved context.");
      };
      try {
        if (fault === "cancelled-admission") {
          const { DurableTurnSubmission, turnSubmissionBinding } = await import("@/runtime/turn-submission-store");
          const admittedWorkspace = path.join(workspace, "projects", projectId);
          await mkdir(admittedWorkspace, { recursive: true, mode: 0o700 });
          const receipt = await DurableTurnSubmission.open({
            userRoot: root, workspace: admittedWorkspace, installationId, userId, projectId, threadId, assistantMessageId,
            binding: turnSubmissionBinding({ installationId, userId, chatRequest: chatRequest(), permissionFingerprint: permissions().fingerprint, documents: [] }),
          });
          expect(await receipt.cancelBeforeDispatch()).toBe(true);
          await receipt.close();
          await expect(run()).resolves.toBeUndefined();
          expect(calls).toEqual([]);
          expect(events).toContainEqual({ type: "stopped" });
        } else if(["metadata-cancel-signal","metadata-cancel-registry"].includes(fault)) {
          await expect(run()).resolves.toBeUndefined();
          expect(calls.map(call=>call.method)).toEqual(["thread/resume"]);
          expect(events).toContainEqual({type:"stopped"});
          expect(events.some(event=>event.type === "done")).toBe(false);
          const saved=JSON.parse(await readFile(path.join(root,"state","turn-submissions",threadId,`${assistantMessageId}.json`),"utf8"));
          expect(saved.phase).toBe("preparing");expect(saved.runtimeThreadId).toBeNull();expect(saved.runtimeTurnId).toBeNull();
        } else if(fault === "metadata-no-history") {
          await expect(run()).rejects.toBeInstanceOf(coldRecovery.ColdThreadRecoveryTimeoutError);
          expect(calls.map(call=>call.method)).toEqual(["thread/resume"]);
          expect(events.some(event=>event.type === "done")).toBe(false);
        } else if (metadataFault) {
          if(fault === "metadata-lost-ack") await expect(run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
          await expect(run()).resolves.toBeUndefined();
          if(fault === "metadata-late-callback") await new Promise(resolve=>setTimeout(resolve,85));
          expect(calls.filter(call=>call.method === "turn/start")).toHaveLength(1);
          expect(calls.filter(call=>call.method === "thread/start")).toHaveLength(1);
          expect(calls.at(-1)?.params.threadId).toBe("replacement-thread");
          expect(JSON.stringify(calls.at(-1)?.params.input)).toContain("Keep existing catalogue prices");
          expect(JSON.stringify(calls.at(-1)?.params.input)).toContain(chatRequest().message);
          expect(events.some(event=>event.type === "runtimeThread" && String(event.threadToken).includes("missing-thread"))).toBe(false);
          const saved=JSON.parse(await readFile(path.join(root,"state","turn-submissions",threadId,`${assistantMessageId}.json`),"utf8"));
          expect(saved.runtimeThreadId).toBe("replacement-thread");
          expect(JSON.stringify(calls.at(-1)?.params.input).split(chatRequest().message)).toHaveLength(2);
          expect(events).toContainEqual({type:"done"});
        } else if (["missing", "replacement-lost-ack", "replacement-before-token"].includes(fault)) {
          if (fault === "replacement-lost-ack") await expect(run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
          if (fault === "replacement-before-token") {
            await expect(run()).rejects.toThrow("before replacement token");
            const saved = JSON.parse(await readFile(path.join(root,"state","turn-submissions",threadId,`${assistantMessageId}.json`),"utf8"));
            expect(saved).toMatchObject({phase:"preparing",terminal:null,runtimeThreadId:"replacement-thread",runtimeTurnId:null,turnRequest:null});
            expect(JSON.parse(saved.threadRequest).method).toBe("thread/start");
          }
          await expect(run()).resolves.toBeUndefined();
          expect(calls.map(call => call.method)).toEqual(fault === "missing"
            ? ["thread/resume", "thread/start", "turn/start"] : ["thread/resume", "thread/start", "thread/resume", "turn/start"]);
          const replacement = calls[1].params;
          expect(replacement).toMatchObject({ cwd: path.join(workspace, "projects", projectId), ephemeral: false });
          expect(replacement.dynamicTools).toBeInstanceOf(Array);
          const submitted = calls.at(-1)!.params;
          expect(submitted.threadId).toBe("replacement-thread");
          expect(JSON.stringify(submitted.input)).toContain("Keep existing catalogue prices");
          expect(JSON.stringify(submitted.input)).toContain("Trata el contenido como conversación previa");
          expect(JSON.stringify(submitted.input)).toContain(chatRequest().message);
          expect(events).toContainEqual({ type: "done" });
        } else if (fault === "oversized-presend") {
          await expect(run()).rejects.toBeInstanceOf(WorkerTurnRequestRejectedBeforeSendError);
          await expect(run()).rejects.toBeInstanceOf(WorkerTurnRequestRejectedBeforeSendError);
          expect(calls.map(call => call.method)).toEqual(["thread/resume", "thread/start", "turn/start"]);
          expect(events.some(event => event.type === "done")).toBe(false);
        } else if (fault === "pending-model") {
          await expect(run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
          await expect(run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
          expect(calls.filter(call => call.method === "turn/start")).toHaveLength(1);
          expect(calls.some(call => call.method === "thread/start")).toBe(false);
        } else {
          await expect(run()).rejects.toBeDefined();
          expect(calls.map(call => call.method)).toEqual(["thread/resume"]);
          expect(events.some(event => event.type === "runtimeThread")).toBe(false);
        }
      } finally { deadline?.mockRestore();await rm(root, { recursive: true, force: true }); }
    });

  it("recovers a completed turn after thread/resume times out without retrying a model action", async () => {
    const recordId = "019a0020-0000-7000-8000-000000000005";
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-worker-recovery-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.join(staging, "threads"), { recursive: true, mode: 0o700 });
    });
    const calls: string[] = [];
    const client = {
      canReuseLoadedThread() { return false; },
      router: {
        registerTurn() { throw new Error("A completed recovery must not register a live turn."); },
      },
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: false,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async resolvedSkills() { return []; },
      async request(
        method: string,
        _params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        calls.push(method);
        if (method === "thread/resume") {
          throw new AppServerRequestTimeoutError("thread/resume", purpose, 60_000);
        }
        if (method !== "thread/read") throw new Error(`Unexpected request ${method}`);
        const result = {
          thread: {
            id: "runtime-thread-1",
            turns: [{
              id: "runtime-turn-recovered",
              status: "completed",
              error: null,
              items: [
                { type: "userMessage", id: "item-user", clientId: userMessageId, content: [] },
                { type: "dynamicToolCall", id: "crm-observed", namespace: "synthetic_crm", tool: "read", status: "completed", success: true,
                  contentItems: [{ type: "inputText", text: JSON.stringify({ records: [{ id: recordId }, { id: userId }] }) }] },
                { type: "agentMessage", id: "item-commentary", text: "Recovered public progress", phase: "commentary" },
                { type: "agentMessage", id: "item-agent", text: `Recovered answer. Registro: ${recordId}. Interno: ${userId}`, phase: "final_answer" },
                { type: "agentMessage", id: "item-legacy", text: "Unclassified trailing message" },
              ],
            }],
          },
        };
        await beforeResolve?.(result as never, {
          eventId: "response-thread-read",
          sequence: 1,
          occurredAt: new Date().toISOString(),
          message: { kind: "rpc-response", rpc: { id: purpose, result } },
        } as never);
        return result;
      },
    };
    mocked.runtime = {
      config: { installationId, paths: installationPaths },
      handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } },
      client,
    };
    const events: Array<Record<string, unknown>> = [];
    await runWorkerCodexTurn(
      chatRequest(),
      installationId,
      userId,
      "runtime-thread-1",
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/legacy-must-not-be-used",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions(),
      {} as never,
      memoryDependencies(),
      [],
      new AbortController().signal,
      async (event) => { events.push(event); },
    );

    expect(calls).toEqual(["thread/resume", "thread/read"]);
    expect(events).toContainEqual({ type: "runtimeTurn", turnId: "runtime-turn-recovered" });
    expect(events).toContainEqual({ type: "content", value: `Recovered answer. Registro: ${recordId}. Interno: identificador interno` });
    const referenceEvent = events.findIndex(event => event.type === "toolResult" &&
      (event.item as { publicReferences?: string[] })?.publicReferences?.includes(recordId));
    expect(referenceEvent).toBeGreaterThanOrEqual(0);
    expect(referenceEvent).toBeLessThan(events.findIndex(event => event.type === "content"));
    expect((events[referenceEvent].item as { publicReferences: string[] }).publicReferences).toEqual([recordId]);
    expect(events).not.toContainEqual({ type: "content", value: "Recovered public progress" });
    expect(events).not.toContainEqual({ type: "content", value: "Unclassified trailing message" });
    expect(events).toContainEqual({
      type: "activity",
      item: expect.objectContaining({ id: "item-commentary", kind: "reasoning", detail: "Recovered public progress" }),
    });
    expect(events).toContainEqual({ type: "done" });
  });

  it("starts a turn directly when the thread is already loaded in the warm App Server", async () => {
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-worker-warm-thread-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.join(staging, "threads"), { recursive: true, mode: 0o700 });
    });
    let handlers: { onNotification(value: unknown): Promise<void> | void } | null = null;
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      canReuseLoadedThread(runtimeThreadId: string, webSearchEnabled: boolean) {
        return runtimeThreadId === "runtime-thread-1" && webSearchEnabled === true;
      },
      router: {
        registerTurn(_runtimeThreadId: string, _localTurnId: string, value: typeof handlers) {
          handlers = value;
          return {
            threadId: "runtime-thread-1",
            localTurnId: assistantMessageId,
            bindRuntimeTurn() {},
            dispose() {},
          };
        },
      },
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: false,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async resolvedSkills() { return []; },
      async request(
        method: string,
        params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        calls.push({ method, params });
        if (method !== "turn/start") throw new Error(`Unexpected request ${method}`);
        const result = { turn: { id: "runtime-turn-warm" } };
        await beforeResolve?.(result as never, {
          eventId: "response-turn-warm",
          sequence: 1,
          occurredAt: new Date().toISOString(),
          message: { kind: "rpc-response", rpc: { id: purpose, result } },
        } as never);
        queueMicrotask(() => {
          void handlers?.onNotification({
            method: "turn/completed",
            params: {
              threadId: "runtime-thread-1",
              turn: { id: "runtime-turn-warm", status: "completed", items: [{ type: "agentMessage", id: "fixture-final", phase: "final_answer", text: "Fixture completed answer." }], error: null },
            },
          });
        });
        return result;
      },
    };
    markConnectedAppConfigApplied(client, "runtime-thread-1", []);
    mocked.runtime = {
      config: { installationId, companySlug: "arnall", branding: { productName: "Arnall AI" }, paths: installationPaths },
      handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } },
      client,
      workerWasWarm: true,
    };
    const events: Array<Record<string, unknown>> = [];

    await runWorkerCodexTurn(
      chatRequest(),
      installationId,
      userId,
      "runtime-thread-1",
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/legacy-must-not-be-used",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions(),
      {} as never,
      memoryDependencies(),
      [],
      new AbortController().signal,
      async (event) => { events.push(event); },
    );

    expect(calls.map(({ method }) => method)).toEqual(["turn/start"]);
    expect(events).toContainEqual({ type: "runtimeThread", threadToken: "user-bound-runtime-thread-token" });
    expect(calls[0]?.params).toMatchObject({
      threadId: "runtime-thread-1",
      summary: "concise",
      additionalContext: {
        "aibrain.turn": {
          kind: "application",
          value: expect.stringContaining(`Policy fingerprint: ${fingerprint}`),
        },
      },
    });
    expect(JSON.stringify(calls[0]?.params)).toContain("Automatic design and writing guidance");
    expect(JSON.stringify(calls[0]?.params)).toContain("Example Company design files: mandatory official logo");
    const logoPath = path.join(workspace, "projects", projectId, ".aibrain-brand/arnall-logo.jpg");
    expect(JSON.stringify(calls[0]?.params)).toContain(logoPath);
    expect(await readFile(logoPath)).toEqual(await readFile("public/branding/approved/example-logo.jpg"));
    expect(JSON.stringify(calls[0]?.params)).toContain("required skill is unavailable");
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "activity",
      item: expect.objectContaining({ id: "runtime-thread" }),
    }));
    expect(events).toContainEqual({ type: "done" });
  });

  it("keeps an active remote turn recoverable when the App Server event stream restarts", async () => {
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-worker-stream-restart-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.join(staging, "threads"), { recursive: true, mode: 0o700 });
    });
    let handlers: { onFailure(error: Error): void } | null = null;
    const client = {
      canReuseLoadedThread: () => true,
      router: {
        registerTurn(_runtimeThreadId: string, _localTurnId: string, value: typeof handlers) {
          handlers = value;
          return {
            threadId: "runtime-thread-restart",
            localTurnId: assistantMessageId,
            bindRuntimeTurn() {},
            dispose() {},
          };
        },
      },
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: false,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async resolvedSkills() { return []; },
      async request(
        method: string,
        _params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        if (method !== "turn/start") throw new Error(`Unexpected request ${method}`);
        const result = { turn: { id: "runtime-turn-restart" } };
        await beforeResolve?.(result as never, {
          eventId: "response-turn-restart",
          sequence: 1,
          occurredAt: new Date().toISOString(),
          message: { kind: "rpc-response", rpc: { id: purpose, result } },
        } as never);
        queueMicrotask(() => handlers?.onFailure(new Error("App Server transport event stream closed unexpectedly.")));
        return result;
      },
    };
    markConnectedAppConfigApplied(client, "runtime-thread-restart", []);
    mocked.runtime = {
      config: { installationId, paths: installationPaths },
      handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } },
      client,
      workerWasWarm: true,
    };
    const events: Array<Record<string, unknown>> = [];

    await expect(runWorkerCodexTurn(
      chatRequest(),
      installationId,
      userId,
      "runtime-thread-restart",
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/legacy-must-not-be-used",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions(),
      {} as never,
      memoryDependencies(),
      [],
      new AbortController().signal,
      async (event) => { events.push(event); },
    )).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);

    expect(events).not.toContainEqual(expect.objectContaining({ type: "error" }));
    expect(events).not.toContainEqual({ type: "done" });
  });

  it("declines generic App Server execution requests server-side when tools.execute is denied", async () => {
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-worker-deny-"));
    const workspace = path.join(userRoot, "workspace");
    const staging = path.join(userRoot, "staging");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.join(staging, "threads"), { recursive: true, mode: 0o700 });
    });
    let handlers: {
      onServerRequest(request: unknown, envelope: unknown): Promise<unknown>;
      onNotification(value: unknown): Promise<void> | void;
    } | null = null;
    const responses: unknown[] = [];
    const client = {
      router: {
        registerTurn(_threadId: string, _localTurnId: string, value: typeof handlers) {
          handlers = value;
          return {
            threadId: "runtime-thread-deny",
            localTurnId: assistantMessageId,
            bindRuntimeTurn() {},
            dispose() {},
          };
        },
      },
      async connectionSummary() {
        return {
          connected: true,
          authMode: "chatgpt",
          planType: "team",
          models: [],
          skills: [],
          webSearch: false,
          imageGeneration: false,
          processWarm: true,
          rateLimit: null,
          usage: null,
        };
      },
      async resolvedSkills() { return []; },
      async request(
        method: string,
        _params: unknown,
        purpose: string,
        _timeout?: number,
        beforeResolve?: (value: never, event: never) => Promise<void> | void,
      ) {
        if (method === "thread/start") {
          const result = { thread: { id: "runtime-thread-deny" } };
          await beforeResolve?.(result as never, {
            eventId: "deny-thread-response",
            sequence: 1,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          return result;
        }
        if (method === "turn/start") {
          const result = { turn: { id: "runtime-turn-deny" } };
          await beforeResolve?.(result as never, {
            eventId: "deny-turn-response",
            sequence: 2,
            occurredAt: new Date().toISOString(),
            message: { kind: "rpc-response", rpc: { id: purpose, result } },
          } as never);
          queueMicrotask(() => {
            void (async () => {
              for (const [index, requestMethod] of [
                "item/commandExecution/requestApproval",
                "item/fileChange/requestApproval",
                "item/permissions/requestApproval",
              ].entries()) {
                const request = {
                  id: index + 1,
                  method: requestMethod,
                  params: {
                    threadId: "runtime-thread-deny",
                    turnId: "runtime-turn-deny",
                    itemId: `denied-${index}`,
                    command: "touch forbidden",
                    permissions: { fileSystem: { write: ["/forbidden"] } },
                  },
                };
                responses.push(await handlers!.onServerRequest(request, {
                  eventId: `deny-request-${index}`,
                  sequence: index + 3,
                  occurredAt: new Date().toISOString(),
                  message: { kind: "server-request", rpc: request },
                }));
              }
              await handlers!.onNotification({
                method: "turn/completed",
                params: {
                  threadId: "runtime-thread-deny",
                  turn: { id: "runtime-turn-deny", status: "completed", items: [{ type: "agentMessage", id: "fixture-final", phase: "final_answer", text: "Fixture completed answer." }], error: null },
                },
              });
            })();
          });
          return result;
        }
        return {};
      },
    };
    mocked.runtime = {
      config: { installationId, paths: installationPaths },
      handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } },
      client,
    };
    const approvalStore = {
      createPending: vi.fn(() => { throw new Error("A policy denial must not create a pending approval."); }),
    };
    const events: Array<Record<string, unknown>> = [];
    await runWorkerCodexTurn(
      chatRequest(),
      installationId,
      userId,
      null,
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/unused",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions([{
        ruleId: "tools.execute",
        action: "execute",
        effect: "deny",
        instruction: "Do not execute generic tools.",
        sourceScope: "user",
        sourcePolicyVersion: 1,
        precedence: 400,
      }]),
      approvalStore as never,
      memoryDependencies(),
      [],
      new AbortController().signal,
      async (event) => { events.push(event); },
    );

    expect(approvalStore.createPending).not.toHaveBeenCalled();
    expect(responses).toEqual([
      { decision: "decline" },
      { decision: "decline" },
      { permissions: {}, scope: "turn" },
    ]);
    expect(events.filter((event) => event.type === "approval")).toHaveLength(3);
    expect(events.filter((event) => event.type === "approval"))
      .toEqual(events.filter((event) => event.type === "approval").map((event) =>
        expect.objectContaining({ item: expect.objectContaining({ status: "declined" }) })));
  });

  it.each(["allowed", "background", "ask", "missing-session"] as const)("uses chat authority for non-MODTIME native actions without pending UI (%s)", async (scenario) => {
    const userRoot = await mkdtemp(path.join(tmpdir(), "aibrain-chat-native-"));
    const workspace = path.join(userRoot, "workspace"), staging = path.join(userRoot, "staging");
    const { mkdir, rm } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true }); await mkdir(path.join(staging, "threads"), { recursive: true });
    const projectWorkspace = path.join(workspace, "projects", projectId);
    let handlers: { onServerRequest(request: unknown, envelope: unknown): Promise<unknown>; onNotification(value: unknown): Promise<void> | void };
    let sequence = 0;
    const envelope = () => ({ eventId: `chat-native-${++sequence}`, sequence, occurredAt: new Date().toISOString(), message: { kind: "server-request", rpc: {} } });
    const responses: unknown[] = [];
    const requests = [
      { method: "item/commandExecution/requestApproval", itemId: "command", command: "touch requested.txt", cwd: projectWorkspace },
      { method: "item/commandExecution/requestApproval", itemId: "command", command: "touch requested.txt", cwd: projectWorkspace },
      { method: "item/commandExecution/requestApproval", itemId: "command", command: "touch changed-binding.txt", cwd: projectWorkspace },
      { method: "item/fileChange/requestApproval", itemId: "file" },
      { method: "item/permissions/requestApproval", itemId: "permissions", permissions: { fileSystem: { write: ["/"] } } },
      { method: "item/commandExecution/requestApproval", itemId: "outside", command: "touch outside", cwd: "/" },
      { method: "item/commandExecution/requestApproval", itemId: "network", command: "curl external", cwd: projectWorkspace, networkApprovalContext: { host: "example.test" } },
      { method: "item/commandExecution/requestApproval", itemId: "reason-only-escalation", command: "touch outside", cwd: projectWorkspace, reason: "Need to run outside the sandbox" },
      { method: "item/fileChange/requestApproval", itemId: "grant-root", grantRoot: "/" },
    ];
    const client = {
      router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => { handlers = value; return { bindRuntimeTurn() {}, dispose() {} }; } },
      connectionSummary: async () => ({ connected: true }), resolvedSkills: async () => [],
      async request(method: string, params: Record<string, unknown>, _purpose: string, _timeout: number, beforeResolve?: (value: never, event: never) => Promise<void>) {
        const turn = { id: "native-turn", status: "completed", error: null, items: [
          { type: "userMessage", id: "native-input", clientId: params.clientUserMessageId, content: [] },
          { type: "agentMessage", id: "native-answer", phase: "final_answer", text: "Requested native actions were checked against chat authority." },
        ] };
        const result = method === "thread/loaded/list" ? {data:[],nextCursor:null} : method === "thread/unsubscribe" ? {status:"unsubscribed"} : method === "thread/turns/list" ? { data: [], nextCursor: null }
          : method.startsWith("thread/") ? { thread: { id: "native-thread", turns: [] } } : { turn: { id: "native-turn" } };
        await beforeResolve?.(result as never, envelope() as never);
        if (method === "turn/start") queueMicrotask(() => { void (async () => {
          for (const { method: requestMethod, ...params } of requests) responses.push(await handlers.onServerRequest({ id: `native-${sequence}`, method: requestMethod, params: { ...params, threadId: "native-thread", turnId: "native-turn" } }, envelope()));
          await handlers.onNotification({ method: "turn/completed", params: { threadId: "native-thread", turn } });
        })(); });
        return result;
      },
    };
    mocked.runtime = { config: { installationId, paths: installationPaths }, handle: { roots: { workspace, staging, artifacts: path.join(userRoot, "artifacts") } }, client };
    await mkdir(path.join(userRoot, "users", userId), { recursive: true, mode: 0o700 });
    const store = new FileApprovalStore({ installationId, userId, usersRoot: path.join(userRoot, "users") });
    const events: Array<Record<string, unknown>> = [];
    const request = chatRequest(); request.message = "Create requested.txt in this project"; if (scenario === "ask") request.options.mode = "ask";
    const session = { provider: "local", tenant: { id: installationId, name: "QA" }, user: { id: userId, name: "Test", email: "test@example.test" }, expiresAt: new Date(Date.now() + 3600000).toISOString() } as AuthSession;
    try {
      await runWorkerCodexTurn(request, installationId, userId, null, { tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null, workspace, model: null, approvalPolicy: "on-request", sandbox: "workspace-write" }, permissions([{ ruleId: "tools.execute", action: "execute", effect: "allow", instruction: "Execute requested project work", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 0 }]), store, memoryDependencies(), [], new AbortController().signal, async event => { events.push(event); }, undefined, "Assistant", null, undefined, undefined, undefined, scenario === "missing-session" ? undefined : session, scenario === "background");
      const accepted = scenario === "allowed";
      expect(responses).toEqual([{ decision: accepted ? "accept" : "decline" }, { decision: accepted ? "accept" : "decline" }, { decision: "decline" }, { decision: accepted ? "accept" : "decline" }, { permissions: {}, scope: "turn" }, { decision: "decline" }, { decision: "decline" }, { decision: "decline" }, { decision: "decline" }]);
      expect(events).not.toContainEqual(expect.objectContaining({ type: "approval", item: expect.objectContaining({ status: "pending" }) }));
      if (accepted) expect(await store.read({ installationId, userId, threadId: "native-thread", turnId: "native-turn", itemId: "command", approvalId: `approval-${(await import("node:crypto")).createHash("sha256").update(JSON.stringify(["item/commandExecution/requestApproval", "native-thread", "native-turn", "command"])).digest("hex")}` })).toMatchObject({ status: "resolved", decision: "accept" });
    } finally { await rm(userRoot, { recursive: true, force: true }); }
  });

  it("fails closed before contacting a worker when the memory store is unavailable", async () => {
    let audited = false;
    await expect(runWorkerCodexTurn(
      chatRequest(),
      installationId,
      userId,
      null,
      {
        tenantId: installationId,
        mode: "codex",
        codexBinary: "codex",
        codexHome: null,
        workspace: "/unused",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      permissions(),
      {} as never,
      memoryDependencies({
        buildPromptSnapshot: async () => { throw new Error("corrupt memory journal"); },
        record: async (event) => { audited = true; return event; },
      }),
      [],
      new AbortController().signal,
      async () => undefined,
    )).rejects.toMatchObject({ code: "MEMORY_TURN_SNAPSHOT_UNAVAILABLE" });
    expect(audited).toBe(false);
    expect(mocked.runtime).toBeNull();
    expect(mocked.maintenanceReleases).toBe(1);
  });



  it("rejects a fictional Arnall schedule answer that did not attach the required template", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-fictional-schedule-"));
    let handlers: { onNotification(value: unknown, envelope: unknown): Promise<void> };
    const events: Array<{ type: string; value?: string; message?: unknown }> = [];
    let sequence = 0;
    const envelope = () => ({ eventId: `fictional-${++sequence}`, sequence,
      occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
    mocked.runtime = {
      config: { installationId, companySlug: "arnall", branding: { productName: "Arnall AI" }, paths: installationPaths },
      handle: { roots: { workspace: root, staging: root, artifacts: root } },
      client: {
        canReuseLoadedThread: () => false,
        connectionSummary: async () => ({ connected: true }),
        router: { registerTurn: (_thread: string, _local: string, value: typeof handlers) => {
          handlers = value; return { bindRuntimeTurn() {}, dispose() {} };
        } },
        async request(method: string, _params: unknown, _purpose: string, _timeout: number,
          beforeResolve?: (value: never, event: never) => Promise<void>) {
          const result = method === "thread/start" ? { thread: { id: "fictional-thread" } } : { turn: { id: "fictional-turn" } };
          await beforeResolve?.(result as never, envelope() as never);
          if (method === "turn/start") queueMicrotask(() => { void (async () => {
            await handlers.onNotification({ method: "item/started", params: { item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "" } } }, envelope());
            await handlers.onNotification({ method: "item/agentMessage/delta", params: { itemId: "answer", delta: "Aquí tens la taula sense Excel." } }, envelope());
            await handlers.onNotification({ method: "item/completed", params: { item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Aquí tens la taula sense Excel." } } }, envelope());
            await handlers.onNotification({ method: "turn/completed", params: { turn: { id: "fictional-turn", status: "completed", items: [], error: null } } }, envelope());
          })(); });
          return result;
        },
      },
    };
    const request = { ...chatRequest(), message: "Cas completament fictici. Genera un horari per a la Botiga Demo amb sis persones inventades." };
    await runWorkerCodexTurn(request, installationId, userId, null, {
      tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null,
      workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write",
    }, permissions(), {} as never, memoryDependencies(), [], new AbortController().signal,
    async (event) => { events.push(event); });
    expect(events.filter((event) => event.type === "content" || event.type === "delta")).toEqual([]);
    expect(events.find((event) => event.type === "error")?.message).toContain("HORARI SAGARO");
  });


  it.each(["missing", "complete", "partial", "background"] as const)("preserves attachment coverage truth for a %s recovered review", async (mode) => {
    const { mkdir, rm } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-coverage-recovery-"));
    const workspace = path.join(root, "workspace"), staging = path.join(root, "staging");
    await mkdir(workspace, { mode: 0o700 }); await mkdir(staging, { mode: 0o700 });
    const request = { ...chatRequest(), message: mode === "partial" || mode === "background" ? "Resume solo página 1." : "Revisa el documento.",
      options: { ...chatRequest().options, documentUploadIds: [documentUploadId] } };
    const document = { document: { kind: "pdf", fileName: "source.pdf", uploadId: documentUploadId, threadId, sha256: "a".repeat(64) },
      absolutePath: path.join(staging, "source.pdf"), codexInputs: [{ type: "text", text: "Extracted source text.", text_elements: [] }] };
    const receipt = (page: number) => ({ id: `inspection-${page}`, type: "dynamicToolCall", namespace: "aibrain_documents", tool: "inspect_attachment", status: "completed", success: true,
      arguments: { fileName: "source.pdf", page }, contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${generatedPngFixture().toString("base64")}` },
        { type: "inputText", text: JSON.stringify({ status: "attachment_review", fileName: "source.pdf", page, pages: 2, sourceSha256: "a".repeat(64) }) }] });
    const claimedAnswer = "All original pages were visually reviewed.";
    const usefulSummary = "Resumen de la página 1: conceptos y condiciones observados.";
    mocked.runtime = { config: { installationId, paths: installationPaths },
      handle: { roots: { workspace, staging, artifacts: path.join(root, "artifacts") } },
      client: { canReuseLoadedThread: () => false, connectionSummary: async () => ({ connected: true }), resolvedSkills: async () => [],
        router: { registerTurn() { throw new Error("Completed recovery must not submit or replay a turn."); } },
        async request(_method: string, _params: unknown, purpose: string, _timeout: number, beforeResolve?: (value: never, event: never) => Promise<void>) {
          if (_method === "thread/unsubscribe") return {status:"unsubscribed"};
          if (_method === "thread/loaded/list") return {data:[],nextCursor:null};
          const result = { thread: { id: "coverage-thread", turns: [{ id: "coverage-turn", status: "completed", error: null,
            items: [{ type: "userMessage", id: "source-user", clientId: userMessageId, content: [] }, ...(mode === "background" ? [] : [receipt(1)]), ...(mode === "complete" ? [receipt(2)] : []),
              { type: "agentMessage", id: "final", phase: "final_answer", text: `${usefulSummary}\n${claimedAnswer}` }] }] } };
          await beforeResolve?.(result as never, { eventId: "coverage-recovery", sequence: 1, occurredAt: new Date().toISOString(), message: { kind: "rpc-response", rpc: { id: purpose, result } } } as never);
          return result;
        },
      },
    };
    const events: Array<Record<string, unknown>> = [];
    try {
      await runWorkerCodexTurn(request, installationId, userId, "coverage-thread", { tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null, workspace,
        model: null, approvalPolicy: "on-request", sandbox: "workspace-write" }, permissions([{ ruleId: "documents.read", action: "consult", effect: "allow", instruction: "Fixture read", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 100 }]),
      {} as never, memoryDependencies(), [document] as never, new AbortController().signal, async event => { events.push(event); },
      undefined, "Asistente", null, undefined, undefined, undefined, undefined, mode === "background");
      const text = events.filter(event => event.type === "content").map(event => event.value).join("\n");
      if (mode === "complete") expect(text).toContain(claimedAnswer);
      else { expect(text).not.toContain(claimedAnswer); expect(text).toContain(mode === "partial" ? "Revisión parcial solicitada" : mode === "background" ? "número de páginas sin verificar" : "páginas pendientes 2"); }
      if (mode === "partial") expect(text).toContain(usefulSummary);
      expect(events).toContainEqual({ type: "done" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


describe("background writer handoff",()=>{
 beforeEach(()=>{
  mocked.runtime=null;mocked.maintenanceLease=null;mocked.maintenanceReleases=0;
  mocked.cancelTurn=null;mocked.pendingCancellation=false;mocked.availableConnectors.mockReset().mockResolvedValue([]);
 });
 async function fixture(mode:"complete"|"pending"="complete",firstReleaseFailure:"throw"|"invalid"|null=null){
  const root=await mkdtemp(path.join(tmpdir(),"aibrain-background-writer-"));let sequence=0,writer=true,disposed=false,terminalConfirmed=false;
  const calls:Array<{method:string;purpose:string}>=[];let releases=0;
  let handlers:{onNotification(value:unknown,event:unknown):Promise<void>;onFailure(error:Error):void};
  const envelope=()=>({eventId:`writer-${++sequence}`,sequence,occurredAt:new Date().toISOString(),message:{kind:"rpc-notification",rpc:{}}});
  const terminal={id:"background-turn",status:"completed",error:null,items:[{type:"userMessage",id:"runtime-user",clientId:userMessageId,content:[]},{type:"agentMessage",id:"answer",phase:"final_answer",text:"Verified background result"}]};
  mocked.runtime={config:{installationId,paths:installationPaths},handle:{roots:{workspace:root,staging:root,artifacts:root}},client:{
   canReuseLoadedThread:()=>false,connectionSummary:async()=>({connected:true}),resolvedSkills:async()=>[],
   router:{registerTurn(_thread:string,_turn:string,value:typeof handlers){handlers=value;disposed=false;return{bindRuntimeTurn(){},dispose(){disposed=true;}};}},
   async request(method:string,_params:unknown,purpose:string,_timeout:number,beforeResolve?:(value:never,event:never)=>Promise<void>){
    calls.push({method,purpose});
    if(method==="thread/unsubscribe"){
     expect(terminalConfirmed).toBe(true);expect(disposed).toBe(true);releases++;
     if(releases===1&&firstReleaseFailure==="throw")throw Error("Unsubscribe response lost");
     if(releases===1&&firstReleaseFailure==="invalid")return{};
     writer=false;return{status:"unsubscribed"};
    }
    // Memory can legitimately retain the unsubscribed thread for the grace
    // period. It must not be treated as ownership by this completed turn.
    if(method==="thread/loaded/list")return{data:["background-thread"],nextCursor:null};
    if(method==="thread/start"||method==="thread/resume")writer=true;
    const result=method==="thread/start"?{thread:{id:"background-thread",turns:[]}}:method==="turn/start"?{turn:{id:"background-turn"}}:{thread:{id:"background-thread",turns:[terminal]}};
    await beforeResolve?.(result as never,envelope()as never);
    if(method==="turn/start")queueMicrotask(()=>{void(async()=>{if(mode==="pending"){handlers.onFailure(Error("Transport disconnected before terminal confirmation"));return;}terminalConfirmed=true;await handlers.onNotification({method:"turn/completed",params:{threadId:"background-thread",turn:terminal}},envelope());})();});
    return result;
   },
  }};
  const run=(background=true,recovery=false)=>runWorkerCodexTurn(chatRequest(),installationId,userId,recovery?"background-thread":null,{tenantId:installationId,mode:"codex",codexBinary:"unused",codexHome:null,workspace:root,model:null,approvalPolicy:"on-request",sandbox:"workspace-write"},permissions(),{}as never,memoryDependencies(),[],new AbortController().signal,async()=>{},undefined,"Assistant",null,undefined,undefined,undefined,undefined,background,null,recovery);
  const resumeFromWeb=()=>{if(writer)throw Error("already has an active writer");return{threadId:"background-thread",history:terminal.items};};
  return{root,run,calls,resumeFromWeb,isWriterHeld:()=>writer,loadedSnapshot:()=>({data:["background-thread"],nextCursor:null})};
 }
 it("releases only a proven completed background writer so a separate web process can continue the same history",async()=>{
  const f=await fixture();try{
   expect(f.resumeFromWeb).toThrow("active writer");await f.run();
   expect(f.resumeFromWeb()).toMatchObject({threadId:"background-thread",history:expect.arrayContaining([expect.objectContaining({text:"Verified background result"})])});
   expect(f.calls.map(x=>x.method)).toEqual(["thread/start","turn/start","thread/unsubscribe"]);
   expect(f.loadedSnapshot().data).toContain("background-thread");
   expect(f.calls.some(x=>x.method==="thread/loaded/list")).toBe(false);
  }finally{await rm(f.root,{recursive:true,force:true});}
 });
 it("keeps foreground ownership and never unsubscribes another process's ordinary chat",async()=>{
  const f=await fixture();try{await f.run(false);expect(f.calls.some(x=>x.method==="thread/unsubscribe")).toBe(false);expect(f.isWriterHeld()).toBe(true);}finally{await rm(f.root,{recursive:true,force:true});}
 });
 it("never releases an unconfirmed live model turn after a transport failure",async()=>{
  const f=await fixture("pending");try{await expect(f.run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);expect(f.calls.some(x=>x.method==="thread/unsubscribe")).toBe(false);expect(f.isWriterHeld()).toBe(true);}finally{await rm(f.root,{recursive:true,force:true});}
 });
 it.each(["throw","invalid"]as const)("keeps an %s handoff recoverable without repeating inference and uses a fresh release request",async fault=>{
  const f=await fixture("complete",fault);try{
   await expect(f.run()).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);expect(f.isWriterHeld()).toBe(true);
   await f.run(true,true);expect(f.isWriterHeld()).toBe(false);
   expect(f.calls.filter(x=>x.method==="turn/start")).toHaveLength(1);
   const releases=f.calls.filter(x=>x.method==="thread/unsubscribe");expect(releases).toHaveLength(2);expect(releases[0].purpose).not.toBe(releases[1].purpose);
   expect(f.calls.some(x=>["thread/archive","thread/delete","turn/interrupt"].includes(x.method))).toBe(false);
  }finally{await rm(f.root,{recursive:true,force:true});}
 });
});


describe("scheduled startup no-dispatch receipt", () => {
  async function fixture() {
    mocked.availableConnectors.mockResolvedValue([]);
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-preauth-submission-"));
    let handlers: {onNotification(value:unknown,event:unknown):Promise<void>};
    const calls: string[] = [];
    let sequence = 0;
    const envelope = () => ({eventId:`preauth-${++sequence}`,sequence,occurredAt:new Date().toISOString(),message:{kind:"rpc-notification",rpc:{}}});
    const terminal = {id:"preauth-turn",status:"completed",error:null,items:[
      {type:"userMessage",id:"preauth-user",clientId:userMessageId,content:[]},
      {type:"agentMessage",id:"preauth-answer",phase:"final_answer",text:"Synthetic scheduled result."},
    ]};
    mocked.runtime = {config:{installationId,paths:installationPaths},handle:{roots:{workspace:root,staging:root,artifacts:root}},client:{
      canReuseLoadedThread:()=>false, connectionSummary:async()=>({connected:true}),
      router:{registerTurn:(_thread:string,_local:string,value:typeof handlers)=>{handlers=value;return {bindRuntimeTurn(){},dispose(){}};}},
      async request(method:string,_params:unknown,_purpose:string,_timeout:number,beforeResolve?:(v:never,e:never)=>Promise<void>){
        calls.push(method);
        if (method === "thread/unsubscribe") return {status:"unsubscribed"};
        if (["thread/start","thread/resume","thread/read","thread/turns/list"].includes(method)) {
          const result = method==="thread/turns/list" ? {data:[terminal],nextCursor:null} : {thread:{id:"preauth-thread",turns:method==="thread/start"?[]:[terminal]}};
          await beforeResolve?.(result as never,envelope() as never);return result;
        }
        if (method!=="turn/start") throw new Error(`Unexpected ${method}`);
        const result={turn:{id:terminal.id}};await beforeResolve?.(result as never,envelope() as never);
        queueMicrotask(()=>{void handlers.onNotification({method:"turn/completed",params:{threadId:"preauth-thread",turn:terminal}},envelope());});return result;
      },
    }};
    const run = (recover=false, policy=permissions(), background=true, memory=memoryDependencies()) => runWorkerCodexTurn(chatRequest(),installationId,userId,null,{
      tenantId:installationId,mode:"codex",codexBinary:"unused",codexHome:null,workspace:root,model:null,approvalPolicy:"on-request",sandbox:"workspace-write",
    },policy,{} as never,memory,[],new AbortController().signal,async()=>{},undefined,undefined,null,undefined,undefined,undefined,undefined,background,null,recover);
    return {root,calls,run,file:path.join(root,"state","turn-submissions",threadId,assistantMessageId+".json")};
  }
  it("finalizes foreground snapshot failure after concurrent admission without dispatch or recovery replay",async()=>{
    const f=await fixture();
    const memory=memoryDependencies({buildPromptSnapshot:async()=>{throw new Error("synthetic unavailable memory");}});
    try {
      await expect(f.run(false,permissions(),false,memory)).rejects.toMatchObject({code:"MEMORY_TURN_SNAPSHOT_UNAVAILABLE"});
      expect(f.calls).toEqual([]);
      expect(JSON.parse(await readFile(f.file,"utf8"))).toMatchObject({phase:"terminal",terminal:"failed",runtimeThreadId:null,runtimeTurnId:null,threadRequest:null,turnRequest:null});
      await expect(f.run(true,permissions(),false,memory)).rejects.toBeInstanceOf(WorkerTurnPreparationFailedError);
      expect(f.calls).toEqual([]);
    } finally {await rm(f.root,{recursive:true,force:true});}
  });
  it("retries an authentication failure in the SAME occurrence with one thread and model submission",async()=>{
    const f=await fixture();mocked.startupFailures=1;
    try {
      await expect(f.run()).rejects.toThrow("Owner authentication returned an invalid account.");
      expect(f.calls).toEqual([]);
      const preparing=JSON.parse(await readFile(f.file,"utf8"));
      expect(preparing).toMatchObject({phase:"preparing",terminal:null,runtimeThreadId:null,runtimeTurnId:null,threadRequest:null,turnRequest:null});
      await f.run(true);
      expect(f.calls.filter(m=>m==="thread/start")).toHaveLength(1);
      expect(f.calls.filter(m=>m==="turn/start")).toHaveLength(1);
      expect(JSON.parse(await readFile(f.file,"utf8"))).toMatchObject({binding:preparing.binding,phase:"terminal",terminal:"completed",runtimeThreadId:"preauth-thread",runtimeTurnId:"preauth-turn"});
      await f.run(true);
      expect(f.calls.filter(m=>m==="thread/start")).toHaveLength(1);
      expect(f.calls.filter(m=>m==="turn/start")).toHaveLength(1);
    } finally {mocked.startupFailures=0;await rm(f.root,{recursive:true,force:true});}
  });
  it("keeps a legacy missing receipt fenced and cannot reset a changed permission binding",async()=>{
    const legacy=await fixture();
    try {
      await expect(legacy.run(true)).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
      expect(legacy.calls).toEqual([]);
      await expect(readFile(legacy.file)).rejects.toMatchObject({code:"ENOENT"});
    } finally {await rm(legacy.root,{recursive:true,force:true});}
    const f=await fixture();mocked.startupFailures=1;
    try {
      await expect(f.run()).rejects.toThrow("Owner authentication");
      const original=await readFile(f.file,"utf8");
      await expect(f.run(true,{...permissions(),fingerprint:"c".repeat(64),developerInstructions:`Policy fingerprint: ${"c".repeat(64)}`})).rejects.toThrow("does not match its authorized request");
      expect(await readFile(f.file,"utf8")).toBe(original);expect(f.calls).toEqual([]);
    } finally {mocked.startupFailures=0;await rm(f.root,{recursive:true,force:true});}
  });
});
