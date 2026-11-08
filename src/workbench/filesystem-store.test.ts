import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { automationRunIdentities } from "@/automations/run-identities";
import type { ChatMessage } from "@/lib/chat-contract";
import { atomicTemporaryPath, ResourceLockManager, StorageCorruptionError } from "@/storage";
import {
  WorkbenchConflictError,
  WorkbenchNotFoundError,
  WorkbenchPersistenceError,
  WorkbenchValidationError,
} from "@/workbench/errors";
import { FileApprovalStore } from "@/runtime/approval-store";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import {
  parseWorkbenchListQuery,
  STANDALONE_PROJECT_SLUG,
  type WorkbenchListQuery,
} from "@/workbench/types";

const INSTALLATION_ID = "synthetic-lab";
const USER_A = "0198b9f0-6631-7000-8000-000000000101";
const USER_B = "0198b9f0-6631-7000-8000-000000000102";
const roots: string[] = [];
const ACTIVE_QUERY: WorkbenchListQuery = { status: "active", limit: 20 };

vi.mock("server-only", () => ({}));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-workbench-"));
  roots.push(root);
  const usersRoot = path.join(root, "users");
  await mkdir(path.join(usersRoot, USER_A), { recursive: true, mode: 0o700 });
  await mkdir(path.join(usersRoot, USER_B), { recursive: true, mode: 0o700 });
  return {
    root,
    usersRoot,
    store: new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot }),
  };
}

function message(role: ChatMessage["role"], status: ChatMessage["status"]): ChatMessage {
  return {
    id: randomUUID(),
    role,
    content: role === "user" ? "Synthetic request" : "",
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileWorkbenchStore", () => {
  it("round-trips previously persisted tool output beyond the presentation limit without changing history", async () => {
    const { store, usersRoot } = await fixture();
    const project = await store.createProject(USER_A, "Preserved tool history");
    const thread = await store.createThread(USER_A, project.id, "Complete output");
    const prompt = message("user", "complete");
    const output = "x".repeat(64_191);
    const reply: ChatMessage = { ...message("assistant", "complete"), content: "Original answer", toolResults: [{
      id: "original-tool-result", kind: "app", title: "Original result", status: "complete", summary: null,
      output, sourceIds: [], createdAt: new Date().toISOString(),
    }] };
    await store.beginThreadTurn(USER_A, thread.id, prompt, reply);
    const reopened = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    expect((await reopened.getThread(USER_A, thread.id)).messages).toEqual([prompt, reply]);
    await reopened.updateThread(USER_A, thread.id, { status: "archived" });
    expect((await new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot }).getThread(USER_A, thread.id)).messages).toEqual([prompt, reply]);
  });
  it("retains only the requested history in access snapshots while keeping the full durable workbench", async () => {
    const { store } = await fixture();
    const project = await store.createProject(USER_A, "Access metadata");
    const target = await store.createThread(USER_A, project.id, "Target");
    const unrelated = await store.createThread(USER_A, project.id, "Unrelated history");
    const prompt = message("user", "complete");
    const reply = { ...message("assistant", "complete"), content: "Preserved result" };
    await store.beginThreadTurn(USER_A, unrelated.id, prompt, reply);
    const targetPrompt = message("user", "complete");
    const targetReply = { ...message("assistant", "complete"), content: "Target result" };
    await store.beginThreadTurn(USER_A, target.id, targetPrompt, targetReply);
    const access = await store.loadAccessSnapshot(USER_A, target.id, { includeTurnContext: true });
    expect(access.threads.find(({ id }) => id === target.id)?.messages).toEqual([targetPrompt, targetReply]);
    expect(access.threads.find(({ id }) => id === unrelated.id)?.messages).toEqual([]);
    expect((await store.loadAccessSnapshot(USER_A)).threads.every(({ messages }) => messages.length === 0)).toBe(true);
    expect((await store.getThread(USER_A, unrelated.id)).messages).toEqual([prompt, reply]);
    expect(access.turnContext?.context.projectId).toBe(project.id);
    expect(access.turnContext?.context.projectSourceOwnerId).toBe(USER_A);
    expect(access.turnContext?.rebootstrapHistory).toContain("Target result");
  });
  it.each([false, true])("reads the committed workbench during a write without touching its temporary (cold=%s)", async (cold) => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Committed project");
    await store.load(USER_A);
    const stateRoot = path.join(usersRoot, USER_A, "state");
    const statePath = path.join(stateRoot, "workbench.json");
    const temporaryPath = atomicTemporaryPath(statePath);
    if (cold) {
      // A different inode invalidates the process cache and exercises the
      // actual canonical-file read, as on a cold process or a large history.
      await writeFile(temporaryPath, await readFile(statePath), { mode: 0o600 });
      await rename(temporaryPath, statePath);
    }
    const locks = new ResourceLockManager({ rootDirectory: path.join(stateRoot, ".locks") });
    const lease = await locks.acquire(`workbench:${INSTALLATION_ID}:${USER_A}`);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // The temporary belongs to an unfinished writer. A reader must use the
      // canonical commit and must not quarantine, promote or remove this file.
      await writeFile(temporaryPath, '{"unfinished":', { mode: 0o600 });
      const snapshot = await Promise.race([
        new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot }).load(USER_A),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("reader waited for the writer lock")), 1_000);
        }),
      ]);
      expect(snapshot.projects.find(({ id }) => id === project.id)?.name).toBe("Committed project");
      expect(await readFile(temporaryPath, "utf8")).toBe('{"unfinished":');
    } finally {
      if (deadline) clearTimeout(deadline);
      await lease.release();
    }
  });

  it("keeps canonical recovery behind the writer lock", async () => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Recoverable project");
    await store.load(USER_A);
    const stateRoot = path.join(usersRoot, USER_A, "state");
    const statePath = path.join(stateRoot, "workbench.json");
    const temporaryPath = atomicTemporaryPath(statePath);
    const committed = await readFile(statePath);
    const locks = new ResourceLockManager({ rootDirectory: path.join(stateRoot, ".locks") });
    const lease = await locks.acquire(`workbench:${INSTALLATION_ID}:${USER_A}`);
    const lockAttempt = vi.spyOn(ResourceLockManager.prototype, "withLock");
    let reading: ReturnType<FileWorkbenchStore["load"]> | undefined;
    try {
      await writeFile(temporaryPath, committed, { mode: 0o600 });
      await writeFile(statePath, "{corrupt", { mode: 0o600 });
      reading = store.load(USER_A);
      await vi.waitFor(() => expect(lockAttempt).toHaveBeenCalled());
      expect(await readFile(statePath, "utf8")).toBe("{corrupt");
      expect(await readFile(temporaryPath)).toEqual(committed);
    } finally {
      lockAttempt.mockRestore();
      await lease.release();
    }
    const recovered = await reading!;
    expect(recovered.projects.find(({ id }) => id === project.id)?.name).toBe("Recoverable project");
    expect(JSON.parse(await readFile(statePath, "utf8")).userId).toBe(USER_A);
  });

  it("persists staged Ogg turn metadata across restart and coalesces retries without crossing users", async () => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Voice notes");
    const thread = await store.createThread(USER_A, project.id, "Read voice notes");
    const user = message("user", "complete");
    user.attachments = [{ id: randomUUID(), name: "original.ogg", mimeType: "audio/ogg", size: 125139 }];
    const assistant = message("assistant", "streaming");
    expect((await store.beginThreadTurn(USER_A, thread.id, user, assistant)).outcome).toBe("created");
    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    expect((await restarted.getThread(USER_A, thread.id)).messages[0].attachments).toEqual(user.attachments);
    expect((await restarted.beginThreadTurn(USER_A, thread.id, user, assistant)).outcome).toBe("existing");
    expect((await restarted.getThread(USER_A, thread.id)).messages).toHaveLength(2);
    await expect(restarted.getThread(USER_B, thread.id)).rejects.toBeInstanceOf(WorkbenchNotFoundError);
  });

  it("persists template and ASC measurement attachments across restart and identical retries", async () => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Quality report fixture");
    const thread = await store.createThread(USER_A, project.id, "Read template and measurements");
    const user = message("user", "complete");
    user.attachments = [
      { id: randomUUID(), name: "1120000633.xltx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.template", size: 2048 },
      { id: randomUUID(), name: "1120000633 INFORME.asc", mimeType: "text/plain", size: 128 },
    ];
    const assistant = message("assistant", "streaming");
    expect((await store.beginThreadTurn(USER_A, thread.id, user, assistant)).outcome).toBe("created");
    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    expect((await restarted.getThread(USER_A, thread.id)).messages[0].attachments).toEqual(user.attachments);
    expect((await restarted.beginThreadTurn(USER_A, thread.id, user, assistant)).outcome).toBe("existing");
    expect((await restarted.getThread(USER_A, thread.id)).messages).toHaveLength(2);
    await expect(restarted.getThread(USER_B, thread.id)).rejects.toBeInstanceOf(WorkbenchNotFoundError);
  });

  it("reports real request metadata while usage is absent, excluding empty threads and other users", async () => {
    const { store } = await fixture();
    const project = await store.createProject(USER_A, "Activity");
    const thread = await store.createThread(USER_A, project.id, "Request");
    await store.createThread(USER_A, project.id, "Empty renamed thread");
    const user = message("user", "complete");
    const assistant = message("assistant", "streaming");
    await store.beginThreadTurn(USER_A, thread.id, user, assistant);
    expect(await store.activityMetadata(USER_A)).toEqual({ requestTimes: [user.createdAt], conversationTimes: [(await store.getThread(USER_A, thread.id)).updatedAt], runningTurns: 1 });
    expect(await store.activityMetadata(USER_B)).toEqual({ requestTimes: [], conversationTimes: [], runningTurns: 0 });
    await store.finishThreadTurn(USER_A, thread.id, { ...assistant, status: "complete" }, null);
    expect(await store.activityMetadata(USER_A)).toEqual({ requestTimes: [user.createdAt], conversationTimes: [(await store.getThread(USER_A, thread.id)).updatedAt], runningTurns: 0 });
  });

  it("persists validated legacy Excel attachments across restart with user isolation", async () => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Legacy workbook");
    const thread = await store.createThread(USER_A, project.id, "Edit XLS");
    const user = message("user", "complete");
    user.attachments = [{ id: randomUUID(), name: "fixture.xls", mimeType: "application/vnd.ms-excel", size: 5632 }];
    const assistant = message("assistant", "streaming");
    await store.beginThreadTurn(USER_A, thread.id, user, assistant);
    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    expect((await restarted.getThread(USER_A, thread.id)).messages[0].attachments).toEqual(user.attachments);
    await expect(restarted.getThread(USER_B, thread.id)).rejects.toBeInstanceOf(WorkbenchNotFoundError);
  });

  it("persists server references across restart and rejects changed-reference retry", async () => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Source references");
    const thread = await store.createThread(USER_A, project.id, "Selected source");
    const user = message("user", "complete");
    user.connectorMentions = ["composio-gmail"];
    user.serverReferences = [{ path: "server-arnall/Y/QA.txt", name: "QA.txt", kind: "file", size: 1, modifiedAt: null }];
    const assistant = message("assistant", "streaming");
    await store.beginThreadTurn(USER_A, thread.id, user, assistant);
    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    expect((await restarted.getThread(USER_A, thread.id)).messages[0].connectorMentions).toEqual(["composio-gmail"]);
    await expect(restarted.beginThreadTurn(USER_A, thread.id, { ...user, connectorMentions: [] }, assistant)).rejects.toBeInstanceOf(WorkbenchConflictError);
    expect((await restarted.getThread(USER_A, thread.id)).messages[0].serverReferences).toEqual(user.serverReferences);
    await expect(restarted.beginThreadTurn(USER_A, thread.id, { ...user, serverReferences: [] }, assistant)).rejects.toBeInstanceOf(WorkbenchConflictError);
  });

  it("persists project instructions, sources, memory and local sharing in runtime context", async () => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Company handbook");
    const sourceId = randomUUID();
    const memberId = randomUUID();
    const updatedAt = new Date().toISOString();
    await store.updateProject(USER_A, project.id, {
      instructions: "Responde en español y cita las fuentes del proyecto.",
      sources: [{
        id: sourceId,
        kind: "note",
        name: "Política comercial",
        url: null,
        mimeType: "text/plain",
        size: 26,
        excerpt: "Descuento máximo autorizado: 10%.",
        status: "ready",
        createdAt: updatedAt,
      }],
      memory: { enabled: true, notes: "El cliente prefiere entregas los viernes.", updatedAt },
      sharing: {
        visibility: "shared",
        members: [{
          id: memberId,
          email: "ana@example.com",
          name: null,
          role: "editor",
          status: "invited-local",
          addedAt: updatedAt,
        }],
      },
    });

    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    await expect(restarted.getProjectRuntimeContext(USER_A, project.id)).resolves.toMatchObject({
      projectInstructions: "Responde en español y cita las fuentes del proyecto.",
      projectMemory: "El cliente prefiere entregas los viernes.",
      projectSources: [{ name: "Política comercial", status: "ready" }],
    });
    await expect(restarted.getProject(USER_A, project.id)).resolves.toMatchObject({
      sharing: { visibility: "shared", members: [{ email: "ana@example.com", role: "editor" }] },
    });
  });

  it("treats an identical retried turn as idempotent and rejects divergent reuse", async () => {
    const { store } = await fixture();
    const project = await store.createProject(USER_A, "Retry project");
    const thread = await store.createThread(USER_A, project.id, "Retry thread");
    const userMessage = message("user", "complete");
    const assistantMessage = message("assistant", "streaming");
    await expect(store.beginThreadTurn(USER_A, thread.id, userMessage, assistantMessage))
      .resolves.toMatchObject({ outcome: "created" });
    await expect(store.beginThreadTurn(
      USER_A,
      thread.id,
      { ...userMessage, createdAt: new Date(Date.now() + 1_000).toISOString() },
      { ...assistantMessage, createdAt: new Date(Date.now() + 1_001).toISOString() },
    )).resolves.toMatchObject({ outcome: "existing", assistantMessage: { id: assistantMessage.id } });
    await expect(store.beginThreadTurn(
      USER_A,
      thread.id,
      { ...userMessage, content: "Different payload" },
      assistantMessage,
    )).rejects.toBeInstanceOf(WorkbenchConflictError);
    await expect(store.beginThreadTurn(
      USER_A,
      thread.id,
      message("user", "complete"),
      message("assistant", "streaming"),
    )).rejects.toBeInstanceOf(WorkbenchConflictError);
  });

  it("reopens the same visible turn after a failed scheduled attempt", async () => {
    const { store } = await fixture();
    const project = await store.createProject(USER_A, "Scheduled retry project");
    const thread = await store.createThread(USER_A, project.id, "Scheduled retry thread");
    const userMessage = message("user", "complete");
    const assistantMessage = message("assistant", "streaming");
    await store.beginThreadTurn(USER_A, thread.id, userMessage, assistantMessage);
    await store.finishThreadTurn(
      USER_A,
      thread.id,
      { ...assistantMessage, content: "Transient gateway failure", status: "error" },
      null,
    );

    const retriedAssistant = { ...assistantMessage, content: "", status: "streaming" as const };
    await expect(store.beginThreadTurn(
      USER_A,
      thread.id,
      userMessage,
      retriedAssistant,
      { retryExistingFailure: true },
    )).resolves.toMatchObject({ outcome: "existing", assistantMessage: { status: "streaming", content: "" } });

    const persisted = await store.getThread(USER_A, thread.id);
    expect(persisted.messages.filter((candidate) => candidate.id === userMessage.id)).toHaveLength(1);
    expect(persisted.messages.filter((candidate) => candidate.id === assistantMessage.id)).toHaveLength(1);
    expect(persisted.messages.at(-1)).toMatchObject({ id: assistantMessage.id, status: "streaming", content: "" });
  });

  it("reuses a deterministic thread id after a worker recovery boundary", async () => {
    const { store } = await fixture();
    const project = await store.createProject(USER_A, "Recovery project");
    const threadId = "00000000-0000-4000-8000-000000000099";
    const first = await store.createThread(USER_A, project.id, "Programada · Informe", threadId);
    const recovered = await store.createThread(USER_A, project.id, "Programada · Informe", threadId);

    expect(recovered).toEqual(first);
    expect((await store.load(USER_A)).threads.filter((thread) => thread.id === threadId)).toHaveLength(1);
  });

  it("persists approval fingerprints produced by projected runtime events", async () => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Approval project");
    const thread = await store.createThread(USER_A, project.id, "Approval thread");
    const userMessage = message("user", "complete");
    const assistantMessage: ChatMessage = {
      ...message("assistant", "streaming"),
      artifacts: [{
        id: randomUUID(),
        type: "browser",
        name: "Private browser",
        status: "ready",
        control: "agent",
        viewerUrl: null,
        captureUrl: null,
        downloadUrl: null,
        error: null,
      }],
      approvals: [{
        id: "approval-1",
        threadId: "runtime-thread-1",
        turnId: "runtime-turn-1",
        itemId: "runtime-item-1",
        kind: "browser",
        title: "Open page",
        detail: "Open an external page in the isolated browser.",
        permissionFingerprint: "a".repeat(64),
        authorizationFingerprint: "b".repeat(64),
        status: "accepted",
      }],
    };

    await store.beginThreadTurn(USER_A, thread.id, userMessage, assistantMessage);
    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    await expect(restarted.load(USER_A)).resolves.toMatchObject({
      threads: [expect.objectContaining({
        id: thread.id,
        messages: [userMessage, assistantMessage],
      })],
    });
  });

  it("finishes a reviewed connector edit durably and admits the next undo turn", async () => {
    const { usersRoot, store } = await fixture(), project = await store.createProject(USER_A, "Shopify QA"), thread = await store.createThread(USER_A, project.id, "Draft edit");
    const user = message("user", "complete"), running = message("assistant", "streaming");
    await store.beginThreadTurn(USER_A, thread.id, user, running);
    const completed: ChatMessage = { ...running, status: "complete", content: "Saved and verified", approvals: [{ id: "shopify-edit:call", threadId: "runtime-thread", turnId: "runtime-turn", itemId: "call", kind: "file", title: "Change Shopify draft website", detail: "Draft only", status: "accepted", connectorAuthorizationFingerprint: "a".repeat(64), fileReview: { filename: "templates/index.json", changes: [{ before: "Old heading", after: "New heading" }] } }] };
    await store.finishThreadTurn(USER_A, thread.id, completed, "synthetic-private-resume-token");
    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    expect((await restarted.load(USER_A)).threads[0].messages.at(-1)).toEqual(completed);
    await expect(restarted.beginThreadTurn(USER_A, thread.id, message("user", "complete"), message("assistant", "streaming"))).resolves.toMatchObject({ outcome: "created" });
    await expect(restarted.finishThreadTurn(USER_A, thread.id, { ...completed, approvals: [{ ...completed.approvals[0], connectorAuthorizationFingerprint: "malformed" }] }, null)).rejects.toThrow();
  });

  it("durably finishes image turns with dimensions while rejecting invalid or unknown fields", async () => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Image project");
    const thread = await store.createThread(USER_A, project.id, "Presentation visuals");
    const userMessage = message("user", "complete");
    const assistantMessage = message("assistant", "streaming");
    await store.beginThreadTurn(USER_A, thread.id, userMessage, assistantMessage);
    const imageId = randomUUID();
    const legacyId = randomUUID();
    const finished: ChatMessage = { ...assistantMessage, status: "complete", content: "Visuals prepared", artifacts: [
      { id: imageId, type: "image", name: "visual.png", url: `/api/projects/${project.id}/artifacts/${imageId}`, prompt: null, width: 1672, height: 941 },
      { id: legacyId, type: "image", name: "legacy.png", url: `/api/projects/${project.id}/artifacts/${legacyId}`, prompt: null },
    ] };
    await store.finishThreadTurn(USER_A, thread.id, finished, null);
    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    expect((await restarted.getThread(USER_A, thread.id)).messages.at(-1)).toEqual(finished);

    for (const invalidFields of [
      { width: 0 }, { height: 8193 }, { width: 1.5 }, { height: "941" },
      { width: undefined }, { unexpected: "must remain forbidden" },
    ]) {
      const invalid = structuredClone(finished);
      Object.assign(invalid.artifacts[0]!, invalidFields);
      await expect(store.finishThreadTurn(USER_A, thread.id, invalid, null)).rejects.toBeInstanceOf(WorkbenchPersistenceError);
      expect((await restarted.getThread(USER_A, thread.id)).messages.at(-1)).toEqual(finished);
    }
  });

  it("finishes and reloads turns with an authenticated spreadsheet preview", async () => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Spreadsheet project");
    const thread = await store.createThread(USER_A, project.id, "Schedule preview");
    const userMessage = message("user", "complete");
    const assistantMessage = message("assistant", "streaming");
    await store.beginThreadTurn(USER_A, thread.id, userMessage, assistantMessage);
    const finished: ChatMessage = { ...assistantMessage, status: "complete", artifacts: [{
      id: randomUUID(), type: "document", name: "Schedule.xlsm", kind: "text", mimeType: "application/json",
      url: `/api/projects/${project.id}/files?path=document-previews%2Fschedule.json&raw=1&download=1`,
      previewUrl: `/api/projects/${project.id}/files?path=document-previews%2Fschedule.json&raw=1&download=1`,
      previewFormat: "spreadsheet", size: 1000, status: "ready", pages: null,
      publicationStatus: null, publicationError: null, targetLabel: null, error: null,
    }] };
    await store.finishThreadTurn(USER_A, thread.id, finished, null);
    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    expect((await restarted.getThread(USER_A, thread.id)).messages.at(-1)).toEqual(finished);
    const invalid = structuredClone(finished);
    Object.assign(invalid.artifacts[0], { previewFormat: "unsafe-format" });
    await expect(store.finishThreadTurn(USER_A, thread.id, invalid, null)).rejects.toThrow();
    expect((await restarted.getThread(USER_A, thread.id)).messages.at(-1)).toEqual(finished);
  });

  it("creates durable conversation branches with exact lineage and complete prior context", async () => {
    const { usersRoot, store } = await fixture();
    const project = await store.createProject(USER_A, "Branch project");
    const parent = await store.createThread(USER_A, project.id, "Original conversation");
    const firstUser = { ...message("user", "complete"), content: "First request" };
    const longResult = `${"A".repeat(13_500)}-END-OF-FULL-RESULT`;
    const firstAssistant = { ...message("assistant", "complete"), content: longResult };
    const secondUser = { ...message("user", "complete"), content: "Second request" };
    const secondAssistant = { ...message("assistant", "complete"), content: "Second result" };
    await store.beginThreadTurn(USER_A, parent.id, firstUser, firstAssistant);
    await store.beginThreadTurn(USER_A, parent.id, secondUser, secondAssistant);
    expect(await store.getThreadConversationHistory(USER_A, parent.id)).toContain("Second result");

    const edited = await store.branchThread(USER_A, parent.id, {
      kind: "edit", messageId: secondUser.id, editedContent: "Edited second request",
    });
    expect(edited).toMatchObject({
      draftMessage: "Edited second request",
      thread: {
        lineage: { parentThreadId: parent.id, branchedFromMessageId: secondUser.id, kind: "edit" },
        messages: [{ id: firstUser.id }, { id: firstAssistant.id }],
      },
    });
    const context = await store.getThreadRuntimeContext(USER_A, edited.thread.id);
    expect(context.branchHistory).toContain("-END-OF-FULL-RESULT");
    expect(context.branchHistory?.length).toBeGreaterThan(13_500);

    const retried = await store.branchThread(USER_A, parent.id, {
      kind: "retry", messageId: secondAssistant.id,
    });
    expect(retried.draftMessage).toBe("Second request");
    expect(retried.thread.messages.map((item) => item.id)).toEqual([firstUser.id, firstAssistant.id]);

    const continued = await store.branchThread(USER_A, parent.id, {
      kind: "branch", messageId: firstAssistant.id,
    });
    expect(continued.draftMessage).toBeNull();
    expect(continued.thread.messages.map((item) => item.id)).toEqual([firstUser.id, firstAssistant.id]);
    expect((await store.getThread(USER_A, parent.id)).messages).toHaveLength(4);

    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    await expect(restarted.getThread(USER_A, edited.thread.id)).resolves.toMatchObject({
      lineage: { parentThreadId: parent.id, branchedFromMessageId: secondUser.id, kind: "edit" },
    });
    await expect(restarted.getThread(USER_B, edited.thread.id)).rejects.toBeInstanceOf(WorkbenchNotFoundError);
  });

  it("provisions the hidden standalone-chat workspace and persists projects, threads, turns, activity and runtime token across restart", async () => {
    const { usersRoot, store } = await fixture();
    const initial = await store.load(USER_A);
    expect(initial).toMatchObject({ persistence: "filesystem", threads: [] });
    expect(initial.projects).toEqual([
      expect.objectContaining({ name: "Conversaciones", slug: STANDALONE_PROJECT_SLUG }),
    ]);
    await expect(store.listProjects(USER_A, ACTIVE_QUERY)).resolves.toMatchObject({ items: [] });

    const project = await store.createProject(USER_A, "Client Operations");
    const thread = await store.createThread(USER_A, project.id, "First delivery");
    const userMessage = message("user", "complete");
    const assistantMessage = message("assistant", "streaming");
    await store.beginThreadTurn(USER_A, thread.id, userMessage, assistantMessage);
    const activity = {
      id: randomUUID(),
      kind: "tool" as const,
      label: "Checked source",
      status: "complete" as const,
    };
    await store.updateMessageActivity(USER_A, thread.id, assistantMessage.id, activity);
    await store.finishThreadTurn(
      USER_A,
      thread.id,
      {
        ...assistantMessage,
        content: "Synthetic result",
        status: "complete",
        activity: [activity],
      },
      "runtime-thread-synthetic-001",
    );
    await store.updateProject(USER_A, project.id, { name: "Client Ops", pinned: true, status: "archived" });
    expect((await store.load(USER_A)).projects.find((item) => item.id === project.id)?.status).toBe("archived");
    await store.updateProject(USER_A, project.id, { status: "active" });
    await store.updateThread(USER_A, thread.id, { title: "Delivered", pinned: true, status: "archived" });

    const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
    const snapshot = await restarted.load(USER_A);
    expect(snapshot.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: STANDALONE_PROJECT_SLUG }),
      expect.objectContaining({ id: project.id, name: "Client Ops", pinned: true }),
    ]));
    expect(snapshot.threads).toEqual([
      expect.objectContaining({
        id: thread.id,
        title: "Delivered",
        status: "archived",
        pinned: true,
        messages: [userMessage, expect.objectContaining({ content: "Synthetic result" })],
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("runtime-thread-synthetic-001");
    await restarted.updateThread(USER_A, thread.id, { status: "active" });
    await expect(restarted.getThreadRuntimeContext(USER_A, thread.id)).resolves.toMatchObject({
      projectId: project.id,
      runtimeThreadToken: "runtime-thread-synthetic-001",
    });
  });

  it("keeps two users isolated even when ids, names and operations are supplied across boundaries", async () => {
    const { store } = await fixture();
    const projectA = await store.createProject(USER_A, "Shared name");
    const projectB = await store.createProject(USER_B, "Shared name");
    const threadB = await store.createThread(USER_B, projectB.id, "Private B");

    await expect(store.updateProject(USER_A, projectB.id, { name: "stolen" }))
      .rejects.toBeInstanceOf(WorkbenchNotFoundError);
    await expect(store.getThreadRuntimeContext(USER_A, threadB.id))
      .rejects.toBeInstanceOf(WorkbenchNotFoundError);
    await expect(store.getProject(USER_A, projectB.id))
      .rejects.toBeInstanceOf(WorkbenchNotFoundError);
    await expect(store.getThread(USER_A, threadB.id))
      .rejects.toBeInstanceOf(WorkbenchNotFoundError);
    await expect(store.listThreads(USER_A, projectB.id, ACTIVE_QUERY))
      .rejects.toBeInstanceOf(WorkbenchNotFoundError);
    expect((await store.load(USER_A)).projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: STANDALONE_PROJECT_SLUG }),
      expect.objectContaining({ id: projectA.id }),
    ]));
    expect((await store.load(USER_A)).threads).toEqual([]);
    expect((await store.load(USER_B)).projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: STANDALONE_PROJECT_SLUG }),
      expect.objectContaining({ id: projectB.id }),
    ]));
    expect((await store.load(USER_B)).threads).toEqual([expect.objectContaining({ id: threadB.id })]);
  });

  it("serializes concurrent mutations across independent store instances", async () => {
    const { usersRoot } = await fixture();
    const stores = Array.from({ length: 4 }, () =>
      new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot }));
    const projects = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      stores[index % stores.length].createProject(USER_A, "Concurrent project")));

    expect(new Set(projects.map((project) => project.id))).toHaveLength(32);
    expect(new Set(projects.map((project) => project.slug))).toHaveLength(32);
    const snapshot = await stores[0].load(USER_A);
    expect(snapshot.projects).toHaveLength(33);
    const raw = JSON.parse(await readFile(
      path.join(usersRoot, USER_A, "state", "workbench.json"),
      "utf8",
    )) as { revision: number };
    expect(raw.revision).toBe(33);
  });

  it("fails closed on foreign, corrupt and symbolic-link state instead of reseeding", async () => {
    const { root, usersRoot, store } = await fixture();
    await store.load(USER_A);
    await store.load(USER_B);
    const statePath = path.join(usersRoot, USER_A, "state", "workbench.json");
    const foreignState = await readFile(
      path.join(usersRoot, USER_B, "state", "workbench.json"),
      "utf8",
    );
    await writeFile(statePath, foreignState, "utf8");
    await expect(store.load(USER_A)).rejects.toBeInstanceOf(WorkbenchPersistenceError);

    await writeFile(statePath, "{not-json}\n", "utf8");
    await expect(store.load(USER_A)).rejects.toBeInstanceOf(StorageCorruptionError);

    await rm(path.join(usersRoot, USER_A, "state"), { recursive: true, force: true });
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(usersRoot, USER_A, "state"));
    await expect(store.load(USER_A)).rejects.toBeInstanceOf(WorkbenchPersistenceError);
  });

  it("rejects unprovisioned and non-canonical user roots", async () => {
    const { store } = await fixture();
    await expect(store.load("../../escape")).rejects.toBeInstanceOf(WorkbenchNotFoundError);
    await expect(store.load("0198B9F0-6631-7000-8000-000000000101"))
      .rejects.toBeInstanceOf(WorkbenchNotFoundError);
    await expect(store.load("0198b9f0-6631-7000-8000-000000000999"))
      .rejects.toBeInstanceOf(WorkbenchNotFoundError);
  });

  it("lists and searches projects with bounded opaque keyset pagination", async () => {
    const { store } = await fixture();
    const alpha = await store.createProject(USER_A, "Alpha Operations");
    const beta = await store.createProject(USER_A, "Beta Finance");
    const gamma = await store.createProject(USER_A, "Gamma Delivery");
    await store.updateProject(USER_A, gamma.id, { pinned: true });
    await store.updateProject(USER_A, beta.id, { status: "archived" });

    const first = await store.listProjects(USER_A, { status: "active", limit: 1 });
    expect(first.items).toEqual([expect.objectContaining({ id: gamma.id, pinned: true })]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await store.listProjects(USER_A, {
      status: "active",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items).toEqual([expect.objectContaining({ id: alpha.id })]);
    expect(second.nextCursor).toBeNull();

    await expect(store.listProjects(USER_A, {
      status: "archived",
      limit: 1,
      cursor: first.nextCursor!,
    })).rejects.toBeInstanceOf(WorkbenchValidationError);
    await expect(store.listProjects(USER_A, { status: "active", limit: 51 }))
      .rejects.toBeInstanceOf(WorkbenchValidationError);
    await expect(store.listProjects(USER_A, { status: "active", limit: 20, cursor: "not-a-cursor" }))
      .rejects.toBeInstanceOf(WorkbenchValidationError);

    expect((await store.listProjects(USER_A, {
      status: "all",
      limit: 20,
      query: "FINANCE",
    })).items).toEqual([expect.objectContaining({ id: beta.id, status: "archived" })]);
  });

  it("returns thread summaries for lists, full history only on read, and supports lifecycle transitions", async () => {
    const { store } = await fixture();
    const project = await store.createProject(USER_A, "Lifecycle Project");
    const thread = await store.createThread(USER_A, project.id, "Quarterly planning");
    const userMessage = message("user", "complete");
    const assistantMessage = message("assistant", "complete");
    await store.beginThreadTurn(USER_A, thread.id, userMessage, assistantMessage);

    const page = await store.listThreads(USER_A, project.id, {
      status: "active",
      limit: 20,
      query: "PLANNING",
    });
    expect(page).toEqual({
      items: [expect.objectContaining({
        id: thread.id,
        messageCount: 2,
        lastMessageAt: assistantMessage.createdAt,
      })],
      nextCursor: null,
    });
    expect(page.items[0]).not.toHaveProperty("messages");
    expect((await store.getThread(USER_A, thread.id)).messages).toEqual([userMessage, assistantMessage]);

    const renamed = await store.updateProject(USER_A, project.id, { name: "Renamed Project", pinned: true });
    expect(renamed).toMatchObject({ name: "Renamed Project", pinned: true });
    expect(renamed.workspace.label).toBe("Renamed Project");
    expect(await store.updateThread(USER_A, thread.id, {
      title: "Renamed thread",
      pinned: true,
      status: "archived",
    })).toMatchObject({ title: "Renamed thread", pinned: true, status: "archived" });

    await store.updateProject(USER_A, project.id, { status: "archived" });
    await expect(store.updateThread(USER_A, thread.id, { status: "active" }))
      .rejects.toBeInstanceOf(WorkbenchConflictError);
    await store.updateProject(USER_A, project.id, { status: "active" });
    await expect(store.updateThread(USER_A, thread.id, { status: "active" }))
      .resolves.toMatchObject({ status: "active" });
  });

  it("strictly parses bounded list queries", () => {
    expect(parseWorkbenchListQuery(new URLSearchParams())).toEqual({ status: "active", limit: 20 });
    expect(parseWorkbenchListQuery(new URLSearchParams("status=all&limit=50&q=%20alpha%20")))
      .toEqual({ status: "all", limit: 50, query: "alpha" });
    expect(parseWorkbenchListQuery(new URLSearchParams("limit=51"))).toBeNull();
    expect(parseWorkbenchListQuery(new URLSearchParams("limit=01"))).toBeNull();
    expect(parseWorkbenchListQuery(new URLSearchParams("q="))).toBeNull();
    expect(parseWorkbenchListQuery(new URLSearchParams("q=a&q=b"))).toBeNull();
    expect(parseWorkbenchListQuery(new URLSearchParams("unknown=value"))).toBeNull();
  });
});

it("refreshes a completed MODTIME card from its durable executed receipt without reopening the model turn", async () => {
  const { usersRoot } = await fixture(), store = new FileWorkbenchStore({ installationId: "modtime", usersRoot });
  const project = await store.createProject(USER_A, "Shopify review"), thread = await store.createThread(USER_A, project.id, "Draft edit");
  const user = message("user", "complete"), running = message("assistant", "streaming");
  await store.beginThreadTurn(USER_A, thread.id, user, running);
  const card = { id: "shopify-edit:async", threadId: "runtime-thread", turnId: "runtime-turn", itemId: "async", connectorAuthorizationFingerprint: "a".repeat(64), kind: "file" as const, title: "Change Shopify draft website", detail: "Draft only", status: "pending" as const };
  await store.finishThreadTurn(USER_A, thread.id, { ...running, status: "complete", approvals: [card] }, "synthetic-private-resume-token");
  const receipts = new FileApprovalStore({ installationId: "modtime", userId: USER_A, usersRoot });
  const locator = { installationId: "modtime", userId: USER_A, threadId: card.threadId, turnId: card.turnId, itemId: card.itemId, approvalId: card.id };
  await receipts.prepareConnectorApproval({ locator, authorizationFingerprint: card.connectorAuthorizationFingerprint });
  await receipts.approveConnectorApprovalByLocator(locator, card.connectorAuthorizationFingerprint);
  await receipts.executeConnectorApprovalByLocator(locator, card.connectorAuthorizationFingerprint, { revalidate: () => true, execute: () => "verified" });
  const refreshed = await new FileWorkbenchStore({ installationId: "modtime", usersRoot }).getThread(USER_A, thread.id);
  expect(refreshed.messages.at(-1)).toMatchObject({ status: "complete", approvals: [{ status: "accepted", title: "Shopify draft saved and verified" }] });
  await expect(store.beginThreadTurn(USER_A, thread.id, message("user", "complete"), message("assistant", "streaming"))).resolves.toMatchObject({ outcome: "created" });
});

it("atomically persists a private assistant greeting once across concurrent retries and restarts", async () => {
  const { usersRoot, store } = await fixture();
  const snapshot = await store.load(USER_A);
  const project = snapshot.projects.find(p => p.slug === STANDALONE_PROJECT_SLUG)!;
  const id = randomUUID();
  const results = await Promise.all(Array.from({ length: 3 }, () => store.createThread(USER_A, project.id, "Benvinguda", id, "Hola, aquesta és la teva conversa privada.")));
  expect(results.every(thread => thread.messages.length === 1 && thread.messages[0].role === "assistant")).toBe(true);
  const restarted = new FileWorkbenchStore({ installationId: INSTALLATION_ID, usersRoot });
  expect((await restarted.load(USER_A)).threads.filter(thread => thread.id === id)).toHaveLength(1);
  expect((await restarted.load(USER_B)).threads.some(thread => thread.id === id)).toBe(false);
  await expect(store.createThread(USER_B, project.id, "Benvinguda", id, "Hola")).rejects.toBeInstanceOf(WorkbenchNotFoundError);
  await expect(store.createThread(USER_A, project.id, "Benvinguda", randomUUID(), " ")).rejects.toBeInstanceOf(WorkbenchValidationError);
});


describe("archive generated automation result", () => {
  async function generated() {
    const { store } = await fixture();
    const project = await store.createProject(USER_A, "Automation results");
    const runKey = `${randomUUID()}:2027-02-01T08:00:00.000Z`;
    const ids = automationRunIdentities(runKey);
    const thread = await store.createThread(USER_A, project.id, "Automatic review", ids.threadId);
    const user = { ...message("user", "complete"), id: ids.userMessageId, content: "Review new events." };
    const assistant = { ...message("assistant", "complete"), id: ids.assistantMessageId, content: "No new events." };
    await store.beginThreadTurn(USER_A, thread.id, user, assistant);
    return {store, project, thread, runKey, user, assistant, expected: {projectId:project.id,prompt:user.content,resultHash:createHash("sha256").update(assistant.content).digest("hex")}};
  }
  it("archives only the exact completed generated pair and preserves its messages and receipt", async () => {
    const f = await generated();
    expect(await f.store.archiveGeneratedAutomationResult(USER_A,f.runKey,f.expected)).toBe(true);
    expect(await f.store.archiveGeneratedAutomationResult(USER_A,f.runKey,f.expected)).toBe(true);
    const saved = await f.store.getThread(USER_A,f.thread.id);
    expect(saved.status).toBe("archived");
    expect(saved.messages).toEqual([f.user,f.assistant]);
    expect((await f.store.listThreads(USER_A,f.project.id,ACTIVE_QUERY)).items).toEqual([]);
  });
  it("archives source-read originals intact but keeps generated documents visible",async()=>{
    for(const sourceRead of [true,false]){
      const f=await generated();const artifact={id:randomUUID(),type:"document" as const,name:"original.pdf",kind:"pdf" as const,mimeType:"application/pdf",size:100,status:"ready" as const,pages:null,previewUrl:null,publicationStatus:null,publicationError:null,targetLabel:null,error:null,...(sourceRead?{provenance:"source-read" as const}:{})};
      const finished={...f.assistant,artifacts:[{...artifact,url:`/api/threads/${f.thread.id}/connector-files/${artifact.id}`}]};
      await f.store.finishThreadTurn(USER_A,f.thread.id,finished,null);
      expect(await f.store.archiveGeneratedAutomationResult(USER_A,f.runKey,f.expected)).toBe(sourceRead);
      const saved=await f.store.getThread(USER_A,f.thread.id);expect(saved.status).toBe(sourceRead?"archived":"active");expect(saved.messages[1].artifacts).toEqual(finished.artifacts);
    }
  });
  it("keeps a human follow-up active even when the preceding automatic result was quiet", async () => {
    const f = await generated();
    await f.store.beginThreadTurn(USER_A,f.thread.id,message("user","complete"),{...message("assistant","complete"),content:"Human follow-up answered."});
    expect(await f.store.archiveGeneratedAutomationResult(USER_A,f.runKey,f.expected)).toBe(false);
    expect((await f.store.getThread(USER_A,f.thread.id)).status).toBe("active");
  });
  it("rejects changed results, projects and unrelated human threads", async () => {
    const f = await generated();
    expect(await f.store.archiveGeneratedAutomationResult(USER_A,f.runKey,{...f.expected,resultHash:"a".repeat(64)})).toBe(false);
    expect(await f.store.archiveGeneratedAutomationResult(USER_A,f.runKey,{...f.expected,projectId:randomUUID()})).toBe(false);
    expect(await f.store.archiveGeneratedAutomationResult(USER_A,randomUUID(),f.expected)).toBe(false);
    const unrelated = await f.store.createThread(USER_A,f.project.id,"Human work");
    await f.store.beginThreadTurn(USER_A,unrelated.id,message("user","complete"),{...message("assistant","complete"),content:"Human result."});
    expect((await f.store.getThread(USER_A,unrelated.id)).status).toBe("active");
    expect((await f.store.getThread(USER_A,f.thread.id)).status).toBe("active");
  });
});
