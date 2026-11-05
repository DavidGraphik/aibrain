import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatedPngFixture } from "../../../../tests/helpers/png-fixture";

vi.mock("server-only", () => ({}));

const mocked = vi.hoisted(() => {
  class WorkerTurnRecoveryPendingError extends Error {}
  return {
    releaseMaintenance: vi.fn(),
    runWorkerCodexTurn: vi.fn(),
    persistProjection: vi.fn(async (): Promise<void> => undefined),
    projectionRead: vi.fn(),
    WorkerTurnRecoveryPendingError,
  };
});

vi.mock("@/auth/request-security", () => ({
  isSameOriginMutation: vi.fn(async () => true),
}));

vi.mock("@/auth/session", () => ({
  getSession: vi.fn(async () => ({
    tenant: { id: "qa-company" },
    user: { id: "00000000-0000-4000-8000-000000000001" },
  })),
}));

vi.mock("@/runtime/config", () => ({
  readRuntimeConfig: vi.fn(() => ({
    tenantId: "qa-company",
    mode: "codex",
    codexBinary: "codex",
    codexHome: null,
    workspace: "/unused",
    model: null,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  })),
}));

vi.mock("@/config/installation", () => ({
  loadInstallationConfig: vi.fn(async () => ({
    installationId: "qa-company",
    branding: { productName: "AiBrain" },
    paths: { usersRoot: "/tmp/aibrain-route-test/users" },
  })),
}));

vi.mock("@/runtime/worker-codex-turn", () => ({
  runWorkerCodexTurn: mocked.runWorkerCodexTurn,
  WorkerTurnRecoveryPendingError: mocked.WorkerTurnRecoveryPendingError,
}));

vi.mock("@/runtime/permission-turn", () => ({
  resolveServerTurnPermissions: vi.fn(async () => ({ fingerprint: "a".repeat(64) })),
}));

vi.mock("@/runtime/approval-store", () => ({
  FileApprovalStore: class FileApprovalStore {},
}));

vi.mock("@/runtime/thread-token", () => ({
  CURRENT_THREAD_TOOLSET_REVISION: "aibrain-tools-test",
  currentThreadToolsetRevision: () => "aibrain-tools-test",
  readThreadTokenContext: vi.fn(() => null),
}));

vi.mock("@/workbench/store", () => ({
  beginThreadTurn: vi.fn(),
  finishThreadTurn: vi.fn(),
  getThreadRuntimeContext: vi.fn(),
  isBrowserPreviewWorkbench: vi.fn(() => true),
  prepareThreadTurn: vi.fn(),
}));

vi.mock("@/workbench/http", () => ({
  workbenchErrorResponse: vi.fn(() => new Response(null, { status: 500 })),
}));

vi.mock("@/workbench/turn-projection-store", () => ({
  FileTurnProjectionStore: class FileTurnProjectionStore {
    private message: unknown;
    async initialize(_thread: string, message: unknown) { this.message = message; return { message }; }
    async applyTransportEvents() { await mocked.persistProjection(); return { message: this.message }; }
    async read() { return mocked.projectionRead(); }
  },
}));

vi.mock("@/runtime/worker-runtime-service", () => ({
  acquireWorkerTurnActivity: vi.fn(async () => ({ release: mocked.releaseMaintenance })),
  workerTurnIsActive: vi.fn(() => false),
}));

vi.mock("@/memory", () => ({
  LocalFileMemoryService: class LocalFileMemoryService {},
}));

vi.mock("@/runtime/memory-turn", () => ({
  FileMemoryTurnAuditSink: class FileMemoryTurnAuditSink {},
}));

vi.mock("@/documents/server-service", () => ({
  documentServicesForUser: vi.fn(),
}));

vi.mock("@/documents/turn-attachments", () => ({
  resolveTurnDocumentAttachments: vi.fn(),
  ServerTurnDocumentInputResolver: class ServerTurnDocumentInputResolver {},
  TurnDocumentAttachmentError: class TurnDocumentAttachmentError extends Error {},
  turnDocumentChatAttachments: vi.fn(() => []),
}));

vi.mock("@/operations/server-logger", () => ({
  operationalLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/operations/maintenance", () => ({
  MaintenanceModeError: class MaintenanceModeError extends Error {},
}));

vi.mock("@/usage/server-service", () => ({
  recordTurnUsage: vi.fn(async () => undefined),
}));

vi.mock("@/settings/server-service", () => ({
  featurePolicyForUser: vi.fn(async () => ({
    "web-search": true,
    "image-generation": true,
    skills: true,
  })),
}));

import { POST } from "@/app/api/chat/route";
import { consumeChatEventStream } from "@/ui/app-server-ui-adapter";
import * as chatStreamWire from "@/lib/chat-stream-wire";
import { readThreadTokenContext } from "@/runtime/thread-token";
import { workerTurnIsActive } from "@/runtime/worker-runtime-service";
import { largeChatFixture } from "../../../../tests/helpers/large-chat-fixture";
import type { ChatStreamEvent } from "@/lib/chat-contract";
import { documentServicesForUser } from "@/documents/server-service";
import { resolveTurnDocumentAttachments } from "@/documents/turn-attachments";
import { runtimeThreadIdForChatMessage } from "@/runtime/chat-thread-selection";
import { finishThreadTurn, isBrowserPreviewWorkbench, prepareThreadTurn } from "@/workbench/store";
import { resolveServerTurnPermissions } from "@/runtime/permission-turn";
import { PermissionResolutionError } from "@/permissions/errors";
import { continuingDocumentUploads } from "@/lib/continuing-document-uploads";
import { getSession } from "@/auth/session";
import { bindLocalServerSession } from "@/auth/server-session-binding";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function chatRequest(signal: AbortSignal, optionOverrides: Record<string, unknown> = {}, message = "Continue after reconnect") {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "00000000-0000-4000-8000-000000000011",
      threadId: "00000000-0000-4000-8000-000000000012",
      userMessageId: "00000000-0000-4000-8000-000000000013",
      assistantMessageId: "00000000-0000-4000-8000-000000000014",
      message,
      preferences: { tone: "direct", language: "en", showActivity: true },
      options: {
        mode: "agent",
        experience: "smart",
        model: null,
        effort: null,
        webSearch: false,
        imageGeneration: false,
        skill: null,
        attachments: [],
        ...optionOverrides,
      },
    }),
  });
}

describe("chat turn transport lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerTurnIsActive).mockReturnValue(false);
    vi.mocked(readThreadTokenContext).mockReturnValue(null);
  });

  function preparePreflightTurn() {
    const begin = vi.fn();
    vi.mocked(isBrowserPreviewWorkbench).mockReturnValueOnce(false);
    vi.mocked(prepareThreadTurn).mockResolvedValueOnce({
      context: { projectId: "00000000-0000-4000-8000-000000000011", projectName: "Synthetic",
        workspaceKey: "workspace", projectInstructions: "", projectMemory: "", projectSources: [],
        visibleProjects: [], runtimeThreadToken: null, branchHistory: null },
      rebootstrapHistory: "", begin,
    } as never);
    return begin;
  }

  it("returns an explicit permission denial without admitting or retrying a model turn", async () => {
    const begin = preparePreflightTurn();
    vi.mocked(resolveServerTurnPermissions).mockRejectedValueOnce(new PermissionResolutionError(
      "PERMISSION_POLICY_DENIED", "Private role/group policy and filesystem details must not leak",
    ));
    const response = await POST(chatRequest(new AbortController().signal));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "PERMISSION_POLICY_DENIED",
      error: "La política de tu empresa no permite responder en esta conversación. Contacta con el administrador.",
    });
    expect(response.headers.has("Retry-After")).toBe(false);
    expect(begin).not.toHaveBeenCalled();
    expect(mocked.runWorkerCodexTurn).not.toHaveBeenCalled();
    expect(finishThreadTurn).not.toHaveBeenCalled();
    expect(mocked.releaseMaintenance).toHaveBeenCalledOnce();
  });

  it.each(["PERMISSION_ROOT_UNAVAILABLE", "PERMISSION_AUDIT_FAILED"] as const)("keeps temporary %s preflight failures retryable without admitting a turn", async code => {
    const begin = preparePreflightTurn();
    vi.mocked(resolveServerTurnPermissions).mockRejectedValueOnce(new PermissionResolutionError(code, "Private detail must not leak"));
    const response = await POST(chatRequest(new AbortController().signal));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "No s’ha pogut verificar la política d’aquest torn." });
    expect(begin).not.toHaveBeenCalled();
    expect(mocked.runWorkerCodexTurn).not.toHaveBeenCalled();
    expect(mocked.releaseMaintenance).toHaveBeenCalledOnce();
  });

  it("does not treat an untyped permission-code lookalike as an authenticated policy denial", async () => {
    const begin = preparePreflightTurn();
    vi.mocked(resolveServerTurnPermissions).mockRejectedValueOnce(Object.assign(new Error("Unknown setup failure"), { code: "PERMISSION_POLICY_DENIED" }));
    const response = await POST(chatRequest(new AbortController().signal));
    expect(response.status).toBe(503);
    expect(begin).not.toHaveBeenCalled();
    expect(mocked.runWorkerCodexTurn).not.toHaveBeenCalled();
  });

  it("keeps document conversion backpressure retryable with its existing Retry-After", async () => {
    const begin = preparePreflightTurn();
    vi.mocked(documentServicesForUser).mockRejectedValueOnce(Object.assign(new Error("Synthetic conversion busy"), {
      code: "DOCUMENT_CONVERSION_BACKPRESSURE", retryAfterMs: 2_500,
    }));
    const response = await POST(chatRequest(new AbortController().signal, {
      documentUploadIds: ["00000000-0000-4000-8000-000000000022"],
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3");
    expect(await response.json()).toEqual({ error: "La conversió de documents està ocupada. Torna-ho a provar." });
    expect(begin).not.toHaveBeenCalled();
    expect(mocked.runWorkerCodexTurn).not.toHaveBeenCalled();
    expect(mocked.releaseMaintenance).toHaveBeenCalledOnce();
  });

  it("starts a fresh restricted runtime for a server-bound support preview, preserving ordinary chat history", async () => {
    const threadId="00000000-0000-4000-8000-000000000012",appId="00000000-0000-4000-8000-000000000021";
    const qa=bindLocalServerSession({provider:"local",tenant:{id:"g03-qa",name:"QA"},user:{id:"00000000-0000-4000-8000-000000000001",name:"Synthetic",email:"qa@example.test"},expiresAt:"2099-01-01",
      support:{actorEmail:"actor@example.test",expiresAt:"2099-01-01",preview:{threadId,appId}}},"a".repeat(64));
    vi.mocked(getSession).mockResolvedValueOnce(qa);
    vi.mocked(isBrowserPreviewWorkbench).mockReturnValueOnce(false);
    vi.mocked(readThreadTokenContext).mockReturnValueOnce({threadId:"old-unrestricted-runtime",toolsetRevision:"aibrain-tools-test"});
    vi.mocked(prepareThreadTurn).mockResolvedValueOnce({context:{projectId:"00000000-0000-4000-8000-000000000011",projectName:"QA",workspaceKey:"workspace",projectInstructions:"",projectMemory:"",projectSources:[],visibleProjects:[],runtimeThreadToken:"signed-old-token",branchHistory:null},
      rebootstrapHistory:"USER: Earlier synthetic preview.",begin:async(_user:unknown,assistantMessage:unknown)=>({outcome:"created",assistantMessage})} as never);
    mocked.runWorkerCodexTurn.mockImplementation(async()=>undefined);
    const response=await POST(chatRequest(new AbortController().signal));
    expect(response.status).toBe(200);await response.text();
    const args=mocked.runWorkerCodexTurn.mock.calls[0];
    expect(args[3]).toBeNull();
    expect(args[21]).toMatchObject({businessReads:false,webSearch:false,supportPreview:{installationId:"g03-qa",userId:qa.user.id,publicThreadId:threadId,previewAppId:appId,sessionHash:"a".repeat(64)}});
    expect(args[13]).toMatchObject({branchHistory:"USER: Earlier synthetic preview."});
  });

  it("rejects a preview session used for another thread or with real attachments",async()=>{
    const threadId="00000000-0000-4000-8000-000000000012",appId="00000000-0000-4000-8000-000000000021";
    const make=(boundThread:string)=>bindLocalServerSession({provider:"local",tenant:{id:"g03-qa",name:"QA"},user:{id:"00000000-0000-4000-8000-000000000001",name:"Synthetic",email:"qa@example.test"},expiresAt:"2099-01-01",
      support:{actorEmail:"actor@example.test",expiresAt:"2099-01-01",preview:{threadId:boundThread,appId}}},"a".repeat(64));
    vi.mocked(getSession).mockResolvedValueOnce(make(appId));
    expect((await POST(chatRequest(new AbortController().signal))).status).toBe(403);
    vi.mocked(getSession).mockResolvedValueOnce(make(threadId));
    expect((await POST(chatRequest(new AbortController().signal,{documentUploadIds:[appId]}))).status).toBe(400);
    expect(mocked.runWorkerCodexTurn).not.toHaveBeenCalled();
  });

  it("streams a 64-event burst while the durable projection write is stalled", async () => {
    const persistence = deferred();
    const completion = deferred();
    vi.mocked(isBrowserPreviewWorkbench).mockReturnValueOnce(false);
    vi.mocked(prepareThreadTurn).mockResolvedValueOnce({
      context: { projectId: "00000000-0000-4000-8000-000000000011", projectName: "Test",
        workspaceKey: "workspace", projectInstructions: "", projectMemory: "", projectSources: [],
        visibleProjects: [], runtimeThreadToken: null, branchHistory: null },
      rebootstrapHistory: "USER: Saved authenticated conversation.",
      begin: async (_user: unknown, assistantMessage: unknown) => ({ outcome: "created", assistantMessage }),
    } as never);
    mocked.persistProjection.mockImplementationOnce(() => persistence.promise);
    mocked.runWorkerCodexTurn.mockImplementation(async (...args: unknown[]) => {
      const emit = args[10] as (event: unknown, projection: unknown) => Promise<void>;
      for (let index = 1; index <= 64; index += 1) await emit({ type: "delta", value: `${index} ` }, {
        envelope: { eventId: `burst-${index}`, sequence: index, occurredAt: new Date().toISOString(),
          message: { kind: "rpc-notification", rpc: {} } }, key: `delta:${index}`,
      });
      await completion.promise;
      await emit({ type: "done" }, { envelope: { eventId: "burst-65", sequence: 65,
        occurredAt: new Date().toISOString(), message: { kind: "rpc-notification", rpc: {} } }, key: "done" });
    });
    const response = await POST(chatRequest(new AbortController().signal));
    const reader = response.body!.getReader();
    try {
      const received: string[] = [];
      for (let index = 1; index <= 64; index += 1) {
        const chunk = await reader.read();
        received.push(JSON.parse(new TextDecoder().decode(chunk.value)).value);
      }
      expect(received).toEqual(Array.from({ length: 64 }, (_, index) => `${index + 1} `));
      expect(mocked.persistProjection).toHaveBeenCalledOnce();
      // Foreground product tools require the authenticated runtime identity,
      // independently of the permission to create automation definitions.
      const runtimeArgs = mocked.runWorkerCodexTurn.mock.calls[0];
      expect(runtimeArgs[17]).toEqual({ tenant: { id: "qa-company" }, user: { id: "00000000-0000-4000-8000-000000000001" } });
      expect(runtimeArgs[17]).toBe(runtimeArgs[16]);
      expect(runtimeArgs[22]).toBe("USER: Saved authenticated conversation.");
    } finally {
      persistence.resolve();
      completion.resolve();
      await reader.cancel();
    }
    await vi.waitFor(() => expect(mocked.releaseMaintenance).toHaveBeenCalledOnce());
    // Foreground tools need the authenticated identity as well as the existing
    // automation-management capability. Neither argument is a background grant.
    const turnArguments = mocked.runWorkerCodexTurn.mock.calls[0];
    expect(turnArguments[16]).toMatchObject({ tenant: { id: "qa-company" } });
    expect(turnArguments[17]).toBe(turnArguments[16]);
    expect(turnArguments[18]).toBe(false);
  });

  it("re-bootstraps stale toolsets while preserving current runtime threads", () => {
    const legacy = { threadId: "runtime-thread-legacy", toolsetRevision: null };
    const current = { threadId: "runtime-thread-current", toolsetRevision: "aibrain-tools-test" };
    expect(runtimeThreadIdForChatMessage(legacy, "Envíame hello dentro de 2 minutos")).toBeNull();
    expect(runtimeThreadIdForChatMessage(legacy, "Resume la conversación")).toBeNull();
    expect(runtimeThreadIdForChatMessage(legacy, "Segueix amb el preview")).toBeNull();
    expect(runtimeThreadIdForChatMessage(current, "Revisa el PowerPoint")).toBe("runtime-thread-current");
    expect(runtimeThreadIdForChatMessage(current, "Cada lunes prepara un resumen")).toBe("runtime-thread-current");
  });

  it.each([true, false])("preserves visible chat and authenticated history when toolset refresh is %s", async (stale) => {
    vi.mocked(isBrowserPreviewWorkbench).mockReturnValueOnce(false);
    vi.mocked(readThreadTokenContext).mockReturnValueOnce({
      threadId: "existing-jordi-runtime", toolsetRevision: stale ? "older-tools" : "aibrain-tools-test",
    });
    vi.mocked(prepareThreadTurn).mockResolvedValueOnce({
      context: { projectId: "00000000-0000-4000-8000-000000000011", projectName: "Production",
        workspaceKey: "workspace", projectInstructions: "Current scoped guidance", projectMemory: "", projectSources: [],
        visibleProjects: [], runtimeThreadToken: "signed-existing-token", branchHistory: null },
      rebootstrapHistory: "USER: Previous catalog request.\nASSISTANT: Saved result.",
      begin: async (_user: unknown, assistantMessage: unknown) => ({ outcome: "created", assistantMessage }),
    } as never);
    mocked.runWorkerCodexTurn.mockImplementation(async () => undefined);
    const response = await POST(chatRequest(new AbortController().signal));
    expect(response.status).toBe(200);
    await response.text();
    const args = mocked.runWorkerCodexTurn.mock.calls[0];
    expect(args[0]).toMatchObject({ threadId: "00000000-0000-4000-8000-000000000012", projectId: "00000000-0000-4000-8000-000000000011" });
    expect(args[3]).toBe(stale ? null : "existing-jordi-runtime");
    expect(args[13]).toMatchObject({ projectInstructions: "Current scoped guidance", branchHistory: stale ? "USER: Previous catalog request.\nASSISTANT: Saved result." : null });
    expect(args[17]).toMatchObject({ user: { id: "00000000-0000-4000-8000-000000000001" } });
    expect(args[5]).toMatchObject({ fingerprint: "a".repeat(64) });
  });

  it("passes the original PDF and prior history into a new runtime after a toolset upgrade", async () => {
    const threadId="00000000-0000-4000-8000-000000000012",uploadId="00000000-0000-4000-8000-000000000022";
    const attachment={id:uploadId,name:"original.pdf",mimeType:"application/pdf",size:42};
    const documentUploadIds=continuingDocumentUploads([{role:"user",attachments:[attachment]},{role:"assistant",attachments:[]},{role:"user",attachments:[]}]);
    expect(documentUploadIds).toEqual([uploadId]);
    vi.mocked(isBrowserPreviewWorkbench).mockReturnValueOnce(false);
    vi.mocked(readThreadTokenContext).mockReturnValueOnce({threadId:"old-runtime",toolsetRevision:"old-document-catalog"});
    vi.mocked(prepareThreadTurn).mockResolvedValueOnce({context:{projectId:"00000000-0000-4000-8000-000000000011",projectName:"Production",workspaceKey:"workspace",projectInstructions:"",projectMemory:"",projectSources:[],visibleProjects:[],runtimeThreadToken:"signed-existing-token",branchHistory:null},
      rebootstrapHistory:"USER: Original PDF attached.\nASSISTANT: Translation partially saved.",begin:async(_user:unknown,assistantMessage:unknown)=>({outcome:"created",assistantMessage})} as never);
    vi.mocked(documentServicesForUser).mockResolvedValueOnce({staging:{},manifest:{roots:{staging:"/private/staging"}},previews:{},toolchain:{},conversionGate:{}} as never);
    const original=[{document:{threadId,uploadId,kind:"pdf",fileName:"original.pdf"}}];
    vi.mocked(resolveTurnDocumentAttachments).mockResolvedValueOnce(original as never);
    mocked.runWorkerCodexTurn.mockImplementation(async()=>undefined);
    const response=await POST(chatRequest(new AbortController().signal,{documentUploadIds},"Continua la traducció"));
    expect(response.status).toBe(200);await response.text();
    expect(resolveTurnDocumentAttachments).toHaveBeenCalledWith(expect.objectContaining({threadId,uploadIds:[uploadId],permissions:expect.objectContaining({fingerprint:"a".repeat(64)})}));
    const args=mocked.runWorkerCodexTurn.mock.calls[0];
    expect(args[0]).toMatchObject({threadId});expect(args[3]).toBeNull();expect(args[8]).toBe(original);
    expect(args[13]).toMatchObject({branchHistory:"USER: Original PDF attached.\nASSISTANT: Translation partially saved."});
  });

  it("rejects a message with neither text nor attachments", async () => {
    const response = await POST(chatRequest(new AbortController().signal, {}, "   "));
    expect(response.status).toBe(400);
    expect(mocked.runWorkerCodexTurn).not.toHaveBeenCalled();
  });

  it("accepts an image-only turn without inventing visible user text", async () => {
    mocked.runWorkerCodexTurn.mockImplementation(async () => undefined);
    const png = generatedPngFixture();
    const response = await POST(chatRequest(new AbortController().signal, {
      attachments: [{ id: "00000000-0000-4000-8000-000000000021", name: "receipt.png", mimeType: "image/png", size: png.length,
        dataUrl: `data:image/png;base64,${png.toString("base64")}` }],
    }, ""));
    expect(response.status).toBe(200);
    await response.text();
    expect(mocked.runWorkerCodexTurn).toHaveBeenCalled();
    expect(mocked.runWorkerCodexTurn.mock.calls[0][0]).toMatchObject({ message: "" });
  });

  it("resolves an attachment-only document through the authorized staging service", async () => {
    vi.mocked(documentServicesForUser).mockResolvedValueOnce({ staging: {},
      manifest: { roots: { staging: "/private/staging" } }, previews: {}, toolchain: {}, conversionGate: {} } as never);
    vi.mocked(resolveTurnDocumentAttachments).mockResolvedValueOnce([]);
    mocked.runWorkerCodexTurn.mockImplementation(async () => undefined);
    const uploadId = "00000000-0000-4000-8000-000000000022";
    const response = await POST(chatRequest(new AbortController().signal, { documentUploadIds: [uploadId] }, ""));
    expect(response.status).toBe(200);
    await response.text();
    expect(resolveTurnDocumentAttachments).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "00000000-0000-4000-8000-000000000012", uploadIds: [uploadId],
      permissions: expect.objectContaining({ fingerprint: "a".repeat(64) }),
    }));
    expect(mocked.runWorkerCodexTurn.mock.calls[0][0]).toMatchObject({ message: "" });
  });

  it("rejects browser-supplied provider settings", async () => {
    const response = await POST(chatRequest(new AbortController().signal, {
      model: "gpt-5.6-sol",
      effort: "high",
    }));
    expect(response.status).toBe(400);
    expect(mocked.runWorkerCodexTurn).not.toHaveBeenCalled();
  });

  it("keeps the server-owned turn alive when the NDJSON client disconnects", async () => {
    const turnGate = deferred();
    let captureWorkerSignal!: (signal: AbortSignal) => void;
    const workerSignal = new Promise<AbortSignal>((resolve) => {
      captureWorkerSignal = resolve;
    });
    mocked.runWorkerCodexTurn.mockImplementation(async (...args: unknown[]) => {
      captureWorkerSignal(args[9] as AbortSignal);
      const emit = args[10] as (event: Record<string, unknown>) => Promise<void>;
      await turnGate.promise;
      await emit({ type: "runtimeTurn", turnId: "runtime-turn-1" });
      await emit({ type: "delta", value: "still running" });
      await emit({ type: "done" });
    });

    const client = new AbortController();
    const response = await POST(chatRequest(client.signal));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const signal = await workerSignal;

    client.abort();
    expect(signal.aborted).toBe(false);
    turnGate.resolve();

    await vi.waitFor(() => expect(mocked.releaseMaintenance).toHaveBeenCalledOnce());
    expect(signal.aborted).toBe(false);
  });

  it("keeps a quiet long-running response alive with a durable snapshot", async () => {
    vi.useFakeTimers();
    try {
      const turnGate = deferred();
      mocked.runWorkerCodexTurn.mockImplementation(async () => {
        await turnGate.promise;
      });

      const response = await POST(chatRequest(new AbortController().signal));
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const nextChunk = reader!.read();

      await vi.advanceTimersByTimeAsync(15_000);
      const chunk = await nextChunk;
      expect(chunk.done).toBe(false);
      const event = JSON.parse(new TextDecoder().decode(chunk.value));
      expect(event).toMatchObject({
        type: "snapshot",
        message: { status: "streaming" },
      });

      await reader!.cancel();
      turnGate.resolve();
      await vi.waitFor(() => expect(mocked.releaseMaintenance).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });


  it("streams large original live events and their keepalive snapshot through bounded fragments", async () => {
    vi.useFakeTimers();
    const turnGate = deferred();
    try {
      const fixture = largeChatFixture();
      mocked.runWorkerCodexTurn.mockImplementation(async (...args: unknown[]) => {
        const emit = args[10] as (event: ChatStreamEvent) => Promise<void>;
        await emit({type:"activity",item:fixture.activity[0]});
        for(const item of fixture.toolResults!) await emit({type:"toolResult",item});
        await emit({type:"artifact",item:fixture.artifacts[0]});
        await turnGate.promise;
        await emit({type:"done"});
      });
      const response = await POST(chatRequest(new AbortController().signal));
      const observed: ChatStreamEvent[]=[];
      const reading=consumeChatEventStream(response,event=>observed.push(event),{stopOnTerminal:true});
      await vi.advanceTimersByTimeAsync(0);
      expect(observed.filter(event=>event.type==="toolResult")).toHaveLength(80);
      await vi.advanceTimersByTimeAsync(15_000);
      const snapshot=observed.find(event=>event.type==="snapshot");
      expect(snapshot).toMatchObject({type:"snapshot",message:{activity:fixture.activity,toolResults:fixture.toolResults,artifacts:fixture.artifacts,status:"streaming"}});
      expect(JSON.stringify(snapshot).length).toBeGreaterThan(7_400_000);
      turnGate.resolve();
      await reading;
      expect(observed.at(-1)).toMatchObject({type:"done"});
    } finally {turnGate.resolve();vi.useRealTimers();}
  });

  it.each(["snapshot", "activity"] as const)("isolates a bounded-encoder %s rejection to this response and clears keepalive", async rejectedType => {
    vi.useFakeTimers();
    const turnGate=deferred();
    const originalEncoder=chatStreamWire.encodeChatStreamEvent;
    const encoding=vi.spyOn(chatStreamWire,"encodeChatStreamEvent").mockImplementation(function*(event){
      if(event.type===rejectedType)throw new Error("Chat event exceeds its bounded assembly limit.");
      yield* originalEncoder(event);
    });
    let workerSignal:AbortSignal|null=null;
    let workerFinished=false;
    try{
      mocked.runWorkerCodexTurn.mockImplementation(async(...args:unknown[])=>{
        workerSignal=args[9] as AbortSignal;
        const emit=args[10] as (event:ChatStreamEvent)=>Promise<void>;
        if(rejectedType==="activity")await emit({type:"activity",item:{id:"over-limit",kind:"command",label:"Prepare images",status:"complete"}});
        await turnGate.promise;
        await emit({type:"delta",value:"Backend still runs"});
        await emit({type:"done"});
        workerFinished=true;
      });
      const response=await POST(chatRequest(new AbortController().signal));
      const reading=expect(response.text()).rejects.toThrow("bounded assembly limit");
      if(rejectedType==="snapshot")await vi.advanceTimersByTimeAsync(15_000);
      await reading;
      expect(workerSignal).not.toBeNull();
      expect((workerSignal as unknown as AbortSignal).aborted).toBe(false);
      const callsAfterRejection=encoding.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(encoding).toHaveBeenCalledTimes(callsAfterRejection);
      expect(workerFinished).toBe(false);
      turnGate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(workerFinished).toBe(true);
      expect(mocked.releaseMaintenance).toHaveBeenCalledOnce();
      expect((workerSignal as unknown as AbortSignal).aborted).toBe(false);
    }finally{turnGate.resolve();encoding.mockRestore();vi.useRealTimers();}
  });

  it.each(["terminal replay", "active reconnect"])("reattaches a large saved snapshot on %s without another model submission", async path => {
    const fixture=largeChatFixture(path==="terminal replay"?"complete":"streaming");
    vi.mocked(isBrowserPreviewWorkbench).mockReturnValueOnce(false);
    vi.mocked(prepareThreadTurn).mockResolvedValueOnce({
      context:{projectId:"00000000-0000-4000-8000-000000000011",projectName:"Test",workspaceKey:"workspace",projectInstructions:"",projectMemory:"",projectSources:[],visibleProjects:[],runtimeThreadToken:path==="active reconnect"?"test-token":null,branchHistory:null},
      begin:async()=>({outcome:"existing",assistantMessage:fixture}),
    } as never);
    if(path==="active reconnect"){
      vi.mocked(readThreadTokenContext).mockReturnValueOnce({threadId:"runtime-thread-current",toolsetRevision:"aibrain-tools-test"} as never);
      vi.mocked(workerTurnIsActive).mockReturnValue(true);
      mocked.projectionRead.mockResolvedValueOnce({updatedAt:"2026-10-20T12:00:01.000Z",message:{...fixture,status:"complete"}});
    }
    const response=await POST(chatRequest(new AbortController().signal));
    const observed:ChatStreamEvent[]=[];
    await consumeChatEventStream(response,event=>observed.push(event),{stopOnTerminal:true});
    expect(observed[0]).toEqual({type:"snapshot",message:fixture});
    expect(observed.at(-1)).toMatchObject({type:"snapshot",message:{status:"complete",toolResults:fixture.toolResults,activity:fixture.activity}});
    expect(mocked.runWorkerCodexTurn).not.toHaveBeenCalled();
  });

  it("does not invent a terminal error when the remote turn needs reconciliation", async () => {
    mocked.runWorkerCodexTurn.mockRejectedValueOnce(
      new mocked.WorkerTurnRecoveryPendingError("event stream disconnected"),
    );

    const response = await POST(chatRequest(new AbortController().signal));
    const events = (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

    expect(events).not.toContainEqual(expect.objectContaining({ type: "error" }));
    expect(mocked.releaseMaintenance).toHaveBeenCalledOnce();
  });

  it("adds transport order and a measured duration before streaming terminal events", async () => {
    mocked.runWorkerCodexTurn.mockImplementation(async (...args: unknown[]) => {
      const emit = args[10] as (
        event: Record<string, unknown>,
        projection?: Record<string, unknown>,
      ) => Promise<void>;
      await emit({
        type: "activity",
        item: { id: "summary-ordered", kind: "reasoning", label: "Resumen público", status: "complete" },
      }, {
        envelope: {
          eventId: "event-42",
          sequence: 42,
          occurredAt: "2026-08-30T10:00:00.000Z",
          message: { kind: "rpc-notification", rpc: { method: "item/completed", params: {} } },
        },
        key: "activity:summary-ordered",
      });
      await emit({ type: "done" });
    });

    const response = await POST(chatRequest(new AbortController().signal));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      item: expect.objectContaining({ id: "summary-ordered", sequence: 42 }),
    }));
    const done = events.find((event) => event.type === "done");
    expect(done).toEqual(expect.objectContaining({
      type: "done",
      durationMs: expect.any(Number),
    }));
    expect(Number.isSafeInteger(done.durationMs)).toBe(true);
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    expect(done.durationMs).toBeLessThan(10_000);
  });
});

it.each([51, 99])("explains the maximum of 50 for %i attachments before starting any worker", async count => {
  mocked.runWorkerCodexTurn.mockClear();
  const response = await POST(chatRequest(new AbortController().signal, { documentUploadIds: Array(count).fill("00000000-0000-4000-8000-000000000099") }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "CHAT_ATTACHMENT_LIMIT_EXCEEDED", maximumFiles: 50 });
  expect(mocked.runWorkerCodexTurn).not.toHaveBeenCalled();
});
