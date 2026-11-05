// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ChatWorkspace } from "@/components/chat-workspace";
import type { Sidebar } from "@/components/sidebar";
import type { AuthSession } from "@/auth/types";
import type { WorkbenchProject, WorkbenchThread } from "@/workbench/types";
import { STANDALONE_PROJECT_SLUG } from "@/workbench/types";
import { initialRuntimeStatus } from "@/lib/runtime-status";
import { baseBrainManifest } from "@/config/brain";

const mocks = vi.hoisted(() => ({ createThread: vi.fn(), getThread: vi.fn(), getProject: vi.fn(), fetch: vi.fn(), workspaceSend: vi.fn() }));
vi.mock("@/lib/workbench-api-client", async original => ({ ...await original<object>(), createThreadRequest: mocks.createThread, getThreadRequest: mocks.getThread, getProjectRequest: mocks.getProject }));
vi.mock("@/ui/use-runtime-status", () => ({ useRuntimeStatus: () => initialRuntimeStatus }));
vi.mock("@/ui/use-stored-response", () => ({ useStoredResponse: () => null }));
vi.mock("@/components/chat-workspace", () => ({ ChatWorkspace: (props: ComponentProps<typeof ChatWorkspace>) => { mocks.workspaceSend.mockImplementation(props.onSend); return <main>
  <input aria-label="Draft" value={props.prompt} onChange={event => props.onPromptChange(event.target.value)} />
  <button onClick={() => props.onSend()}>Send</button>
  <button onClick={props.onStop}>Stop</button>
  <button onClick={() => props.onAttachmentsChange([{ id: "image", name: "draft.png", mimeType: "image/png", size: 1, dataUrl: "data:image/png;base64,eA==" }])}>Attach</button>
  <button onClick={() => props.onDocumentsChange([{ id: "document", uploadId: "upload", threadId: "staged", name: "draft.pdf", mimeType: "application/pdf", size: 1, kind: "pdf", status: "ready", error: null, pages: 1, previewFiles: [] }])}>Document</button>
  <button onClick={() => props.onAddDocuments([new File(["synthetic"], "new.pdf", { type: "application/pdf" })])}>Upload</button>
  <output data-testid="selection-loading">{String(props.selectionLoading)}</output>
  <output data-testid="sending">{String(props.sending)}</output>
  <output data-testid="read-only">{String(props.readOnly)}</output>
  <output data-testid="selection">{`${props.project?.id}:${props.thread?.id ?? "new"}`}</output>
  <output data-testid="attachments">{props.attachments.map(item => `${item.name}:${item.dataUrl}`).join(",")}</output>
  <output data-testid="documents">{props.documents.map(item => `${item.name}:${item.uploadId}`).join(",")}</output>
  <output data-testid="messages">{props.thread?.messages.map(item => `${item.role}:${item.status}`).join(",")}</output>
</main>; } }));
vi.mock("@/components/sidebar", () => ({ Sidebar: (props: ComponentProps<typeof Sidebar>) => <nav>
  {props.projects.map(project => <button key={project.id} onClick={() => props.onNewThread(project.id)}>{project.name}</button>)}
  {props.projects.map(project => <button key={`open-${project.id}`} onClick={() => props.onSelectProject(project.id)}>Open {project.name}</button>)}
  {props.threads.map(thread => <button key={`open-${thread.id}`} onClick={() => props.onSelectThread(thread.id)}>Thread {thread.title}</button>)}
  {props.threads.map(thread => <button key={`fast-${thread.id}`} onClick={() => { props.onSelectThread(thread.id); mocks.workspaceSend(); }}>Fast {thread.title}</button>)}
  <output data-testid="history">{props.threads.map(thread => `${thread.id}:${thread.messages.length}:${thread.messages.at(-1)?.status ?? "empty"}`).join(",")}</output>
</nav> }));
vi.mock("@/components/command-palette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/customization-panel", () => ({ CustomizationPanel: () => null }));
vi.mock("@/components/details-panel", () => ({ DetailsPanel: () => null }));
vi.mock("@/components/document-preview-panel", () => ({ DocumentPreviewPanel: () => null }));
vi.mock("@/components/project-panel", () => ({ ProjectPanel: () => null }));
vi.mock("@/components/automations-panel", () => ({ AutomationsPanel: () => null }));
vi.mock("@/components/task-center-panel", () => ({ TaskCenterPanel: () => null }));
vi.mock("@/components/workbench-dialogs", () => ({ ConfirmDialog: () => null, TextDialog: () => null }));
import { BrainApp } from "@/components/brain-app";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const project = (id: string): WorkbenchProject => ({ id, name: id, slug: id, status: "active", pinned: false, instructions: "", sources: [], memory: { enabled: false, notes: "", updatedAt: null }, sharing: { visibility: "private", members: [] }, workspace: { id, label: id, hostType: "managed", status: "ready", isPrimary: true }, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z" });
const projects = [project("A"), project("B")];
const thread = (id: string, projectId = "A"): WorkbenchThread => ({ id, projectId, title: id, status: "active", pinned: false, createdAt: projects[0].createdAt, updatedAt: projects[0].updatedAt, messages: [] });
const session: AuthSession = { provider: "local", user: { id: "qa-user", name: "QA", email: "qa@example.test" }, tenant: { id: "qa-tenant", name: "QA" }, expiresAt: "2030-01-01T00:00:00Z" };
const chatCalls = () => mocks.fetch.mock.calls.filter(([url]) => url === "/api/chat");
const controlCalls = () => mocks.fetch.mock.calls.filter(([url]) => url === "/api/runtime/turns/control");
function application(visibleProjects = projects, identity = session, visibleThreads: WorkbenchThread[] = []) {
  return <BrainApp manifest={baseBrainManifest} session={identity} branding={{ installationId: identity.tenant.id, companyName: "QA", companySlug: "qa", publicUrl: "https://example.test", productName: "QA", logoPath: "", faviconPath: "", accentColor: "blue" }} initialWorkbench={{ persistence: "filesystem", projects: visibleProjects, threads: visibleThreads }} />;
}
async function mount(options: { savedProjectId?: string | null; visibleProjects?: WorkbenchProject[] } = {}) {
  const savedProjectId = options.savedProjectId === undefined ? "A" : options.savedProjectId;
  if (savedProjectId) localStorage.setItem("aibrain.qa-tenant.qa-user.selection.v1", JSON.stringify({ activeProjectId: savedProjectId, threadByProject: {} }));
  const view = render(application(options.visibleProjects));
  await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent(`${savedProjectId ?? "standalone"}:new`));
  return view;
}
function writeDraft(value = "Review the draft") { fireEvent.change(screen.getByLabelText("Draft"), { target: { value } }); }
function click(label: string) { fireEvent.click(screen.getByRole("button", { name: label })); }

beforeEach(() => {
  localStorage.clear(); mocks.createThread.mockReset(); mocks.getThread.mockReset(); mocks.getProject.mockReset(); mocks.fetch.mockReset();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  mocks.fetch.mockImplementation(async (url: string) => url === "/api/runtime/turns/control"
    ? Response.json({ error: "not admitted" }, { status: 409 })
    : Response.json({}));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Employee project selection", () => {
  const shared = { ...project("shared-quality"), name: "Qualitat · Rafa", pinned: true, sharing: { visibility: "shared" as const, members: [] } };
  const standalone = { ...project("standalone"), slug: STANDALONE_PROJECT_SLUG };
  const visible = [shared, ...projects, standalone];

  it.each(["Open A", "Thread stored"])("hydrates metadata before selection through %s", async label => {
    const pending = deferred<WorkbenchThread>();
    const metadata = { ...thread("stored"), historyLoaded: false };
    mocks.getThread.mockReturnValueOnce(pending.promise);
    mocks.getProject.mockResolvedValue(projects[0]);
    render(application(projects, session, [metadata]));
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("undefined:new"));
    click(label);
    expect(screen.getByTestId("selection")).not.toHaveTextContent("A:stored");
    await act(async () => pending.resolve({ ...metadata, historyLoaded: true, messages: [{ id: "saved", role: "assistant", content: "Preserved", status: "complete", createdAt: projects[0].createdAt, activity: [], plan: [], approvals: [], attachments: [], artifacts: [], diff: "" }] }));
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("A:stored"));
    expect(screen.getByTestId("messages")).toHaveTextContent("assistant:complete");
    expect(mocks.getThread).toHaveBeenCalledWith("stored");
    expect(chatCalls()).toHaveLength(0);
  });

  it("does not replace a newer project selection when metadata hydration returns late", async () => {
    const pending = deferred<WorkbenchThread>();
    mocks.getThread.mockReturnValueOnce(pending.promise);
    render(application(projects, session, [{ ...thread("stored"), historyLoaded: false }]));
    click("Open A"); click("Open B");
    await act(async () => pending.resolve(thread("stored")));
    expect(screen.getByTestId("selection")).toHaveTextContent("B:new");
  });

  it.each(["Open A", "Thread stored", "Fast stored"])("blocks same-tick sends, typing and uploads until %s has fully committed", async label => {
    localStorage.setItem("aibrain.qa-tenant.qa-user.selection.v1", JSON.stringify({ activeProjectId: "A", threadByProject: {} }));
    const pending = deferred<WorkbenchThread>(), projectPending = deferred<WorkbenchProject>();
    mocks.getThread.mockReturnValueOnce(pending.promise); mocks.getProject.mockReturnValueOnce(projectPending.promise);
    render(application(projects, session, [{ ...thread("stored"), historyLoaded: false }]));
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("A:new"));
    writeDraft("Preserve the unsent draft"); click(label);
    expect(screen.getByTestId("selection-loading")).toHaveTextContent("true");
    writeDraft("Wrong destination text"); click("Attach"); click("Document"); click("Upload"); click("Send");
    expect(screen.getByLabelText("Draft")).toHaveValue("Preserve the unsent draft");
    expect(screen.getByTestId("attachments")).toBeEmptyDOMElement(); expect(screen.getByTestId("documents")).toBeEmptyDOMElement();
    expect(mocks.createThread).not.toHaveBeenCalled(); expect(chatCalls()).toHaveLength(0);
    await act(async () => pending.resolve(thread("stored")));
    if (label !== "Open A") {
      expect(screen.getByTestId("selection-loading")).toHaveTextContent("true"); click("Send");
      expect(chatCalls()).toHaveLength(0); expect(mocks.createThread).not.toHaveBeenCalled();
      await act(async () => projectPending.resolve(projects[0]));
    }
    expect(screen.getByTestId("selection")).toHaveTextContent("A:stored");
    expect(screen.getByTestId("selection-loading")).toHaveTextContent("false");
    expect(screen.getByTestId("read-only")).toHaveTextContent("false");
    click("A"); expect(screen.getByLabelText("Draft")).toHaveValue("Preserve the unsent draft");
  });

  it.each(["resolve", "reject"] as const)("an older %s cannot unblock or replace the newest pending selection", async outcome => {
    const first = deferred<WorkbenchThread>(), last = deferred<WorkbenchThread>();
    mocks.getThread.mockImplementation(id => id === "first" ? first.promise : last.promise); mocks.getProject.mockResolvedValue(projects[0]);
    render(application(projects, session, ["first", "last"].map(id => ({ ...thread(id), historyLoaded: false }))));
    click("Thread first"); click("Thread last");
    await act(async () => outcome === "resolve" ? first.resolve(thread("first")) : first.reject(Error("old request failed")));
    expect(screen.getByTestId("selection-loading")).toHaveTextContent("true"); click("Send");
    expect(chatCalls()).toHaveLength(0); expect(mocks.createThread).not.toHaveBeenCalled();
    await act(async () => last.resolve(thread("last")));
    expect(screen.getByTestId("selection")).toHaveTextContent("A:last"); expect(screen.getByTestId("selection-loading")).toHaveTextContent("false");
  });

  it("failed hydration restores the current draft without changing edit permission", async () => {
    localStorage.setItem("aibrain.qa-tenant.qa-user.selection.v1", JSON.stringify({ activeProjectId: "A", threadByProject: {} }));
    const pending = deferred<WorkbenchThread>(); mocks.getThread.mockReturnValueOnce(pending.promise);
    render(application(projects, session, [{ ...thread("stored"), historyLoaded: false }]));
    writeDraft("Keep on failure"); click("Thread stored"); await act(async () => pending.reject(Error("not available")));
    expect(screen.getByTestId("selection-loading")).toHaveTextContent("false"); expect(screen.getByTestId("selection")).toHaveTextContent("A:new");
    expect(screen.getByLabelText("Draft")).toHaveValue("Keep on failure"); writeDraft("Can edit again"); expect(screen.getByLabelText("Draft")).toHaveValue("Can edit again");
    expect(screen.getByTestId("read-only")).toHaveTextContent("false"); expect(chatCalls()).toHaveLength(0);
  });

  it("keeps the last selected thread after an earlier response arrives out of order", async () => {
    const first = deferred<WorkbenchThread>(), last = deferred<WorkbenchThread>();
    mocks.getThread.mockImplementation(id => id === "first" ? first.promise : last.promise); mocks.getProject.mockResolvedValue(projects[0]);
    render(application(projects, session, ["first", "last"].map(id => ({ ...thread(id), historyLoaded: false }))));
    click("Thread first"); click("Thread last"); await act(async () => last.resolve(thread("last")));
    writeDraft("Draft belongs to the newest selection"); await act(async () => first.resolve(thread("first")));
    expect(screen.getByTestId("selection")).toHaveTextContent("A:last"); expect(screen.getByTestId("selection-loading")).toHaveTextContent("false");
    expect(screen.getByLabelText("Draft")).toHaveValue("Draft belongs to the newest selection"); expect(mocks.getProject).toHaveBeenCalledOnce();
  });

  it("invalidates a pending selection when the authenticated identity changes", async () => {
    const pending = deferred<WorkbenchThread>(); mocks.getThread.mockReturnValueOnce(pending.promise);
    const view = render(application(projects, session, [{ ...thread("stored"), historyLoaded: false }])); click("Thread stored");
    const next = { ...session, user: { ...session.user, id: "second-user" } };
    localStorage.setItem("aibrain.qa-tenant.second-user.selection.v1", JSON.stringify({ activeProjectId: "B", threadByProject: {} }));
    view.rerender(application(projects, next)); await act(async () => pending.resolve(thread("stored")));
    expect(screen.getByTestId("selection")).toHaveTextContent("B:new"); expect(screen.getByTestId("selection-loading")).toHaveTextContent("false");
    expect(mocks.getProject).not.toHaveBeenCalled(); expect(chatCalls()).toHaveLength(0);
  });

  it("New chat cancels pending navigation and its late result preserves the new draft", async () => {
    const pending = deferred<WorkbenchThread>(); mocks.getThread.mockReturnValueOnce(pending.promise); mocks.getProject.mockResolvedValue(projects[0]);
    render(application(projects, session, [{ ...thread("stored"), historyLoaded: false }]));
    click("Thread stored"); click("B"); writeDraft("Belongs to the new B draft");
    expect(screen.getByTestId("selection-loading")).toHaveTextContent("false"); await act(async () => pending.resolve(thread("stored")));
    expect(screen.getByTestId("selection")).toHaveTextContent("B:new"); expect(screen.getByLabelText("Draft")).toHaveValue("Belongs to the new B draft");
    expect(chatCalls()).toHaveLength(0); expect(controlCalls()).toHaveLength(0);
  });

  it("does not stop an already submitted turn while another conversation loads", async () => {
    const response = deferred<Response>(), pending = deferred<WorkbenchThread>(); mocks.getThread.mockReturnValueOnce(pending.promise); mocks.getProject.mockResolvedValue(projects[0]);
    mocks.fetch.mockImplementation((url: string) => url === "/api/chat" ? response.promise : Promise.resolve(Response.json({})));
    localStorage.setItem("aibrain.qa-tenant.qa-user.selection.v1", JSON.stringify({ activeProjectId: "A", threadByProject: {} }));
    render(application(projects, session, [thread("live"), { ...thread("stored"), historyLoaded: false }]));
    click("Thread live"); writeDraft("Already running"); click("Send"); await waitFor(() => expect(chatCalls()).toHaveLength(1));
    click("Thread stored"); expect(screen.getByTestId("selection-loading")).toHaveTextContent("true"); expect(chatCalls()[0][1].signal.aborted).toBe(false); expect(controlCalls()).toHaveLength(0);
    await act(async () => pending.resolve(thread("stored"))); await act(async () => response.resolve(new Response(`${JSON.stringify({ type: "done" })}\n`)));
  });

  it("opens conversations without a project instead of the newest pinned shared project", async () => {
    await mount({ savedProjectId: null, visibleProjects: visible });
    expect(screen.getByRole("button", { name: "Qualitat · Rafa" })).toBeInTheDocument();
  });

  it("replaces G03's legacy inferred default once and then remembers explicit project choices", async () => {
    const identity = { ...session, tenant: { ...session.tenant, id: "g03-production" } };
    const legacyKey = "aibrain.g03-production.qa-user.selection.v1";
    const currentKey = "aibrain.g03-production.qa-user.selection.v2";
    localStorage.setItem(legacyKey, JSON.stringify({ activeProjectId: shared.id, threadByProject: {} }));
    const first = render(application(visible, identity));
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("standalone:new"));
    expect(localStorage.getItem(legacyKey)).toContain(shared.id);
    click("Qualitat · Rafa");
    await waitFor(() => expect(JSON.parse(localStorage.getItem(currentKey) ?? "{}").activeProjectId).toBe(shared.id));
    first.unmount();
    render(application(visible, identity));
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("shared-quality:new"));
  });

  it("preserves a shared project that the employee explicitly selected", async () => {
    await mount({ savedProjectId: shared.id, visibleProjects: visible });
    expect(screen.getByTestId("selection")).toHaveTextContent("shared-quality:new");
  });

  it("discards an unavailable saved project instead of choosing another department", async () => {
    localStorage.setItem("aibrain.qa-tenant.qa-user.selection.v1", JSON.stringify({ activeProjectId: "revoked", threadByProject: {} }));
    const view = render(application(visible));
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("standalone:new"));
    view.unmount();
  });

  it("drops a revoked selection and its visible draft when a fresh server snapshot removes access", async () => {
    const view = await mount({ savedProjectId: shared.id, visibleProjects: visible });
    writeDraft("Draft in the shared quality project"); click("Attach");
    view.rerender(application([...projects, standalone]));
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("standalone:new"));
    expect(screen.queryByRole("button", { name: "Qualitat · Rafa" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Draft")).toHaveValue("");
    expect(screen.getByTestId("attachments")).toBeEmptyDOMElement();
    expect(chatCalls()).toHaveLength(0);
  });

  it("keeps an explicit valid selection and draft through a fresh server snapshot", async () => {
    const view = await mount({ savedProjectId: shared.id, visibleProjects: visible });
    writeDraft("Keep this valid draft");
    view.rerender(application([...visible]));
    expect(screen.getByTestId("selection")).toHaveTextContent("shared-quality:new");
    expect(screen.getByLabelText("Draft")).toHaveValue("Keep this valid draft");
  });

  it("removes a revoked sidebar project while retaining the employee's other active draft", async () => {
    const view = await mount({ visibleProjects: visible });
    writeDraft("Keep this allowed draft");
    view.rerender(application([...projects, standalone]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Qualitat · Rafa" })).not.toBeInTheDocument());
    expect(screen.getByTestId("selection")).toHaveTextContent("A:new");
    expect(screen.getByLabelText("Draft")).toHaveValue("Keep this allowed draft");
  });

  it("downgrades an attached editor thread to read-only without replacing its streamed messages", async () => {
    const response = deferred<Response>();
    const live = { ...thread("editor-live"), access: { role: "editor" as const, canEdit: true, canManage: false } };
    mocks.createThread.mockResolvedValueOnce(live);
    mocks.fetch.mockImplementation((url: string) => url === "/api/chat" ? response.promise : Promise.resolve(Response.json({})));
    const view = await mount(); writeDraft(); click("Send");
    await waitFor(() => expect(chatCalls()).toHaveLength(1));
    expect(screen.getByTestId("read-only")).toHaveTextContent("false");
    const viewer = { role: "viewer" as const, canEdit: false, canManage: false };
    view.rerender(application([{ ...projects[0], access: viewer }, projects[1]], session, [{ ...live, access: viewer }]));
    await waitFor(() => expect(screen.getByTestId("read-only")).toHaveTextContent("true"));
    expect(screen.getByTestId("selection")).toHaveTextContent("A:editor-live");
    expect(screen.getByTestId("messages")).toHaveTextContent("assistant:streaming");
    expect(chatCalls()[0][1].signal.aborted).toBe(false);
    await act(async () => response.resolve(new Response(`${JSON.stringify({ type: "done" })}\n`)));
  });

  it("uses the next employee's own saved selection without carrying the prior draft across identities", async () => {
    const view = await mount({ visibleProjects: visible });
    writeDraft("Private first employee draft");
    const next = { ...session, user: { ...session.user, id: "another-user", name: "Lídia" } };
    localStorage.setItem("aibrain.qa-tenant.another-user.selection.v1", JSON.stringify({ activeProjectId: "B", threadByProject: {} }));
    view.rerender(application(visible, next));
    await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent("B:new"));
    expect(screen.getByLabelText("Draft")).toHaveValue("");
  });
});

describe("Stop while a new conversation is being created", () => {
  it.each(["resolved", "rejected"] as const)("one Stop cancels before chat submission and preserves draft/attachments when creation %s", async outcome => {
    const creation = deferred<WorkbenchThread>(); mocks.createThread.mockReturnValueOnce(creation.promise);
    await mount(); writeDraft(); click("Attach"); click("Document"); click("Send");
    expect(mocks.createThread).toHaveBeenCalledOnce(); expect(chatCalls()).toHaveLength(0);
    expect(screen.getByTestId("sending")).toHaveTextContent("true");
    click("Stop");
    await act(async () => { if (outcome === "resolved") creation.resolve(thread("cancelled-empty")); else creation.reject(Error("creation unavailable")); });
    expect(chatCalls()).toHaveLength(0); expect(controlCalls()).toHaveLength(0);
    expect(screen.getByTestId("sending")).toHaveTextContent("false");
    expect(screen.getByTestId("selection")).toHaveTextContent("A:new");
    expect(screen.getByLabelText("Draft")).toHaveValue("Review the draft");
    expect(screen.getByTestId("attachments")).toHaveTextContent("draft.png:data:image/png;base64,eA==");
    expect(screen.getByTestId("documents")).toHaveTextContent("draft.pdf:upload");
    expect(screen.getByTestId("messages")).toBeEmptyDOMElement();
  });

  it("old creation completion cannot release a replacement send reservation or consume its newer draft", async () => {
    const old = deferred<WorkbenchThread>(), next = deferred<WorkbenchThread>();
    mocks.createThread.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await mount(); writeDraft("First draft"); click("Send"); click("Stop"); click("Stop");
    writeDraft("Newer draft"); click("Send");
    expect(mocks.createThread).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(thread("old-empty")));
    expect(chatCalls()).toHaveLength(0); expect(screen.getByTestId("sending")).toHaveTextContent("true");
    click("Send"); // still one pending creation; cannot reserve a duplicate
    expect(mocks.createThread).toHaveBeenCalledTimes(2);
    click("Stop"); await act(async () => next.resolve(thread("next-empty")));
    expect(chatCalls()).toHaveLength(0); expect(screen.getByLabelText("Draft")).toHaveValue("Newer draft");
  });

  it("Stop belongs to the selected draft and does not cancel or adopt another project's pending send", async () => {
    const a = deferred<WorkbenchThread>(), b = deferred<WorkbenchThread>();
    const response = deferred<Response>();
    mocks.createThread.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    mocks.fetch.mockImplementation((url: string) => url === "/api/chat" ? response.promise : Promise.resolve(Response.json({})));
    await mount(); writeDraft("A draft"); click("Send"); click("B"); writeDraft("B draft"); click("Send"); click("Stop");
    await act(async () => { b.resolve(thread("B-empty", "B")); a.resolve(thread("A-live")); });
    await waitFor(() => expect(chatCalls()).toHaveLength(1));
    expect(JSON.parse(chatCalls()[0][1].body)).toMatchObject({ projectId: "A", threadId: "A-live", message: "A draft" });
    expect(screen.getByTestId("selection")).toHaveTextContent("B:new");
    expect(screen.getByLabelText("Draft")).toHaveValue("B draft");
    await act(async () => response.resolve(new Response(`${JSON.stringify({ type: "done" })}\n`)));
  });

  it("handoff retains exact Stop identity and requires a real server terminal after a rejected control", async () => {
    const creation = deferred<WorkbenchThread>(), response = deferred<Response>(), control = deferred<Response>();
    mocks.createThread.mockReturnValueOnce(creation.promise);
    mocks.fetch.mockImplementation((url: string) => url === "/api/chat" ? response.promise : url === "/api/runtime/turns/control" ? control.promise : Promise.resolve(Response.json({})));
    await mount(); writeDraft(); click("Send");
    await act(async () => creation.resolve(thread("admitted")));
    await waitFor(() => expect(chatCalls()).toHaveLength(1));
    click("Stop"); click("Stop");
    await waitFor(() => expect(controlCalls()).toHaveLength(1));
    expect(screen.getByTestId("messages")).toHaveTextContent("assistant:streaming");
    expect(chatCalls()[0][1].signal.aborted).toBe(false);
    await act(async () => control.resolve(Response.json({ error: "not admitted" }, { status: 409 })));
    expect(screen.getByTestId("messages")).toHaveTextContent("assistant:streaming");
    await act(async () => response.resolve(new Response(`${JSON.stringify({ type: "stopped" })}\n`)));
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("assistant:stopped"));
    const identities = controlCalls().map(([, init]) => JSON.parse(init.body));
    expect(identities).toHaveLength(2); expect(identities[1]).toEqual(identities[0]);
    expect(identities[0]).toMatchObject({ threadId: "admitted", assistantMessageId: JSON.parse(chatCalls()[0][1].body).assistantMessageId });
    expect(chatCalls()).toHaveLength(1);
  });

  it.each([false, true])("a missing pre-admission projection is provisional; definitive missing after admission stays visible (%s)", async definitiveMissing => {
    const response = deferred<Response>();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    mocks.createThread.mockResolvedValueOnce(thread("late-projection"));
    const missing = () => Response.json({ error: "El torn no existeix.", code: "TURN_PROJECTION_NOT_FOUND" }, { status: 404 });
    let controls = 0;
    mocks.fetch.mockImplementation((url: string) => url === "/api/chat" ? response.promise
      : url === "/api/runtime/turns/control" ? Promise.resolve(++controls === 1 || definitiveMissing
        ? missing() : Response.json({ ok: true, action: "stop", idempotent: false }))
      : Promise.resolve(Response.json({})));
    await mount(); writeDraft(); click("Send");
    await waitFor(() => expect(chatCalls()).toHaveLength(1));
    click("Stop");
    await waitFor(() => expect(controlCalls()).toHaveLength(1));
    // A control 404 cannot confirm a stop or end the still-unconfirmed submission.
    expect(screen.getByTestId("messages")).toHaveTextContent("assistant:streaming");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(chatCalls()[0][1].signal.aborted).toBe(false);
    await act(async () => response.resolve(new Response(body)));
    await waitFor(() => expect(controlCalls()).toHaveLength(2));
    expect(JSON.parse(controlCalls()[1][1].body)).toEqual(JSON.parse(controlCalls()[0][1].body));
    expect(screen.getByTestId("messages")).toHaveTextContent("assistant:streaming");
    if (definitiveMissing) await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("El torn no existeix."));
    else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "stopped" })}\n`)); stream.close(); });
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("assistant:stopped"));
    expect(chatCalls()).toHaveLength(1);
    if (!definitiveMissing) expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([401, 403, 404])("a pre-admission control failure without the exact projection code remains visible (HTTP %s)", async status => {
    const response = deferred<Response>();
    mocks.createThread.mockResolvedValueOnce(thread("rejected-control"));
    mocks.fetch.mockImplementation((url: string) => url === "/api/chat" ? response.promise
      : url === "/api/runtime/turns/control" ? Promise.resolve(Response.json({ error: "Definitive control rejection", ...(status !== 404 ? { code: "TURN_PROJECTION_NOT_FOUND" } : {}) }, { status }))
      : Promise.resolve(Response.json({})));
    await mount(); writeDraft(); click("Send");
    await waitFor(() => expect(chatCalls()).toHaveLength(1)); click("Stop");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Definitive control rejection"));
    expect(screen.getByTestId("messages")).toHaveTextContent("assistant:streaming");
    await act(async () => response.resolve(new Response(`${JSON.stringify({ type: "done" })}\n`)));
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("assistant:complete"));
  });

  it("an admitted turn releases its new-draft slot and Stop on another new draft cannot target it", async () => {
    const first = deferred<WorkbenchThread>(), second = deferred<WorkbenchThread>(), response = deferred<Response>();
    mocks.createThread.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mocks.fetch.mockImplementation((url: string) => url === "/api/chat" ? response.promise : Promise.resolve(Response.json({})));
    await mount(); writeDraft("First turn"); click("Send");
    await act(async () => first.resolve(thread("first-live")));
    await waitFor(() => expect(chatCalls()).toHaveLength(1));
    click("A");
    expect(screen.getByTestId("selection")).toHaveTextContent("A:new");
    expect(screen.getByTestId("sending")).toHaveTextContent("false");
    click("Stop"); expect(controlCalls()).toHaveLength(0);
    writeDraft("Another draft"); click("Send");
    expect(mocks.createThread).toHaveBeenCalledTimes(2);
    await act(async () => response.resolve(new Response(`${JSON.stringify({ type: "done" })}\n`)));
    await waitFor(() => expect(screen.getByTestId("history")).toHaveTextContent("first-live:2:complete"));
    expect(screen.getByTestId("sending")).toHaveTextContent("true");
    click("Stop"); await act(async () => second.resolve(thread("second-empty")));
    expect(chatCalls()).toHaveLength(1); expect(controlCalls()).toHaveLength(0);
    expect(chatCalls()[0][1].signal.aborted).toBe(false);
    expect(screen.getByLabelText("Draft")).toHaveValue("Another draft");
  });

  it("unmounting before creation resolves cannot submit a detached draft", async () => {
    const creation = deferred<WorkbenchThread>(); mocks.createThread.mockReturnValueOnce(creation.promise);
    const view = await mount(); writeDraft(); click("Send"); view.unmount();
    await act(async () => creation.resolve(thread("detached-empty")));
    expect(chatCalls()).toHaveLength(0);
  });
});

it.each(["stopped", "complete", "error"] as const)("lost Stop transport reconciles authoritative %s without a false connection notice", async status => {
  const ownProject = project("11111111-1111-4111-8111-111111111111");
  const ownThread = thread("22222222-2222-4222-8222-222222222222", ownProject.id);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  mocks.createThread.mockResolvedValueOnce(ownThread);
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url === "/api/chat") return new Response(body);
    if (url === "/api/runtime/turns/control") throw new Error("Synthetic lost control response");
    if (url === `/api/threads/${ownThread.id}`) {
      const request = JSON.parse(chatCalls()[0][1].body);
      return Response.json({ thread: { ...ownThread, messages: [{ id: request.assistantMessageId, role: "assistant", content: status === "error" ? "Actual server failure" : "", status,
        createdAt: ownThread.createdAt, activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [] }] } });
    }
    return Response.json({});
  });
  await mount({ savedProjectId: ownProject.id, visibleProjects: [ownProject] }); writeDraft(); click("Send");
  await waitFor(() => expect(chatCalls()).toHaveLength(1)); click("Stop");
  await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent(`assistant:${status}`));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(mocks.fetch.mock.calls.filter(([url]) => url === `/api/threads/${ownThread.id}`)).toHaveLength(1);
  expect(chatCalls()).toHaveLength(1); expect(chatCalls()[0][1].signal.aborted).toBe(false);
  await act(async () => { stream.close(); });
});

it("lost Stop transport keeps an unavailable terminal visibly unconfirmed and does not abort the real turn", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  mocks.createThread.mockResolvedValueOnce(thread("still-running"));
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url === "/api/chat") return new Response(body);
    if (url === "/api/runtime/turns/control") throw new Error("Synthetic lost control response");
    return Response.json({ error: "Snapshot unavailable" }, { status: 503 });
  });
  await mount(); writeDraft(); click("Send");
  await waitFor(() => expect(chatCalls()).toHaveLength(1)); click("Stop");
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.getByTestId("messages")).toHaveTextContent("assistant:streaming");
  expect(chatCalls()[0][1].signal.aborted).toBe(false); expect(chatCalls()).toHaveLength(1);
  await act(async () => { stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "stopped" })}\n`)); stream.close(); });
});
