// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import type { ComponentProps } from "react";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <span data-testid="thinking-orb" /> }));
import { ChatWorkspace } from "@/components/chat-workspace";
import { baseBrainManifest, type BrainPreferences } from "@/config/brain";
import type { ChatMessage } from "@/lib/chat-contract";
import { initialRuntimeStatus } from "@/lib/runtime-status";
import { workbenchThreadAccess, type WorkbenchProject, type WorkbenchThread } from "@/workbench/types";

const project: WorkbenchProject = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Operaciones Arnall",
  slug: "operaciones-arnall",
  status: "active",
  pinned: false,
  instructions: "",
  sources: [],
  memory: { enabled: true, notes: "", updatedAt: null },
  sharing: { visibility: "private", members: [] },
  workspace: { id: "workspace-1", label: "Principal", hostType: "managed", status: "ready", isPrimary: true },
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

const preferences: BrainPreferences = {
  assistantName: "Arnall AI",
  tone: "balanced",
  accent: "blue",
  density: "comfortable",
  corners: "soft",
  showInspector: true,
  showActivityPanel: true,
  conversationMemory: true,
};

function assistantMessage(): ChatMessage {
  return {
    id: "message-1",
    role: "assistant",
    content: "La información está lista.",
    createdAt: "2026-08-28T00:00:00.000Z",
    status: "complete",
    plan: [],
    activity: [],
    approvals: [{
      id: "approval-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      kind: "command",
      title: "Confirmar cambio sensible",
      detail: "La acción requiere permiso.",
      command: "apply-safe-change",
      cwd: "/workspace",
      status: "pending",
    }],
    diff: "",
    attachments: [],
    artifacts: [],
  };
}

function renderWorkspace(
  thread: WorkbenchThread | null = null,
  activeProject: WorkbenchProject | null = project,
  overrides: Partial<ComponentProps<typeof ChatWorkspace>> = {},
) {
  const {
    prompt: initialPrompt = "",
    hydrated: initialHydrated = true,
    onPromptChange = vi.fn(),
    ...remainingOverrides
  } = overrides;
  let finishHydration: () => void = () => undefined;
  let updateProps: (next: typeof overrides) => void = () => undefined;
  function ControlledWorkspace() {
    const [updatedProps, setUpdatedProps] = useState<typeof overrides>({});
    updateProps = setUpdatedProps;
    const [prompt, setPrompt] = useState(initialPrompt);
    const [hydrated, setHydrated] = useState(initialHydrated);
    finishHydration = () => setHydrated(true);
    return <ChatWorkspace
    manifest={baseBrainManifest}
    preferences={preferences}
    project={activeProject}
    thread={thread}
    projects={[project]}
    userName="Ada"
    companyName="Arnall"
    assistantName="Arnall AI"
    hydrated={hydrated}
    prompt={prompt}
    composerExperience="smart"
    imageGeneration={false}
    connectorMentions={[]}
    selectedConnectorMentionIds={[]}
    attachments={[]}
    documents={[]}
    publications={[]}
    documentUploading={false}
    sending={false}
    stopping={false}
    queuedMessages={[]}
    runtimeStatus={{ ...initialRuntimeStatus, mode: "demo", codex: "disabled", ready: true }}
    networkOnline
    streamRecovery={null}
    onRetryRuntime={vi.fn()}
    onPromptChange={(value) => {
      setPrompt(value);
      onPromptChange(value);
    }}
    onComposerExperienceChange={vi.fn()}
    onImageGenerationChange={vi.fn()}
    onDestinationChange={vi.fn()}
    onConnectorMentionIdsChange={vi.fn()}
    onAttachmentsChange={vi.fn()}
    onDocumentsChange={vi.fn()}
    onAddDocuments={vi.fn(async () => undefined)}
    onFreezePublication={vi.fn(async () => undefined)}
    onDecidePublication={vi.fn(async () => undefined)}
    onComposerNotice={vi.fn()}
    onSend={vi.fn()}
    onStop={vi.fn()}
    onCancelQueuedMessage={vi.fn()}
    sidebarOpen
    onToggleSidebar={vi.fn()}
    onResolveApproval={vi.fn(async () => undefined)}
    onEditMessage={vi.fn()}
    managedAppActionEnabled={false}
    managedAppApprovalKeys={[]}
    onManagedAppPrepared={vi.fn()}
    onPreviewDocument={vi.fn()}
    onOpenReview={vi.fn()}
    {...remainingOverrides}
    {...updatedProps}
  />;
  }
  return { ...render(<ControlledWorkspace />), finishHydration, updateProps: (next: typeof overrides) => updateProps(next) };
}

afterEach(cleanup);

afterAll(() => vi.unstubAllGlobals());

beforeAll(() => {
  // jsdom has no layout observer. Actual scroll following is verified in
  // conversation.spec.ts with Chromium; keep the hook active in these tests.
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: vi.fn(), configurable: true });
});

describe("chat workspace simplificado", () => {
  it("places response sources after copy in the same footer and keeps them expandable", () => {
    const message: ChatMessage = { ...assistantMessage(), sources: [{ id: "app-source", kind: "app", title: "Referencia de la aplicación", url: null, domain: null, snippet: "Dato observado", publishedAt: null }], approvals: [] };
    const thread: WorkbenchThread = { id: "thread-sources", projectId: project.id, title: "Fuentes", status: "active", pinned: false, createdAt: message.createdAt, updatedAt: message.createdAt, messages: [message] };
    renderWorkspace(thread);
    const copy = screen.getByRole("button", { name: /^Copiar$/ });
    const sources = screen.getByRole("region", { name: "Fuentes de la respuesta" });
    expect(copy.parentElement).toBe(sources.parentElement);
    expect(copy.nextElementSibling).toBe(sources);
    const details = sources.querySelector("details")!;
    fireEvent.click(sources.querySelector("summary")!);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("Referencia de la aplicación")).toBeVisible();
  });

  it("edits a long request in its original bubble width and grows instead of scrolling", () => {
    const request: ChatMessage = { ...assistantMessage(), id: "editable-request", role: "user", content: Array.from({ length: 16 }, (_, i) => `Línea ${i}: revisar el informe completo.`).join("\n"), approvals: [] };
    const thread: WorkbenchThread = { id: "thread-edit", projectId: project.id, title: "Editar", status: "active", pinned: false, createdAt: request.createdAt, updatedAt: request.createdAt, messages: [request] };
    const onEditMessage = vi.fn();
    renderWorkspace(thread, project, { onEditMessage });
    const bubble = screen.getByText(/Línea 0: revisar el informe completo/).closest(".user-message-bubble")!;
    const container = bubble.parentElement!;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ width: 480 } as DOMRect);
    fireEvent.click(screen.getByRole("button", { name: "Editar mensaje y crear una rama" }));
    const editor = screen.getByRole("textbox", { name: "Editar mensaje" });
    expect(container).toHaveStyle({ width: "480px" });
    expect(editor.closest(".user-message-bubble")).toBe(bubble);
    expect(editor).toHaveValue(request.content);
    Object.defineProperty(editor, "scrollHeight", { configurable: true, value: 620 });
    fireEvent.change(editor, { target: { value: request.content + "\nOtra línea." } });
    expect(editor).toHaveStyle({ height: "620px" });
    expect(onEditMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Cancelar$/ }));
    expect(screen.queryByRole("textbox", { name: "Editar mensaje" })).not.toBeInTheDocument();
    expect(screen.getByText(/Línea 0: revisar el informe completo/)).toBeInTheDocument();
    expect(container.style.width).toBe("");
    expect(onEditMessage).not.toHaveBeenCalled();
  });

  it("shows a result from an unshared project without an editable composer or a misleading runtime error", () => {
    const thread: WorkbenchThread = { id: "thread-1", projectId: "private-owner-project", title: "Programada · Factures",
      status: "active", pinned: false, createdAt: project.createdAt, updatedAt: project.updatedAt,
      messages: [assistantMessage()], access: { role: "viewer", canEdit: false, canManage: false } };
    renderWorkspace(thread, null, { readOnly: !workbenchThreadAccess(thread, null).canEdit,
      runtimeStatus: { ...initialRuntimeStatus, mode: "codex", ready: false, codex: "unavailable" } });
    expect(screen.getByText("La información está lista.")).toBeInTheDocument();
    expect(screen.getByText("Conversación de solo lectura · puedes consultar el historial y los archivos compartidos.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Mensaje" })).not.toBeInTheDocument();
    expect(screen.queryByText("El servicio no está disponible. Puedes revisar el historial.")).not.toBeInTheDocument();
  });
  it("explains required AI sign-in while preserving the draft and keeping Send disabled", () => {
    const onSend = vi.fn();
    renderWorkspace(null, project, { prompt: "Consulta mi correo", onSend,
      runtimeStatus: { ...initialRuntimeStatus, mode: "codex", codex: "unavailable", ready: false, authenticationRequired: true } });
    expect(screen.getByRole("alert")).toHaveTextContent("Necesitas iniciar sesión en tu cuenta de IA para continuar. Puedes revisar el historial.");
    expect(screen.queryByText("El servicio no está disponible. Puedes revisar el historial.")).not.toBeInTheDocument();
    const editor = screen.getByRole("textbox", { name: "Mensaje" });
    expect(editor).toHaveValue("Consulta mi correo");
    expect(screen.getByRole("button", { name: "Enviar mensaje" })).toBeDisabled();
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
  it("shows transient conversation loading and prevents edits/send/files without a read-only permission claim", async () => {
    const onSend = vi.fn(), onAddDocuments = vi.fn(async () => undefined), onPromptChange = vi.fn();
    const view = renderWorkspace(null, project, { prompt: "Preserve draft", selectionLoading: true, onSend, onAddDocuments, onPromptChange,
      runtimeStatus: { ...initialRuntimeStatus, mode: "codex", codex: "connected", ready: true } });
    const editor = screen.getByRole("textbox", { name: "Mensaje" });
    expect(editor).toBeDisabled(); expect(screen.getByRole("button", { name: "Enviar mensaje" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Añadir al mensaje" })).toBeDisabled();
    expect(screen.getByText("Abriendo conversación…")).toBeInTheDocument();
    expect(screen.queryByText(/Conversación de solo lectura/)).not.toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "Wrong draft" } }); fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    fireEvent.drop(view.container.querySelector("main")!, { dataTransfer: { files: [new File(["synthetic"], "file.pdf", { type: "application/pdf" })], types: ["Files"] } });
    expect(onSend).not.toHaveBeenCalled(); expect(onAddDocuments).not.toHaveBeenCalled(); expect(onPromptChange).not.toHaveBeenCalled();
  });

  it("stages dropped and pasted files in the current draft without sending or publishing", async () => {
    const onAddDocuments = vi.fn(async () => undefined);
    const onSend = vi.fn();
    const onRequestPublication = vi.fn();
    renderWorkspace(null, project, { prompt: "Keep this draft", onAddDocuments, onSend, onRequestPublication,
      runtimeStatus: { ...initialRuntimeStatus, mode: "codex", codex: "connected", ready: true } });
    const png = new File(["synthetic image bytes"], "image.png", { type: "image/png" });
    const pdf = new File(["synthetic pdf bytes"], "notes.pdf", { type: "application/pdf" });
    fireEvent.drop(screen.getByRole("main"), { dataTransfer: {
      types: ["Files"],
      files: [png, pdf],
      // macOS Finder can leave protected item handles unreadable while the
      // drop FileList is valid. This is the native shape that regressed.
      items: [
        { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => null },
        { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => null },
      ],
    } });
    await waitFor(() => expect(onAddDocuments).toHaveBeenCalledWith([png, pdf]));
    expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Keep this draft");
    expect(onSend).not.toHaveBeenCalled();
    expect(onRequestPublication).not.toHaveBeenCalled();
    expect(screen.queryByText("Destino oficial")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Preparando adjuntos…")).toBeNull());
    fireEvent.paste(screen.getByRole("textbox", { name: "Mensaje" }), { clipboardData: { files: [png] } });
    await waitFor(() => expect(onAddDocuments).toHaveBeenCalledTimes(2));
    expect(onAddDocuments).toHaveBeenLastCalledWith([png]);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Keep this draft");
  });

  it("reads screenshot clipboard file items when FileList is empty and leaves ordinary text paste untouched", async () => {
    const onAddDocuments = vi.fn(async () => undefined);
    renderWorkspace(null, project, { prompt: "Keep this draft", onAddDocuments,
      runtimeStatus: { ...initialRuntimeStatus, mode: "codex", codex: "connected", ready: true } });
    const png = new File(["screenshot bytes"], "image.png", { type: "image/png" });
    const editor = screen.getByRole("textbox", { name: "Mensaje" });
    expect(fireEvent.paste(editor, { clipboardData: { files: [], items: [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => png },
    ] } })).toBe(false);
    await waitFor(() => expect(onAddDocuments).toHaveBeenCalledWith([png]));
    await waitFor(() => expect(screen.queryByText("Preparando adjuntos…")).toBeNull());
    expect(fireEvent.paste(editor, { clipboardData: { files: [], items: [
      { kind: "string", getAsFile: () => null },
    ] } })).toBe(true);
    expect(onAddDocuments).toHaveBeenCalledTimes(1);
    expect(editor).toHaveValue("Keep this draft");
  });

  it("offers original voice-note controls directly on a saved user attachment", () => {
    const onRequestPublication = vi.fn();
    const attachment = { id: "00000000-0000-4000-8000-000000000019", name: "voice.ogg", mimeType: "audio/ogg", size: 125139 };
    renderWorkspace({ id: "00000000-0000-4000-8000-000000000020", projectId: project.id, title: "Voice notes", status: "active", pinned: false,
      createdAt: project.createdAt, updatedAt: project.updatedAt,
      messages: [{ ...assistantMessage(), id: "user-1", role: "user", content: "Read this", attachments: [attachment], approvals: [] }, assistantMessage()],
    }, project, { onRequestPublication });
    expect(screen.getByRole("button", { name: "Ver audio voice.ogg" })).toBeInTheDocument();
    expect(onRequestPublication).not.toHaveBeenCalled();
  });

  it("offers publication only after a deliberate action on a sent attachment", () => {
    const onRequestPublication = vi.fn();
    const attachment = { id: "00000000-0000-4000-8000-000000000019", name: "notes.pdf", mimeType: "application/pdf", size: 128 };
    renderWorkspace({ id: "thread-1", projectId: project.id, title: "Private files", status: "active", pinned: false,
      createdAt: project.createdAt, updatedAt: project.updatedAt,
      messages: [{ ...assistantMessage(), id: "user-1", role: "user", content: "Read this", attachments: [attachment], approvals: [] }, assistantMessage()],
    }, project, { onRequestPublication });
    expect(onRequestPublication).not.toHaveBeenCalled();
    expect(screen.queryByText("Destino oficial")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preparar publicación de notes.pdf" }));
    expect(onRequestPublication).toHaveBeenCalledExactlyOnceWith(attachment, "message-1");
  });

  it("rejects dropped directories and ignores normal text drags", () => {
    const onAddDocuments = vi.fn(async () => undefined);
    const onComposerNotice = vi.fn();
    renderWorkspace(null, project, { onAddDocuments, onComposerNotice,
      runtimeStatus: { ...initialRuntimeStatus, mode: "codex", codex: "connected", ready: true } });
    fireEvent.dragEnter(screen.getByRole("main"), { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(screen.queryByText("Suelta los archivos para adjuntarlos")).toBeNull();
    fireEvent.drop(screen.getByRole("main"), { dataTransfer: { types: ["Files"], files: [], items: [
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => null },
    ] } });
    expect(onComposerNotice).toHaveBeenCalledWith(expect.stringContaining("carpetas"));
    expect(onAddDocuments).not.toHaveBeenCalled();
  });

  it("renders the final answer as rich Markdown once and outside collapsed work activity", () => {
    const message: ChatMessage = {
      ...assistantMessage(),
      content: "## Informe final\n\n- Evidencia verificada\n- Próximo paso",
      durationMs: 3_000,
      approvals: [],
      activity: [{
        id: "commentary-1",
        kind: "reasoning",
        label: "Actualización de trabajo",
        detail: "He comprobado la fuente autorizada.",
        status: "complete",
      }],
    };
    renderWorkspace({
      id: "thread-1",
      projectId: project.id,
      title: "Informe",
      status: "active",
      pinned: false,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:03.000Z",
      messages: [message],
    });

    const activityTrigger = screen.getByRole("button", { name: "Mostrar el proceso de trabajo" });
    expect(activityTrigger).toHaveAttribute("aria-expanded", "false");
    expect(activityTrigger).toHaveTextContent("Ha trabajado durante 0m 3s");
    expect(screen.getAllByRole("heading", { name: "Informe final" })).toHaveLength(1);
    expect(screen.getByText("Evidencia verificada").closest("li")).toBeInTheDocument();
    expect(screen.getByText("He comprobado la fuente autorizada.")).not.toBeVisible();
    expect(screen.getByRole("heading", { name: "Informe final" }).closest(".markdown-body")?.parentElement).toHaveClass("text-[length:var(--font-chat-message)]", "leading-[1.75]");
    expect(screen.getByTestId("composer")).toHaveAttribute("data-layout", "conversation");
    expect(screen.getByTestId("composer")).toHaveClass("composer-compact");
    expect(screen.getByTestId("composer")).toHaveAttribute("data-focused", "false");
    fireEvent.focus(screen.getByRole("textbox", { name: "Mensaje" }));
    expect(screen.getByTestId("composer")).toHaveAttribute("data-focused", "true");
    expect(screen.getByTestId("composer")).toHaveClass("composer-focused");
    fireEvent.blur(screen.getByRole("textbox", { name: "Mensaje" }), { relatedTarget: null });
    expect(screen.getByTestId("composer")).toHaveAttribute("data-focused", "false");
  });

  it("opens the review surface for the exact completed message", () => {
    const onOpenReview = vi.fn();
    const message = { ...assistantMessage(), diff: "diff --git a/a.txt b/a.txt\n+a" };
    renderWorkspace({
      id: "thread-review",
      projectId: project.id,
      title: "Revisión",
      status: "active",
      pinned: false,
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      messages: [message],
    }, project, { onOpenReview });

    fireEvent.click(screen.getByRole("button", { name: "Abrir cambios y resultados" }));
    expect(onOpenReview).toHaveBeenCalledWith(message.id);
  });

  it("adopts a draft typed before hydration instead of resetting it", () => {
    const onPromptChange = vi.fn();
    const { finishHydration } = renderWorkspace(null, project, {
      hydrated: false,
      onPromptChange,
    });
    const composer = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    composer.value = "Borrador escrito durante la carga";
    act(() => finishHydration());

    expect(composer).toHaveValue("Borrador escrito durante la carga");
    expect(onPromptChange).toHaveBeenLastCalledWith("Borrador escrito durante la carga");
  });

  it("anchors Tools below its trigger and returns keyboard focus there", async () => {
    renderWorkspace(null, null, {
      connectorMentions: [{ id: "gmail", label: "Gmail", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: true }],
    });
    const trigger = screen.getByRole("button", { name: "Conexiones" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ left: 120, right: 180, top: 200, bottom: 244, width: 60, height: 44, x: 120, y: 200, toJSON: () => ({}) });
    fireEvent.click(trigger);
    const popup = screen.getByRole("listbox", { name: "Catálogo de conectores" }).parentElement!;
    expect(popup.style.top).toBe("250px");
    expect(popup.style.left).toBe("120px");
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Catálogo de conectores" }), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("listbox", { name: "Catálogo de conectores" })).not.toBeInTheDocument();
  });

  it("keeps a short-screen Tools fallback clear of the writing area", () => {
    renderWorkspace(null, null, {
      connectorMentions: [{ id: "gmail", label: "Gmail", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: true }],
    });
    const rect = (top: number, height: number) => ({ left: 120, right: 180, top, bottom: top + height, width: 60, height, x: 120, y: top, toJSON: () => ({}) });
    const trigger = screen.getByRole("button", { name: "Conexiones" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(window.innerHeight - 44, 44));
    vi.spyOn(screen.getByTestId("composer"), "getBoundingClientRect").mockReturnValue(rect(200, 120));
    fireEvent.click(trigger);
    const popup = screen.getByRole("listbox", { name: "Catálogo de conectores" }).parentElement!;
    expect(popup.style.top).toBe("194px");
    expect(popup.style.transform).toBe("translateY(-100%)");
    expect(popup.style.maxHeight).toBe("184px");
  });

  it("shows only the authorized connector autocomplete and binds a selected @ source", () => {
    const onPromptChange = vi.fn();
    const onConnectorMentionIdsChange = vi.fn();
    renderWorkspace(null, project, {
      connectorMentions: [
        { id: "gmail", label: "Gmail", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: true },
        { id: "outlook", label: "Outlook", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: false },
        { id: "executive-crm", label: "CRM Ejecutivo", kind: "connector", status: "requires_login", statusCode: "CONNECTOR_LOGIN_REQUIRED", canRead: false, requiresApprovalForWrites: false },
      ],
      onPromptChange,
      onConnectorMentionIdsChange,
    });
    const composer = screen.getByLabelText("Mensaje");
    fireEvent.change(composer, { target: { value: "Busca @" } });
    expect(screen.getByRole("listbox", { name: "Conectores disponibles" })).toHaveTextContent("Gmail");
    expect(screen.getByRole("listbox", { name: "Conectores disponibles" })).toHaveTextContent("Outlook");
    expect(screen.getByRole("option", { name: /CRM Ejecutivo/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("option", { name: /Gmail/ }));
    expect(onConnectorMentionIdsChange).toHaveBeenCalledWith(["gmail"]);
    expect(onPromptChange).toHaveBeenLastCalledWith("Busca @Gmail ");
  });

  it("moves through connector suggestions before selecting the active option", () => {
    const onPromptChange = vi.fn();
    const onConnectorMentionIdsChange = vi.fn();
    renderWorkspace(null, project, {
      connectorMentions: [
        { id: "gmail", label: "Gmail", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: true },
        { id: "outlook", label: "Outlook", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: false },
      ],
      onPromptChange,
      onConnectorMentionIdsChange,
    });
    const composer = screen.getByRole("textbox", { name: "Mensaje" });
    fireEvent.change(composer, { target: { value: "Busca @" } });
    const gmail = screen.getByRole("option", { name: /Gmail/ });
    const outlook = screen.getByRole("option", { name: /Outlook/ });
    expect(gmail).toHaveAttribute("aria-selected", "true");
    expect(composer).toHaveAttribute("aria-activedescendant", gmail.id);

    fireEvent.keyDown(composer, { key: "ArrowDown" });
    expect(outlook).toHaveAttribute("aria-selected", "true");
    expect(composer).toHaveAttribute("aria-activedescendant", outlook.id);
    expect(fireEvent.keyDown(composer, { key: "Home" })).toBe(true);
    expect(outlook).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(onConnectorMentionIdsChange).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onConnectorMentionIdsChange).toHaveBeenCalledWith(["outlook"]);
    expect(onPromptChange).toHaveBeenLastCalledWith("Busca @Outlook ");
  });

  it("keeps connector option ids collision-free and leaves caret arrows native without results", () => {
    renderWorkspace(null, project, {
      connectorMentions: [
        { id: "mail.work", label: "Correo punto", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: false },
        { id: "mail:work", label: "Correo dos puntos", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: false },
        { id: "mail-work", label: "Correo guion", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: false },
      ],
    });
    const composer = screen.getByRole("textbox", { name: "Mensaje" });
    fireEvent.change(composer, { target: { value: "Busca @" } });
    const ids = screen.getAllByRole("option").map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);

    fireEvent.change(composer, { target: { value: "Busca @sin-coincidencias" } });
    expect(screen.getByRole("listbox", { name: "Conectores disponibles" })).toHaveTextContent("No hay conectores");
    expect(fireEvent.keyDown(composer, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: "ArrowUp" })).toBe(true);
    fireEvent.blur(composer, { relatedTarget: screen.getByRole("button", { name: "Añadir al mensaje" }) });
    expect(screen.queryByRole("listbox", { name: "Conectores disponibles" })).not.toBeInTheDocument();
  });

  it("keeps the landing focused on its editable destination and honest suggestions", async () => {
    renderWorkspace();

    expect(screen.getByTestId("composer")).toHaveAttribute("data-layout", "landing");
    expect(screen.getByTestId("composer")).toHaveClass("composer-landing");
    expect(screen.getByTestId("composer")).not.toHaveClass("composer-compact");
    expect(screen.getByTestId("composer-controls")).toContainElement(screen.getByRole("button", { name: "Añadir al mensaje" }));
    expect(screen.getAllByText("Operaciones Arnall").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "¿En qué te puedo ayudar, Ada?" })).toBeInTheDocument();
    expect(screen.getByLabelText("Destino de la conversación")).toHaveTextContent("Operaciones Arnall");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveFocus());
    expect(screen.queryByText("Trabajar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resumir documentos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Comparar opciones" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Organizar los próximos pasos" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Trabajemos en los horarios/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("project-breadcrumb")).toHaveTextContent("Operaciones Arnall");
    expect(screen.queryByRole("button", { name: /Abrir contexto/ })).not.toBeInTheDocument();
    for (const removed of ["Analizar información", "Crear un documento", "Resumir contenido", "Comprueba los datos importantes antes de usarlos.", "Planificar", "Preguntar", "↵ enviar"]) {
      expect(screen.queryByText(removed, { exact: false })).not.toBeInTheDocument();
    }
    expect(screen.queryByLabelText("Abrir preferencias")).not.toBeInTheDocument();
  });

  it("uses only the employee's first name on a standalone landing", () => {
    renderWorkspace(null, null, { userName: "David Liria" });

    expect(screen.getByRole("heading", { name: "¿En qué te puedo ayudar, David?" })).toBeInTheDocument();
    expect(screen.queryByText("David Liria", { exact: true })).not.toBeInTheDocument();
  });

  it("greets the authenticated employee while keeping a shared project's owner in its context", () => {
    renderWorkspace(null, { ...project, name: "Qualitat · Rafa" }, { userName: "Jordi Hernandez", installationId: "g03-production" });
    expect(screen.getByRole("heading", { name: "¿En qué te puedo ayudar, Jordi?" })).toBeInTheDocument();
    expect(screen.getByTestId("project-breadcrumb")).toHaveTextContent("Qualitat · Rafa");
    expect(screen.getByLabelText("Destino de la conversación")).toHaveTextContent("Qualitat · Rafa");
  });

  it("keeps the add menu limited to files and authorized connectors", async () => {
    renderWorkspace(null, project, {
      runtimeStatus: { ...initialRuntimeStatus, mode: "codex", codex: "connected", ready: true },
      connectorMentions: [
        { id: "gmail", label: "Gmail", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: true },
        { id: "outlook", label: "Outlook", kind: "connector", status: "requires_login", statusCode: "OUTLOOK_LOGIN_REQUIRED", canRead: false, requiresApprovalForWrites: false },
      ],
    });

    const add = screen.getByRole("button", { name: "Añadir al mensaje" });
    fireEvent.click(add);
    expect(screen.getByRole("menuitem", { name: "Adjuntar archivos" })).toBeInTheDocument();
    expect(screen.getByLabelText("Seleccionar archivos para adjuntar")).toHaveAttribute("tabindex", "-1");
    expect(screen.queryByRole("menuitem", { name: "Añadir carpeta" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Seleccionar archivos para adjuntar")).not.toHaveAttribute("webkitdirectory");
    expect(screen.getByLabelText("Seleccionar archivos para adjuntar")).not.toHaveAttribute("directory");
    expect(screen.getByRole("menuitem", { name: "Conexiones" })).toBeInTheDocument();
    for (const removed of ["Acciones guiadas", "Buscar en la web", "Crear imagen", "Desactivar búsqueda web"]) {
      expect(screen.queryByText(removed, { exact: false })).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("menuitem", { name: "Conexiones" }));
    const catalog = screen.getByRole("listbox", { name: "Catálogo de conectores" });
    expect(catalog).toHaveTextContent("Gmail");
    expect(catalog).toHaveTextContent("Outlook");
    expect(screen.getByRole("option", { name: /Outlook/ })).toBeDisabled();
    await waitFor(() => expect(catalog).toHaveFocus());
    fireEvent.keyDown(catalog, { key: "Tab" });
    await waitFor(() => expect(add).toHaveFocus());
    expect(screen.queryByRole("listbox", { name: "Catálogo de conectores" })).not.toBeInTheDocument();
    fireEvent.click(add);
    expect(screen.getByRole("menu", { name: "Añadir al mensaje" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Catálogo de conectores" })).not.toBeInTheDocument();
  });

  it("puts selectable connected tools before the divided connection catalog", () => {
    renderWorkspace(null, project, {
      connectorMentions: [
        { id: "outlook", label: "Outlook", kind: "connector", status: "requires_login", statusCode: "OUTLOOK_LOGIN_REQUIRED", canRead: false, connectUrl: "/api/connectors/outlook/oauth/start", requiresApprovalForWrites: false },
        { id: "gmail", label: "Gmail", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: false },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Conexiones" }));
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Gmail");
    expect(options[0]).toBeEnabled();
    expect(options[1]).toHaveTextContent("Outlook");
    expect(options[1]).toHaveClass("border-t");
    const catalog = screen.getByRole("listbox", { name: "Catálogo de conectores" });
    fireEvent.keyDown(catalog, { key: "ArrowDown" });
    expect(catalog).toHaveAttribute("aria-activedescendant", options[1].id);
  });

  it.each(["menu", "landing"])("opens %s connectors immediately and fills the same panel after loading", async (entry) => {
    const onComposerNotice = vi.fn();
    const view = renderWorkspace(null, project, { connectorMentions: [], connectorCatalogStatus: "loading", onComposerNotice });
    if (entry === "menu") {
      fireEvent.click(screen.getByRole("button", { name: "Añadir al mensaje" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Conexiones" }));
    } else fireEvent.click(screen.getByRole("button", { name: "Conexiones" }));
    const catalog = screen.getByRole("listbox", { name: "Catálogo de conectores" });
    expect(catalog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Cargando tus conectores…");
    expect(onComposerNotice).not.toHaveBeenCalled();
    act(() => view.updateProps({ connectorCatalogStatus: "ready", connectorMentions: [{ id: "gmail", label: "Gmail", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: false }] }));
    expect(screen.getByRole("listbox", { name: "Catálogo de conectores" })).toBe(catalog);
    expect(catalog).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("option", { name: /Gmail/ })).toBeVisible();
    expect(screen.queryByText("Cargando tus conectores…")).not.toBeInTheDocument();
  });

  it("keeps a dismissed loading panel closed when the request finishes", () => {
    const view = renderWorkspace(null, project, { connectorCatalogStatus: "loading" });
    fireEvent.click(screen.getByRole("button", { name: "Conexiones" }));
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Catálogo de conectores" }), { key: "Escape" });
    act(() => view.updateProps({ connectorCatalogStatus: "ready" }));
    expect(screen.queryByRole("listbox", { name: "Catálogo de conectores" })).not.toBeInTheDocument();
  });

  it("shows a retry inside the open panel if loading fails", () => {
    const retry = vi.fn();
    const view = renderWorkspace(null, project, { connectorCatalogStatus: "loading", onRetryConnectorCatalog: retry });
    fireEvent.click(screen.getByRole("button", { name: "Conexiones" }));
    act(() => view.updateProps({ connectorCatalogStatus: "error" }));
    expect(screen.getByRole("alert")).toHaveTextContent("No se ha podido cargar el catálogo de conectores.");
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("listbox", { name: "Catálogo de conectores" })).toBeInTheDocument();
  });

  it("shows an empty authorized catalog inside the panel", () => {
    const onComposerNotice = vi.fn();
    renderWorkspace(null, project, { connectorMentions: [], onComposerNotice });
    fireEvent.click(screen.getByRole("button", { name: "Conexiones" }));
    expect(screen.getByRole("listbox", { name: "Catálogo de conectores" })).toHaveTextContent("No hay conectores habilitados en tu catálogo.");
    expect(onComposerNotice).not.toHaveBeenCalled();
  });

  it("submits with Enter while preserving composition and multiline input", () => {
    const onSend = vi.fn();
    renderWorkspace(null, project, { prompt: "Prepara el resum", onSend });
    const prompt = screen.getByRole("textbox", { name: "Mensaje" });

    fireEvent.keyDown(prompt, { key: "Enter", isComposing: true });
    fireEvent.keyDown(prompt, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(prompt, { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("enables governed image generation from the composer and exposes its active state", () => {
    const onImageGenerationChange = vi.fn();
    renderWorkspace(null, project, {
      runtimeStatus: {
        ...initialRuntimeStatus,
        mode: "codex",
        codex: "connected",
        ready: true,
        capabilities: { ...initialRuntimeStatus.capabilities, imageGeneration: true },
      },
      onImageGenerationChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "Añadir al mensaje" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Crear imagen" }));
    expect(onImageGenerationChange).toHaveBeenCalledWith(true);
  });

  it("offers image examples as editable drafts by replacing existing text without sending", () => {
    const onSend = vi.fn();
    renderWorkspace(null, project, { imageGeneration: true, prompt: "Usa mis colores.", onSend });
    expect(screen.getByRole("heading", { name: "¿Qué imagen quieres crear?" })).toBeInTheDocument();
    const composer = screen.getByRole("textbox", { name: "Mensaje" });
    expect(composer).toHaveAttribute("placeholder", "Describe la imagen que quieres crear…");
    expect(screen.queryByText("Prioridades")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Para una presentación/ }));
    expect(composer).toHaveValue("Crea una imagen horizontal para una presentación sobre…");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("fills a normal suggestion for review rather than submitting it", () => {
    const onSend = vi.fn();
    renderWorkspace(null, project, { onSend });
    fireEvent.click(screen.getByRole("button", { name: "Resumir documentos" }));
    expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Ayúdame a resumir estos documentos para Arnall: … Usa solo el material aportado o autorizado, cita las fuentes y destaca decisiones, dudas y datos que faltan.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([
    ["¿Qué campañas tenemos en marcha?", "¿Qué campañas tenemos en marcha?"],
    ["Preparar más leads cualificados", "Prepara 1000 leads cualificados más con la distribución de ICP acordada."],
    ["¿Qué necesita mi atención?", "¿Qué necesita mi atención en outreach hoy?"],
  ])("fills the InsiJets suggestion %s as an editable draft without submitting", (label, expectedContent) => {
    const onSend = vi.fn();
    const onAttachmentsChange = vi.fn();
    const onDestinationChange = vi.fn();
    renderWorkspace(null, project, { installationId: "insijets-demo", companyName: "InsiJets", prompt: "Mi borrador anterior", onSend, onAttachmentsChange, onDestinationChange });
    expect(screen.queryByRole("button", { name: /Trabajemos en los horarios/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: label }));
    const composer = screen.getByRole("textbox", { name: "Mensaje" });
    expect((composer as HTMLTextAreaElement).value).toContain(expectedContent);
    expect(composer).not.toHaveValue("Mi borrador anterior");
    fireEvent.change(composer, { target: { value: "Mi solicitud revisada para InsiJets" } });
    expect(composer).toHaveValue("Mi solicitud revisada para InsiJets");
    expect(onSend).not.toHaveBeenCalled();
    expect(onAttachmentsChange).not.toHaveBeenCalled();
    expect(onDestinationChange).not.toHaveBeenCalled();
  });

  it("replaces drafts with schedule templates without sending or changing attachments and destination", () => {
    const onSend = vi.fn();
    const onAttachmentsChange = vi.fn();
    const onDestinationChange = vi.fn();
    renderWorkspace(null, project, { installationId: "arnall", prompt: "Mi borrador.  ", onSend, onAttachmentsChange, onDestinationChange });
    fireEvent.click(screen.getByRole("button", { name: /Trabajemos en los horarios/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Dame los horarios preparados" }));
    expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Dame los horarios preparados del equipo de Arnall para…");
    expect(onSend).not.toHaveBeenCalled();
    expect(onAttachmentsChange).not.toHaveBeenCalled();
    expect(onDestinationChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Archivos del servidor" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Trabajemos en los horarios/ }));
    expect(screen.getByRole("menuitem", { name: "Revisar cambios de horarios" })).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the plus menu and draft intact without recurring tasks (chat=%s)", (chat) => {
    const onSend = vi.fn();
    const onAttachmentsChange = vi.fn();
    const onDestinationChange = vi.fn();
    const message = assistantMessage();
    const thread: WorkbenchThread | null = chat ? { id: "template-chat", projectId: project.id, title: "Plantillas", status: "active", pinned: false, createdAt: message.createdAt, updatedAt: message.createdAt, messages: [message] } : null;
    renderWorkspace(thread, project, { prompt: "Texto anterior", onSend, onAttachmentsChange, onDestinationChange,
      attachments: [{ id: "attachment", name: "reference.png", mimeType: "image/png", size: 10, dataUrl: "data:image/png;base64,AA==" }] });
    expect(screen.queryByRole("navigation", { name: "Espais de treball" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Añadir al mensaje" }));
    expect(screen.getByRole("menuitem", { name: "Archivos del servidor" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Conexiones" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Adjuntar archivos" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Tareas recurrentes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tareas recurrentes" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Texto anterior");
    expect(screen.getByRole("button", { name: "Quitar reference.png" })).toBeInTheDocument();
    expect(onAttachmentsChange).not.toHaveBeenCalled();
    expect(onDestinationChange).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Añadir al mensaje" })).toBeInTheDocument();
  });

  it("restores a failed request for review without changing the original or sending", async () => {
    const request: ChatMessage = { ...assistantMessage(), id: "request", role: "user", content: "Revisa el informe.", approvals: [] };
    const failure: ChatMessage = { ...assistantMessage(), id: "failure", status: "error", content: "Resultado parcial", approvals: [] };
    const thread: WorkbenchThread = { id: "thread-recovery", projectId: project.id, title: "Recuperar", status: "active", pinned: false, createdAt: request.createdAt, updatedAt: request.createdAt, messages: [request, failure] };
    const onSend = vi.fn();
    renderWorkspace(thread, project, { onSend });
    fireEvent.click(screen.getByRole("button", { name: "Editar solicitud" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue(request.content));
    expect(screen.getByText("Resultado parcial")).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    expect(thread.messages).toEqual([request, failure]);
  });

  it.each(["error", "stopped"] as const)("keeps the saved process accessible after %s with activity preference off", (status) => {
    const failure: ChatMessage = { ...assistantMessage(), status, approvals: [], content: "Resultado parcial", activity: [{ id: "read", kind: "tool", label: "Lectura del documento", status: "complete" }, { id: "host-analysis-outcome", kind: "system", label: "Se ha agotado el tiempo de análisis. El resultado parcial no se ha aceptado.", status: "failed" }] };
    const thread: WorkbenchThread = { id: "failed-process", projectId: project.id, title: "Revisar", status: "active", pinned: false, createdAt: failure.createdAt, updatedAt: failure.createdAt, messages: [failure] };
    renderWorkspace(thread, project, { preferences: { ...preferences, showActivityPanel: false } });
    if (status === "error") expect(screen.getByRole("alert")).toHaveTextContent("Se ha agotado el tiempo de análisis");
    const disclosure = screen.getByRole("button", { name: "Mostrar el proceso de trabajo" });
    fireEvent.click(disclosure);
    expect(screen.getByText("Lectura del documento")).toBeInTheDocument();
    expect(screen.getByText("Resultado parcial")).toBeInTheDocument();
  });

  it("does not discard the current draft when recovering a failed request", async () => {
    const request: ChatMessage = { ...assistantMessage(), id: "request", role: "user", content: "Solicitud anterior", approvals: [] };
    const failure: ChatMessage = { ...assistantMessage(), id: "failure", status: "error", approvals: [] };
    const thread: WorkbenchThread = { id: "thread-recovery", projectId: project.id, title: "Recuperar", status: "active", pinned: false, createdAt: request.createdAt, updatedAt: request.createdAt, messages: [request, failure] };
    const onComposerNotice = vi.fn();
    renderWorkspace(thread, project, { prompt: "Borrador actual", onComposerNotice });
    fireEvent.click(screen.getByRole("button", { name: "Editar solicitud" }));
    expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Borrador actual");
    expect(onComposerNotice).toHaveBeenCalledWith(expect.stringContaining("borrador actual"));
  });

  it("keeps the passive XLS limitation visible when the attachment is ready to send", () => {
    renderWorkspace(null, project, { prompt: "Revisa el Excel.", documents: [{
      id: "passive", uploadId: "passive", threadId: "thread", name: "informe.passive.xlsx",
      size: 2048, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      kind: "xlsx", status: "ready", error: null, pages: 2, previewFiles: [], passive: true,
    }] });
    expect(screen.getByText("Copia pasiva · datos sin verificar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar mensaje" })).toBeEnabled();
  });

  it("blocks button and Enter submission while a recovered attachment is unavailable", () => {
    const onSend = vi.fn();
    renderWorkspace(null, project, { prompt: "Revisa el informe.", onSend, documents: [{ id: "missing", uploadId: "missing", threadId: "thread", name: "informe.pdf", size: 2048, mimeType: "application/pdf", kind: "pdf", status: "error", error: "Vuelve a adjuntar este archivo.", pages: null, previewFiles: [] }] });
    expect(screen.getByRole("button", { name: "Enviar mensaje" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Mensaje" }), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Hay archivos no disponibles");
  });

  it("distinguishes a stored XLS from readable workbook data without blocking the chat", () => {
    renderWorkspace(null, project, { prompt: "Revisa el Excel.", documents: [{
      id: "stored", uploadId: "stored", threadId: "thread", name: "informe.xls",
      size: 300, mimeType: "text/plain", kind: "text", status: "ready", error: null,
      pages: null, previewFiles: [], processingUnavailable: true,
    }] });
    expect(screen.getByText("Original guardado · procesamiento no disponible")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar mensaje" })).toBeEnabled();
  });

  it("queues the next message while keeping stop and cancellation available", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const onCancelQueuedMessage = vi.fn();
    const thread: WorkbenchThread = {
      id: "thread-queue",
      projectId: project.id,
      title: "Cola",
      status: "active",
      pinned: false,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:01.000Z",
      messages: [
        { ...assistantMessage(), id: "user-running", role: "user", content: "Analiza el documento", approvals: [] },
        { ...assistantMessage(), id: "assistant-running", status: "streaming", content: "Trabajando", approvals: [] },
      ],
    };
    renderWorkspace(thread, project, {
      prompt: "Prepara el resumen",
      sending: true,
      queuedMessages: [{ id: "queued-1", text: "Compara las conclusiones" }],
      onSend,
      onStop,
      onCancelQueuedMessage,
    });

    expect(screen.getAllByText("Analiza el documento")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Añadir mensaje a la cola" }));
    expect(onSend).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Detener respuesta" }));
    expect(onStop).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: 'Quitar "Compara las conclusiones" de la cola' }));
    expect(onCancelQueuedMessage).toHaveBeenCalledWith("queued-1");
  });

  it("offers only the two named work experiences with complete menu navigation", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Experiencia" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    expect(screen.queryByRole("menuitemradio", { name: /Rápido/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Inteligente/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Experto/ })).toBeInTheDocument();
    const menu = screen.getByRole("menu", { name: "Experiencia" });
    expect(menu).not.toHaveTextContent(/GPT|Terra|Sol/i);
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /Inteligente/ })).toHaveFocus());
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: /Experto/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(screen.getByRole("menuitemradio", { name: /Inteligente/ })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Aprobar permisos automáticamente" })).not.toBeInTheDocument();
  });

  it("focuses a keyboard-opened experience before the next key and never resets it on a delayed frame", async () => {
    renderWorkspace();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveFocus());
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      frames.set(++frameId, callback);
      return frameId;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    const flushFrames = () => act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
    });
    try {
      const trigger = screen.getByRole("button", { name: "Experiencia" });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      const selected = screen.getByRole("menuitemradio", { name: /Inteligente/ });
      const last = screen.getByRole("menuitemradio", { name: /Experto/ });
      // The next real keyboard event targets the focused element, not the menu
      // container chosen manually by a test. Opening must complete focus first.
      expect(selected).toHaveFocus();
      fireEvent.keyDown(document.activeElement!, { key: "End" });
      expect(last).toHaveFocus();
      flushFrames();
      expect(last).toHaveFocus();
      fireEvent.keyDown(last, { key: "Escape" });
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole("menu", { name: "Experiencia" })).toBeNull();
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      fireEvent.keyDown(document.activeElement!, { key: "End" });
      const reopenedLast = screen.getByRole("menuitemradio", { name: /Experto/ });
      expect(reopenedLast).toHaveFocus();
      flushFrames();
      expect(reopenedLast).toHaveFocus();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("keeps one action control and exposes stop while the agent is working", () => {
    const onStop = vi.fn();
    renderWorkspace(null, project, { prompt: "Continua", sending: true, onStop });

    expect(screen.queryByRole("button", { name: "Enviar mensaje" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Detener respuesta" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("keeps a live response pinned without restarting smooth scrolling for every delta", () => {
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    const message = assistantMessage();
    const thread: WorkbenchThread = {
      id: "thread-streaming",
      projectId: project.id,
      title: "Respuesta en curso",
      status: "active",
      pinned: false,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:01.000Z",
      messages: [{ ...message, status: "streaming", content: "Texto parcial" }],
    };

    renderWorkspace(thread, project, { sending: true });

    expect(screen.getByText("Texto parcial").closest("[data-state='streaming']")).toHaveAttribute("aria-busy", "true");
    expect(scrollIntoView).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  it.each(["", "Resultado parcial"])("pauses visible loading without failing the saved response (content=%s)", (content) => {
    const request: ChatMessage = { ...assistantMessage(), id: "request", role: "user", content: "Revisa estas facturas", approvals: [],
      attachments: Array.from({ length: 13 }, (_, i) => ({ id: `invoice-${i}`, uploadId: `invoice-${i}`, name: `Factura ${i + 1}.pdf`, mimeType: "application/pdf", size: 100 })) };
    const pending: ChatMessage = { ...assistantMessage(), status: "streaming", content, approvals: [] };
    const thread: WorkbenchThread = { id: "thread-recovery", projectId: project.id, title: "Facturas", status: "active", pinned: false, createdAt: request.createdAt, updatedAt: request.createdAt, messages: [request, pending] };
    const onRetry = vi.fn();
    const onSend = vi.fn();
    const { container, updateProps } = renderWorkspace(thread, project, { sending: true, onSend });
    if (!content) expect(screen.getByTestId("thinking-orb")).toBeInTheDocument();
    act(() => updateProps({ streamRecovery: { attempt: null, paused: true, onRetry } }));
    expect(screen.queryByTestId("thinking-orb")).not.toBeInTheDocument();
    expect(container.querySelector("[aria-busy='true']")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("El trabajo y los resultados guardados se conservan");
    if (content) expect(screen.getByText(content).closest("[data-state='paused']")).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText("No se ha podido completar esta respuesta.")).not.toBeInTheDocument();
    for (const attachment of request.attachments) expect(screen.getByText(attachment.name)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconectar respuesta" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    expect(thread.messages[1].status).toBe("streaming");
    act(() => updateProps({ streamRecovery: { attempt: 1, paused: false, onRetry } }));
    if (!content) expect(screen.getByTestId("thinking-orb")).toBeInTheDocument();
  });

  it("pauses a running work timeline without completing its saved activities", () => {
    const pending: ChatMessage = { ...assistantMessage(), status: "streaming", content: "", approvals: [],
      activity: [{ id: "inspect-invoice", kind: "command", label: "Revisando facturas", status: "running" }],
      plan: [{ step: "Revisar los importes", status: "in_progress" }] };
    const thread: WorkbenchThread = { id: "thread-paused-work", projectId: project.id, title: "Facturas", status: "active", pinned: false, createdAt: pending.createdAt, updatedAt: pending.createdAt, messages: [pending] };
    const { container } = renderWorkspace(thread, project, { sending: true, streamRecovery: { attempt: null, paused: true, onRetry: vi.fn() } });
    expect(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" })).toHaveTextContent("Recuperación de la respuesta en pausa");
    fireEvent.click(screen.getByRole("button", { name: "Mostrar el proceso de trabajo" }));
    expect(container.querySelector(".motion-safe\\:animate-spin")).not.toBeInTheDocument();
    expect(container.querySelector(".activity-shimmer")).not.toBeInTheDocument();
    expect(pending.activity[0].status).toBe("running");
    expect(pending.plan[0].status).toBe("in_progress");
    expect(pending.status).toBe("streaming");
  });

  it("shows the latest honest lifecycle status instead of a generic thinking placeholder", () => {
    const message = assistantMessage();
    const thread: WorkbenchThread = {
      id: "thread-feedback",
      projectId: project.id,
      title: "Respuesta en curso",
      status: "active",
      pinned: false,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:01.000Z",
      messages: [{
        ...message,
        content: "",
        status: "streaming",
        approvals: [],
        activity: [{ id: "runtime-context", kind: "system", label: "Preparant el context", status: "running" }],
      }],
    };

    renderWorkspace(thread, project, { sending: true });

    expect(screen.getByRole("status")).toHaveTextContent("Preparando el contexto");
    expect(screen.queryByText("Pensando…")).not.toBeInTheDocument();
  });

  it("prevents duplicate stop requests while App Server confirms cancellation", () => {
    const onStop = vi.fn();
    renderWorkspace(null, project, { sending: true, stopping: true, onStop });

    const button = screen.getByRole("button", { name: "Deteniendo respuesta" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("shows a file drop message and forwards dropped files to the existing attachment flow", () => {
    const onAddDocuments = vi.fn(async () => undefined);
    renderWorkspace(null, project, {
      runtimeStatus: { ...initialRuntimeStatus, mode: "codex", codex: "connected", ready: true },
      onAddDocuments,
    });

    const composer = screen.getByTestId("composer");
    const file = new File(["contenido"], "informe.pdf", { type: "application/pdf" });
    fireEvent.dragEnter(composer, { dataTransfer: { files: [file] } });
    expect(screen.getByText("Suelta los archivos para adjuntarlos")).toBeInTheDocument();
    fireEvent.drop(composer, { dataTransfer: { files: [file] } });

    expect(onAddDocuments).toHaveBeenCalledWith([file]);
  });

  it("keeps only copy below a response while retaining sensitive approval cards", () => {
    const thread: WorkbenchThread = {
      id: "thread-1",
      projectId: project.id,
      title: "Consulta",
      status: "active",
      pinned: false,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      messages: [assistantMessage()],
    };
    renderWorkspace(thread);

    expect(screen.getByRole("button", { name: "Copiar" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Aprobación: Confirmar cambio sensible" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Permitir" })).not.toBeInTheDocument();
    for (const removed of ["Aprobar resultado", "Descargar resultado", "Leer en voz alta", "Regenerar respuesta", "Crear rama desde aquí", "Revisar resultados"]) {
      expect(screen.queryByLabelText(removed)).not.toBeInTheDocument();
    }
    expect(screen.queryByLabelText("Acciones de conversación")).not.toBeInTheDocument();
  });
});

it("removes server controls for Trinalum and InsiJets while preserving other installations", () => {
  for (const installationId of ["trinalum-production", "insijets-demo"]) {
    renderWorkspace(null, project, { installationId, onServerReferencesChange: vi.fn() });
    expect(screen.queryByRole("button", { name: "Archivos del servidor" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Añadir al mensaje" }));
    expect(screen.queryByRole("menuitem", { name: "Archivos del servidor" })).not.toBeInTheDocument();
    cleanup();
  }
  renderWorkspace(null, project, { installationId: "arnall", onServerReferencesChange: vi.fn() });
  expect(screen.getByRole("button", { name: "Archivos del servidor" })).toBeInTheDocument();
});

it("keeps internal G03 apps out of Tools while preserving the production connector", () => {
  renderWorkspace(null, null, { installationId: "g03-production", connectorCatalogStatus: "ready", connectorMentions: [
    { id: "g03-production", label: "Full de producció", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: false },
    { id: "g03-app-test", label: "Equips i calibracions", kind: "connector", status: "connected", statusCode: null, canRead: true, requiresApprovalForWrites: false },
  ] });
  fireEvent.click(screen.getByRole("button", { name: "Conexiones" }));
  expect(screen.getByRole("option", { name: /Full de producció/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Equips i calibracions/ })).not.toBeInTheDocument();
});
it("offers neutral tasks without implying department access to a G03 employee", () => {
  const send = vi.fn();
  renderWorkspace(null, null, { installationId: "g03-production", userName: "Lídia", onSend: send });
  expect(screen.getByRole("heading", { name: "¿En qué te puedo ayudar, Lídia?" })).toBeInTheDocument();
  for (const department of ["Producció", "Qualitat", "Administració"]) expect(screen.queryByRole("button", { name: department })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Resumir documentos" }));
  expect((screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement).value).toContain("documentos");
  expect(send).not.toHaveBeenCalled();
});
