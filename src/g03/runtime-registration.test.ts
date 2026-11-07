import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { ChatRequest } from "@/lib/chat-contract";
import type { ResolvedPermissions } from "@/permissions";
import type { WorkerTurnMemoryDependencies } from "@/runtime/memory-turn";

const mocked = vi.hoisted(() => ({ runtime: null as unknown, availableConnectors: vi.fn(async () => []) }));
vi.mock("server-only", () => ({}));
vi.mock("@/connectors/mentions", () => ({ resolveAvailableConnectorsForTurn: mocked.availableConnectors }));
vi.mock("@/auth/session", () => ({ getSigningSecret: () => "synthetic-g03-signing-secret-at-least-32-bytes" }));
vi.mock("@/runtime/worker-runtime-service", () => ({
  acquireWorkerTurnActivity: async () => ({ activityId: "qa-lease", release() {} }),
  workerAppServerForUser: async (_userId: string, _lease: unknown, beforeInitialize?: (context: unknown) => Promise<void>) => {
    const runtime = mocked.runtime as {config: unknown; handle: {roots: unknown}};
    await beforeInitialize?.({config: runtime.config, roots: runtime.handle.roots});
    return runtime;
  },
  registerWorkerTurnCancellation: () => () => {},
}));
vi.mock("@/runtime/thread-token", () => ({ CURRENT_THREAD_TOOLSET_REVISION: "base-revision", issueThreadToken: () => "synthetic-thread-token",
  toolsetRevisionForIssuedThreadToken: (id: string | null, revision: string | null) => id ? revision : "base-revision" }));
vi.mock("@/automations/chat-tools", async importOriginal => ({ ...await importOriginal<object>(), automationChatDeveloperInstructions: async () => "Synthetic QA, external automation disabled." }));

import * as g03 from "./dynamic-tools";
import * as desktop from "@/runtime/outlook-desktop-dynamic-tools";
import * as sage from "@/runtime/g03-sage-dynamic-tools";
import { runWorkerCodexTurn } from "@/runtime/worker-codex-turn";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("native worker registration/routing (mock RPC, not a real model)", () => {
  it.each(["normal-chat-session", "runtime-identity", "outlook-without-imap", "sage-foreground", "sage-background", "sage-ask", "sage-expired"])("binds G03 tools to the server identity through %s", async mode => {
    vi.stubEnv("AIBRAIN_G03_BRIDGE_CONFIG", "/synthetic/g03/bridge.json");
    const root = await mkdtemp(path.join(tmpdir(), "g03-worker-routing-")); roots.push(root);
    const isDesktop = mode === "outlook-without-imap", isSage = mode.startsWith("sage-");
    const installationId = isDesktop || isSage ? "g03-production" : "g03-rehearsal", userId = "03000000-0000-4000-8000-000000000001";
    const projectId = "03000000-0000-4000-8000-000000000011", threadId = "03000000-0000-4000-8000-000000000021", assistantMessageId = "03000000-0000-4000-8000-000000000031";
    const session: AuthSession = { provider: "local", user: { id: userId, name: "Synthetic employee", email: "qa@g03.example.test" }, tenant: { id: installationId, name: "G03 synthetic" }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    if (mode === "sage-expired") session.expiresAt = new Date(Date.now() - 1000).toISOString();
    const toolResult = { success: true, contentItems: [{ type: "inputText" as const, text: '{"mode":"synthetic-local"}' }] };
    const handler = vi.spyOn(g03, "handleG03Tool").mockResolvedValue(toolResult);
    const sageHandler = vi.spyOn(sage, "handleG03SageTool").mockResolvedValue(toolResult);
    const desktopHandler = vi.spyOn(desktop, "handleOutlookDesktopDynamicToolCall").mockResolvedValue(toolResult);
    let handlers: { onNotification(value: unknown, event: unknown): Promise<void>; onServerRequest(value: unknown, event: unknown): Promise<unknown> };
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let routed: unknown, sequence = 0;
    const envelope = () => ({ eventId: `g03-routing-${++sequence}`, sequence, occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } });
    mocked.runtime = { config: { installationId, ...(isDesktop ? { connectors: { mail: { enabled: true, provider: "nominalia" } } } : {}), paths: { companyContextRoot: path.join(root, "company"), sourceReadRoot: path.join(root, "source") } },
      handle: { roots: { userRoot: root, workspace: root, staging: root, artifacts: path.join(root, "artifacts") } }, client: {
        canReuseLoadedThread: () => false, connectionSummary: async () => ({ connected: true }),
        router: { registerTurn: (_thread: string, _turn: string, value: typeof handlers) => { handlers = value; return { bindRuntimeTurn() {}, dispose() {} }; } },
        async request(method: string, params: Record<string, unknown>, _purpose: string, _timeout: number, beforeResolve?: (value: never, event: never) => Promise<void>) {
          calls.push({ method, params });
          const result = method === "thread/loaded/list" ? { data: [], nextCursor: null } : method === "thread/unsubscribe" ? { status: "unsubscribed" } : method === "thread/start" ? { thread: { id: "runtime-g03" } } : { turn: { id: "turn-g03" } };
          await beforeResolve?.(result as never, envelope() as never);
          if (method === "turn/start") queueMicrotask(() => { void (async () => {
            routed = await handlers.onServerRequest({ id: "tool-1", method: "item/tool/call", params: { namespace: isSage ? "aibrain_g03_sage" : isDesktop ? "aibrain_outlook_desktop" : "g03_business", tool: isSage ? "prepare" : isDesktop ? "status" : "list_work_orders", arguments: {}, callId: "call-g03", threadId: "runtime-g03", turnId: "turn-g03" } }, envelope());
            await handlers.onNotification({ method: "turn/completed", params: { threadId: "runtime-g03", turn: { id: "turn-g03", status: "completed", items: [{ type: "agentMessage", id: "synthetic-final", phase: "final_answer", text: "Synthetic G03 routing completed." }], error: null } } }, envelope());
          })(); });
          return result;
        },
      } };
    const request: ChatRequest = { projectId, threadId, userMessageId: "03000000-0000-4000-8000-000000000041", assistantMessageId, message: "Consulta OF sintètiques", preferences: { tone: "direct", language: "ca", showActivity: true }, options: { mode: "agent", model: null, effort: null, webSearch: false, imageGeneration: false, skill: null, attachments: [] } };
    if (mode === "sage-ask") request.options.mode = "ask";
    const permissions: ResolvedPermissions = { schemaVersion: 1, installationId, userId, roleId: null, projectId, turnId: assistantMessageId, resolvedAt: new Date().toISOString(), fingerprint: "a".repeat(64), sources: [], rules: isSage ? [{ ruleId: "tools.execute", action: "execute", effect: "allow", instruction: "Execute requested chat actions", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 100 }] : [], developerInstructions: `Policy fingerprint: ${"a".repeat(64)}` };
    const memory = { memoryService: { buildPromptSnapshot: async () => ({ text: "{}", memoryIds: [], truncated: false }) }, auditSink: { record: async (event: unknown) => event } } as unknown as WorkerTurnMemoryDependencies;
    await runWorkerCodexTurn(request, installationId, userId, null, { tenantId: installationId, mode: "codex", codexBinary: "unused", codexHome: null, workspace: root, model: null, approvalPolicy: "on-request", sandbox: "workspace-write" }, permissions, {} as never, memory, [], new AbortController().signal, async () => {}, undefined, "Assistant", null, undefined, undefined,
      mode !== "runtime-identity" ? session : undefined, mode === "runtime-identity" || isSage ? session : undefined, mode === "sage-background");
    if (mode !== "sage-background") expect((calls.find(c => c.method === "thread/start")?.params.dynamicTools as unknown[])).toEqual(expect.arrayContaining([...g03.G03_DYNAMIC_TOOLS]));
    if (isSage) {
      // The HTTP foreground route supplies the same session in BOTH slots so
      // automation-management tools remain available; that is not a background run.
      expect(sageHandler).toHaveBeenCalledWith(expect.objectContaining({ namespace: "aibrain_g03_sage", tool: "prepare" }), expect.objectContaining({ installationId, userId, session, executeAllowed: true, allowWrites: mode === "sage-foreground", runtimeThreadId: "runtime-g03", runtimeTurnId: "turn-g03", requestId: request.userMessageId }));
    } else if (isDesktop) {
      expect((calls.find(c => c.method === "thread/start")?.params.dynamicTools as unknown[])).toEqual(expect.arrayContaining([...desktop.OUTLOOK_DESKTOP_DYNAMIC_TOOLS]));
      expect(desktopHandler).toHaveBeenCalledWith(expect.objectContaining({ namespace: "aibrain_outlook_desktop", tool: "status" }), expect.objectContaining({ installationId, userId, mailSelected: true, runtimeThreadId: "runtime-g03", runtimeTurnId: "turn-g03" }));
      expect(calls.find(c => c.method === "thread/start")?.params.developerInstructions).toContain("Pairing is independent of the Nominalia password");
    } else expect(handler).toHaveBeenCalledWith(expect.objectContaining({ namespace: "g03_business", tool: "list_work_orders" }), expect.objectContaining({ session, permissions, projectId, sourceThreadId: threadId, sourceTurnId: assistantMessageId, runtimeThreadId: "runtime-g03", runtimeTurnId: "turn-g03" }));
    expect(routed).toEqual(toolResult);
    expect(mocked.availableConnectors).toHaveBeenLastCalledWith(installationId, userId, [], session);
  });
});
