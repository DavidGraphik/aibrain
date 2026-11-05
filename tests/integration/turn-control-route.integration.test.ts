import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { ChatMessage } from "@/lib/chat-contract";

const USER_A = "0198b9f0-6631-7000-8000-000000000401";
const USER_B = "0198b9f0-6631-7000-8000-000000000402";
const USER_MESSAGE = "0198b9f0-6631-7000-8000-000000000411";
const ASSISTANT_MESSAGE = "0198b9f0-6631-7000-8000-000000000412";
const STEER_REQUEST = "0198b9f0-6631-7000-8000-000000000413";
const STEER_MESSAGE = "0198b9f0-6631-7000-8000-000000000414";
const STOP_REQUEST = "0198b9f0-6631-7000-8000-000000000415";
const PENDING_ASSISTANT_MESSAGE = "0198b9f0-6631-7000-8000-000000000416";
const PENDING_USER_MESSAGE = "0198b9f0-6631-7000-8000-000000000417";
const PENDING_STOP_REQUEST = "0198b9f0-6631-7000-8000-000000000418";
const IMMEDIATE_ASSISTANT_MESSAGE = "0198b9f0-6631-7000-8000-000000000419";
const IMMEDIATE_USER_MESSAGE = "0198b9f0-6631-7000-8000-000000000420";
const IMMEDIATE_STOP_REQUEST = "0198b9f0-6631-7000-8000-000000000421";
const auth = vi.hoisted(() => ({ session: null as AuthSession | null }));
const controls = vi.hoisted(() => ({ calls: [] as Array<{ request: Record<string, unknown> }> }));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({
  getSession: vi.fn(async () => auth.session),
  getSigningSecret: () => "route-test-signing-secret-with-at-least-thirty-two-bytes",
  isVercelPreviewDemoEnabled: () => false,
}));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: vi.fn(async () => true) }));
vi.mock("@/runtime/turn-control", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/runtime/turn-control")>();
  return {
    ...original,
    controlWorkerTurn: vi.fn(async (
      _identity: unknown,
      request: Record<string, unknown>,
      persist: (event: unknown) => Promise<void>,
    ) => {
      controls.calls.push({ request });
      await persist({
        type: "activity",
        item: {
          id: `${request.action}:${request.clientRequestId}`,
          kind: "system",
          label: "Control acceptat",
          status: request.action === "stop" ? "stopped" : "complete",
        },
      });
      if (request.action === "stop") await persist({ type: "stopped" });
      return { action: request.action };
    }),
    cancelPendingWorkerTurn: vi.fn(async (
      _identity: unknown,
      request: Record<string, unknown>,
      persist: (event: unknown) => Promise<void>,
    ) => {
      controls.calls.push({ request });
      await persist({
        type: "activity",
        item: {
          id: `${request.action}:${request.clientRequestId}`,
          kind: "system",
          label: "Aturada sol·licitada",
          status: "complete",
        },
      });
      return { action: request.action, runtimeTurnId: null, activeRunnerCancelled: true };
    }),
  };
});

function session(userId: string): AuthSession {
  return {
    provider: "local",
    user: {
      id: userId,
      name: `User ${userId.slice(-3)}`,
      email: `${userId.slice(-3)}@example.test`,
    },
    tenant: { id: "control-lab", name: "Control Lab" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function message(id: string, role: ChatMessage["role"], status: ChatMessage["status"]): ChatMessage {
  return {
    id,
    role,
    content: role === "user" ? "Analitza el contracte" : "",
    createdAt: new Date().toISOString(),
    status,
    activity: [],
    plan: [],
    approvals: [],
    diff: "",
    attachments: [],
    artifacts: [],
  };
}

function request(body: unknown) {
  return new Request("http://localhost/api/runtime/turns/control", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("turn control route", () => {
  let root: string;
  let previousConfig: string | undefined;
  let threadId: string;
  let pendingThreadId: string;
  let immediateThreadId: string;

  beforeAll(async () => {
    previousConfig = process.env.AIBRAIN_INSTALLATION_CONFIG;
    root = await mkdtemp(path.join(tmpdir(), "aibrain-turn-control-route-"));
    const dataRoot = path.join(root, "data");
    const usersRoot = path.join(dataRoot, "users");
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const configPath = path.join(root, "installation.json");
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 1,
      installationId: "control-lab",
      companyName: "Control Lab",
      companySlug: "control-lab",
      publicUrl: "http://localhost:3000",
      branding: {
        productName: "Control Brain",
        logoPath: "/brand/logo.svg",
        faviconPath: "/brand/favicon.svg",
        accentColor: "#334455",
      },
      paths: {
        dataRoot,
        companyContextRoot: path.join(dataRoot, "company"),
        usersRoot,
        sourceReadRoot: path.join(root, "source-ro"),
        publishWriteRoot: path.join(root, "publish-rw"),
        backupsRoot: path.join(dataRoot, "backups"),
      },
    }, null, 2)}\n`, "utf8");
    process.env.AIBRAIN_INSTALLATION_CONFIG = configPath;
    const [{ loadInstallationConfig: loadProvisioningInstallationConfig }, { UserProvisioner }] = await Promise.all([
      import("@/config/installation"),
      import("@/users/provisioner"),
    ]);
    const provisioner = new UserProvisioner(await loadProvisioningInstallationConfig());
    await provisioner.provision({
      userId: USER_A,
      email: `${USER_A.slice(-3)}@example.test`,
      displayName: "User 401",
    });
    await provisioner.provision({
      userId: USER_B,
      email: `${USER_B.slice(-3)}@example.test`,
      displayName: "User 402",
    });

    const [{ loadInstallationConfig }, { FileWorkbenchStore }, { FileTurnProjectionStore }, { issueThreadToken }] =
      await Promise.all([
        import("@/config/installation"),
        import("@/workbench/filesystem-store"),
        import("@/workbench/turn-projection-store"),
        import("@/runtime/thread-token"),
      ]);
    const installation = await loadInstallationConfig();
    const workbench = FileWorkbenchStore.fromInstallation(installation);
    const project = await workbench.createProject(USER_A, "Contract Review");
    const thread = await workbench.createThread(USER_A, project.id, "Review turn");
    threadId = thread.id;
    const pendingThread = await workbench.createThread(USER_A, project.id, "Pending review turn");
    pendingThreadId = pendingThread.id;
    const immediateThread = await workbench.createThread(USER_A, project.id, "Immediate stop turn");
    immediateThreadId = immediateThread.id;
    const assistant = message(ASSISTANT_MESSAGE, "assistant", "streaming");
    await workbench.beginThreadTurn(
      USER_A,
      threadId,
      message(USER_MESSAGE, "user", "complete"),
      assistant,
    );
    const projections = new FileTurnProjectionStore({
      installationId: installation.installationId,
      userId: USER_A,
      usersRoot: installation.paths.usersRoot,
    });
    await projections.initialize(threadId, assistant);
    await projections.setRuntimeThreadToken(
      threadId,
      ASSISTANT_MESSAGE,
      issueThreadToken("control-lab", USER_A, "runtime-thread-control"),
    );
    await projections.setRuntimeTurnId(threadId, ASSISTANT_MESSAGE, "runtime-turn-control");
    const pendingAssistant = message(PENDING_ASSISTANT_MESSAGE, "assistant", "streaming");
    await workbench.beginThreadTurn(
      USER_A,
      pendingThreadId,
      message(PENDING_USER_MESSAGE, "user", "complete"),
      pendingAssistant,
    );
    await projections.initialize(pendingThreadId, pendingAssistant);
    await projections.setRuntimeThreadToken(
      pendingThreadId,
      PENDING_ASSISTANT_MESSAGE,
      issueThreadToken("control-lab", USER_A, "runtime-thread-pending-control"),
    );
    const immediateAssistant = message(IMMEDIATE_ASSISTANT_MESSAGE, "assistant", "streaming");
    await workbench.beginThreadTurn(
      USER_A,
      immediateThreadId,
      message(IMMEDIATE_USER_MESSAGE, "user", "complete"),
      immediateAssistant,
    );
    await projections.initialize(immediateThreadId, immediateAssistant);
  });

  afterAll(async () => {
    auth.session = null;
    if (previousConfig === undefined) delete process.env.AIBRAIN_INSTALLATION_CONFIG;
    else process.env.AIBRAIN_INSTALLATION_CONFIG = previousConfig;
    await rm(root, { recursive: true, force: true });
  });

  it("authenticates and persists steering exactly once without accepting runtime ids", async () => {
    const route = await import("@/app/api/runtime/turns/control/route");
    auth.session = null;
    expect((await route.POST(request({}))).status).toBe(401);

    auth.session = session(USER_A);
    expect((await route.POST(request({
      action: "steer",
      threadId,
      assistantMessageId: ASSISTANT_MESSAGE,
      clientRequestId: STEER_REQUEST,
      userMessageId: STEER_MESSAGE,
      message: "Inclou també els riscos operatius.",
      runtimeTurnId: "attacker-selected",
    }))).status).toBe(400);

    const body = {
      action: "steer",
      threadId,
      assistantMessageId: ASSISTANT_MESSAGE,
      clientRequestId: STEER_REQUEST,
      userMessageId: STEER_MESSAGE,
      message: "Inclou també els riscos operatius.",
    };
    const first = await route.POST(request(body));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, action: "steer", idempotent: false });
    const replay = await route.POST(request(body));
    expect(await replay.json()).toEqual({ ok: true, action: "steer", idempotent: true });
    expect(controls.calls.filter((call) => call.request.action === "steer")).toHaveLength(1);
  });

  it("confirms stop durably and denies another user access to the same ids", async () => {
    const route = await import("@/app/api/runtime/turns/control/route");
    auth.session = session(USER_B);
    expect((await route.POST(request({
      action: "stop",
      threadId,
      assistantMessageId: ASSISTANT_MESSAGE,
      clientRequestId: STOP_REQUEST,
    }))).status).toBe(404);

    auth.session = session(USER_A);
    const stopped = await route.POST(request({
      action: "stop",
      threadId,
      assistantMessageId: ASSISTANT_MESSAGE,
      clientRequestId: STOP_REQUEST,
    }));
    expect(await stopped.json()).toEqual({ ok: true, action: "stop", idempotent: false });
    const replay = await route.POST(request({
      action: "stop",
      threadId,
      assistantMessageId: ASSISTANT_MESSAGE,
      clientRequestId: STOP_REQUEST,
    }));
    expect(await replay.json()).toEqual({ ok: true, action: "stop", idempotent: true });
    expect(controls.calls.filter((call) => call.request.action === "stop")).toHaveLength(1);
  });

  it("stops a local App Server turn before its runtime turn id is available", async () => {
    const route = await import("@/app/api/runtime/turns/control/route");
    auth.session = session(USER_A);
    const stopped = await route.POST(request({
      action: "stop",
      threadId: pendingThreadId,
      assistantMessageId: PENDING_ASSISTANT_MESSAGE,
      clientRequestId: PENDING_STOP_REQUEST,
    }));

    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ ok: true, action: "stop", idempotent: false });
    expect(controls.calls.some((call) =>
      call.request.assistantMessageId === PENDING_ASSISTANT_MESSAGE && call.request.action === "stop"))
      .toBe(true);
    const { FileTurnProjectionStore } = await import("@/workbench/turn-projection-store");
    const projections = new FileTurnProjectionStore({
      installationId: "control-lab", userId: USER_A, usersRoot: path.join(root, "data", "users"),
    });
    expect((await projections.read(pendingThreadId, PENDING_ASSISTANT_MESSAGE))?.message.status).toBe("streaming");
  });

  it("reports an authorized missing projection without acknowledging a Stop, then accepts the same identity once initialized", async () => {
    const route = await import("@/app/api/runtime/turns/control/route");
    const assistantId = "0198b9f0-6631-7000-8000-000000000422";
    const body = { action: "stop", threadId: immediateThreadId, assistantMessageId: assistantId, clientRequestId: "0198b9f0-6631-7000-8000-000000000423" };
    auth.session = session(USER_B);
    const foreign = await route.POST(request(body));
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).not.toHaveProperty("code", "TURN_PROJECTION_NOT_FOUND");
    auth.session = session(USER_A);
    const missing = await route.POST(request(body));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "El torn no existeix.", code: "TURN_PROJECTION_NOT_FOUND" });
    expect(controls.calls.some(call => call.request.assistantMessageId === assistantId)).toBe(false);
    const { FileTurnProjectionStore } = await import("@/workbench/turn-projection-store");
    const projections = new FileTurnProjectionStore({ installationId: "control-lab", userId: USER_A, usersRoot: path.join(root, "data", "users") });
    await projections.initialize(immediateThreadId, message(assistantId, "assistant", "streaming"));
    const accepted = await route.POST(request(body));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, action: "stop", idempotent: false });
    expect(controls.calls.filter(call => call.request.assistantMessageId === assistantId)).toHaveLength(1);
    expect((await projections.read(immediateThreadId, assistantId))?.message.status).toBe("streaming");
  });

  it.each(["orphan","held-lease","creation-intent","model-intent","foreign-workspace"] as const)("only confirms an orphan Stop when durable non-dispatch is proven (%s)",async mode=>{
    const [{DurableTurnSubmission},{loadInstallationConfig},{FileWorkbenchStore},{FileTurnProjectionStore},route]=await Promise.all([
      import("@/runtime/turn-submission-store"),import("@/config/installation"),import("@/workbench/filesystem-store"),import("@/workbench/turn-projection-store"),import("@/app/api/runtime/turns/control/route")]);
    auth.session=session(USER_A);const installation=await loadInstallationConfig();const workbench=FileWorkbenchStore.fromInstallation(installation);
    const project=await workbench.createProject(USER_A,"Orphan Stop "+mode);const thread=await workbench.createThread(USER_A,project.id,"Preserve history");
    const previousUser=message(randomUUID(),"user","complete"),previousResult=message(randomUUID(),"assistant","complete");previousResult.content="Existing verified result";
    await workbench.beginThreadTurn(USER_A,thread.id,previousUser,previousResult);await workbench.finishThreadTurn(USER_A,thread.id,previousResult,null);
    const user=message(randomUUID(),"user","complete"),assistant=message(randomUUID(),"assistant","streaming");await workbench.beginThreadTurn(USER_A,thread.id,user,assistant);
    const projections=new FileTurnProjectionStore({installationId:installation.installationId,userId:USER_A,usersRoot:installation.paths.usersRoot});await projections.initialize(thread.id,assistant);
    const body={action:"stop",threadId:thread.id,assistantMessageId:assistant.id,clientRequestId:randomUUID()};
    // Existing accepted Stop activity must not short-circuit orphan completion.
    await projections.applyLocalEvent(thread.id,assistant.id,{type:"activity",item:{id:`stop:${body.clientRequestId}`,kind:"system",label:"Aturada sol·licitada",status:"complete"}});
    const userRoot=path.join(installation.paths.usersRoot,USER_A),authorizedWorkspace=path.join(userRoot,"workspace","projects",project.id),workspace=mode==="foreign-workspace"?path.join(userRoot,"workspace","projects",randomUUID()):authorizedWorkspace;await mkdir(authorizedWorkspace,{recursive:true,mode:0o700});await mkdir(workspace,{recursive:true,mode:0o700});
    const options={userRoot,workspace,installationId:installation.installationId,userId:USER_A,projectId:project.id,threadId:thread.id,assistantMessageId:assistant.id,binding:"a".repeat(64)};
    const receipt=await DurableTurnSubmission.open(options);
    if(mode==="creation-intent")await receipt.startThreadOnce({cwd:workspace},`thread-start:${assistant.id}`);
    if(mode==="model-intent") {await receipt.prepareInputs(async()=>({directory:null,codexInputs:[]}));await receipt.bindThread("native-thread");await receipt.dispatchOnce({threadId:"native-thread",clientUserMessageId:user.id,input:[]},`turn-start:${assistant.id}`);}
    if(mode!=="held-lease")await receipt.close();
    try {
      const response=await route.POST(request(body));expect(response.status).toBe(200);
      const stored=await workbench.getThread(USER_A,thread.id);expect(stored.messages.slice(0,2)).toEqual([previousUser,previousResult]);expect(stored.messages[2]).toEqual(user);
      expect((await projections.read(thread.id,assistant.id))?.message.status).toBe(mode==="orphan"?"stopped":"streaming");
      expect(stored.messages[3].status).toBe(mode==="orphan"?"stopped":"streaming");
      if(mode==="orphan") {
        const reopened=await DurableTurnSubmission.open({...options,recoveryOnly:true});expect(reopened.cancelledBeforeDispatch).toBe(true);
        await expect(reopened.startThreadOnce({},"another-creation")).rejects.toBeDefined();await expect(reopened.dispatchOnce({},"another-model")).rejects.toBeDefined();await reopened.close();
        expect((await route.POST(request(body))).status).toBe(200);
      }
    } finally {await receipt.close();}
  });

  it("accepts an immediate stop before App Server has returned a thread id", async () => {
    const route = await import("@/app/api/runtime/turns/control/route");
    auth.session = session(USER_A);
    const stopped = await route.POST(request({
      action: "stop",
      threadId: immediateThreadId,
      assistantMessageId: IMMEDIATE_ASSISTANT_MESSAGE,
      clientRequestId: IMMEDIATE_STOP_REQUEST,
    }));

    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ ok: true, action: "stop", idempotent: false });
  });
});
