// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AUTOMATION_EXECUTION_CONTEXT, type AutomationTaskView } from "@/automations/contracts";
import { AutomationsPanel } from "@/components/automations-panel";
import type { WorkbenchProject } from "@/workbench/types";

const ownerId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const groupId = "00000000-0000-4000-8000-000000000010";
const projectId = "10000000-0000-4000-8000-000000000001";
const emptyAudience = { membershipPolicy: "current", currentUserId: ownerId, users: [], groups: [] };

const project: WorkbenchProject = {
  id: projectId,
  name: "Operaciones",
  slug: "operaciones",
  status: "active",
  pinned: false,
  instructions: "",
  sources: [],
  memory: { enabled: true, notes: "", updatedAt: null },
  sharing: { visibility: "private", members: [] },
  workspace: { id: "operations-workspace", label: "Operaciones", hostType: "managed", status: "ready", isPrimary: true },
  createdAt: "2026-08-30T08:00:00.000Z",
  updatedAt: "2026-08-30T08:00:00.000Z",
};

const viewerTask: AutomationTaskView = {
  schemaVersion: 1,
  id: "20000000-0000-4000-8000-000000000001",
  installationId: "audience-qa",
  userId: ownerId,
  owner: { userId: ownerId, name: "Propietario" },
  audience: { membershipPolicy: "current", userIds: [], groupIds: [groupId] },
  name: "Informe compartido",
  prompt: "Prepara el informe.",
  projectId,
  projectName: project.name,
  timeZone: "Europe/Madrid",
  schedule: { kind: "daily", hour: 9, minute: 0 },
  executionContext: DEFAULT_AUTOMATION_EXECUTION_CONTEXT,
  state: "active",
  nextRunAt: "2030-08-30T07:00:00.000Z",
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
  retryAt: null,
  manualRun: null,
  deletedAt: null,
  cancellationRequestedAt: null,
  lease: null,
  createdAt: "2026-08-30T08:00:00.000Z",
  updatedAt: "2026-08-30T08:00:00.000Z",
  access: { canManage: false, canViewResults: true },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AutomationsPanel audience", () => {
  it("shows recovered attempts as interrupted beside the completed result", async () => {
    const base = {
      schemaVersion: 1, taskId: viewerTask.id, installationId: viewerTask.installationId, userId: ownerId,
      runKey: "recovered-run", scheduledFor: "2030-08-30T08:00:00.000Z", threadId: projectId, error: null,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/runs") ? {
      runs: [
        { ...base, status: "interrupted", attempt: 1, startedAt: "2030-08-30T08:00:00.000Z", finishedAt: null,
          recoveredByAttempt: 2, recoveredAt: "2030-08-30T08:10:00.000Z" },
        { ...base, status: "succeeded", attempt: 2, startedAt: "2030-08-30T08:10:00.000Z", finishedAt: "2030-08-30T08:12:00.000Z" },
      ],
    } : { tasks: [viewerTask], audienceDirectory: emptyAudience }), { status: 200 })));
    const onOpenThread = vi.fn();
    render(<AutomationsPanel open projects={[project]} onOpenThread={onOpenThread} />);
    fireEvent.click(await screen.findByRole("button", { name: "Historial y resultados" }));
    expect(await screen.findByText("Interrumpida")).toBeInTheDocument();
    expect(screen.getByText("Completada")).toBeInTheDocument();
    expect(screen.queryByText("En curso")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Abrir resultado" })[0]);
    expect(onOpenThread).toHaveBeenCalledWith(projectId);
  });
  it("clears a background list error only after a successful refresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let unavailable = false;
    let name = viewerTask.name;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(JSON.stringify(unavailable ? { error: "Lista temporalmente no disponible" } : {
        tasks: [{ ...viewerTask, name }], audienceDirectory: emptyAudience,
      }), { status: unavailable ? 503 : 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    render(<AutomationsPanel open projects={[project]} />);
    await screen.findByText(viewerTask.name);

    unavailable = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("Lista temporalmente no disponible");
    expect(screen.getByText(viewerTask.name)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("Lista temporalmente no disponible");

    unavailable = false;
    name = "Informe actualizado";
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("retains a history error while it fails and clears it when the open history recovers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let unavailable = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const history = url.endsWith("/runs");
      return new Response(JSON.stringify(history
        ? unavailable ? { error: "Historial temporalmente no disponible" } : { runs: [] }
        : { tasks: [viewerTask], audienceDirectory: emptyAudience }), {
        status: history && unavailable ? 503 : 200, headers: { "Content-Type": "application/json" },
      });
    }));
    render(<AutomationsPanel open projects={[project]} />);
    await screen.findByText(viewerTask.name);
    fireEvent.click(screen.getByRole("button", { name: "Historial y resultados" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Historial temporalmente no disponible");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("Historial temporalmente no disponible");

    unavailable = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText("Aún no hay ejecuciones registradas.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not clear or retry a failed task change when background reads succeed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const requests: string[] = [];
    const managedTask = { ...viewerTask, access: { canManage: true, canViewResults: true } };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push(method);
      return new Response(JSON.stringify(method === "PATCH" ? { error: "No se pudo pausar la tarea" } : {
        tasks: [managedTask], audienceDirectory: emptyAudience,
      }), { status: method === "PATCH" ? 503 : 200, headers: { "Content-Type": "application/json" } });
    }));
    render(<AutomationsPanel open projects={[project]} />);
    fireEvent.click(await screen.findByRole("button", { name: `Pausar ${viewerTask.name}` }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo pausar la tarea");
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo pausar la tarea");
    expect(requests).toEqual(["GET", "PATCH", "GET", "GET"]);
    expect(screen.getByRole("button", { name: `Pausar ${viewerTask.name}` })).toBeInTheDocument();
  });

  it("refreshes a completed queued run and its open history without reloading the page", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let completed = false;
    const queuedTask = { ...viewerTask, manualRun: { requestId: groupId, scheduledFor: "2030-08-30T08:00:00.000Z" } };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/runs") ? {
      runs: completed ? [{
        schemaVersion: 1, taskId: viewerTask.id, installationId: viewerTask.installationId,
        userId: ownerId, runKey: "accepted-run", scheduledFor: "2030-08-30T08:00:00.000Z",
        status: "succeeded", attempt: 1, startedAt: "2030-08-30T08:00:00.000Z",
        finishedAt: "2030-08-30T08:01:00.000Z", threadId: projectId, error: null,
      }] : [],
    } : {
      tasks: [completed ? { ...queuedTask, manualRun: null, lastRunAt: "2030-08-30T08:01:00.000Z", lastRunStatus: "succeeded" } : queuedTask],
      audienceDirectory: emptyAudience,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const onOpenThread = vi.fn();
    render(<AutomationsPanel open projects={[project]} onOpenThread={onOpenThread} />);
    expect(await screen.findByText("Ejecución en cola")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Historial y resultados" }));
    expect(await screen.findByText("Aún no hay ejecuciones registradas.")).toBeInTheDocument();
    completed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByText("Ejecución en cola")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir resultado" }));
    expect(onOpenThread).toHaveBeenCalledWith(projectId);
    expect(screen.queryByText("Cargando automatizaciones…")).not.toBeInTheDocument();
  });

  it("suspends background refresh while an automation draft is being edited", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      tasks: [viewerTask], audienceDirectory: emptyAudience,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const view = render(<AutomationsPanel open projects={[project]} />);
    await screen.findByText("Informe compartido");
    fireEvent.click(screen.getByRole("button", { name: "Nueva" }));
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Borrador sin guardar" } });
    const requests = fetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(requests);
    expect(screen.getByLabelText("Nombre")).toHaveValue("Borrador sin guardar");
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(requests);
  });
  it("keeps the mobile sidebar control available on the automations surface", () => {
    const onToggleSidebar = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    render(<AutomationsPanel open projects={[project]} onToggleSidebar={onToggleSidebar} />);
    fireEvent.click(screen.getByRole("button", { name: "Mostrar u ocultar la barra lateral" }));

    expect(onToggleSidebar).toHaveBeenCalledOnce();
  });

  it("shows only authorized controls and defaults a new task to the current user with optional users and groups", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify({
          tasks: [viewerTask],
          worker: null,
          audienceDirectory: {
            membershipPolicy: "current",
            currentUserId: ownerId,
            users: [{ id: ownerId, name: "Owner" }, { id: memberId, name: "Member" }],
            groups: [{ id: groupId, name: "Operaciones" }],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body));
      requests.push({ method, body });
      return new Response(JSON.stringify({ task: { ...viewerTask, ...body, access: { canManage: true, canViewResults: true } } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }));

    render(<AutomationsPanel open projects={[project]} />);
    expect(screen.getByRole("main", { name: "Automatizaciones" })).toBeInTheDocument();
    expect(screen.queryByText("Centro de tareas")).not.toBeInTheDocument();
    expect(screen.queryByText(/Servicio de automatizaciones|Se ejecutan mientras/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/Propietario: Propietario · Destinatarios: Grupo: Operaciones/)).toBeInTheDocument();
    expect(screen.queryByText("Centro de tareas")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Editar Informe compartido" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Nueva" }));
    const owner = screen.getByRole("checkbox", { name: "Owner" });
    const member = screen.getByRole("checkbox", { name: "Member" });
    const group = screen.getByRole("checkbox", { name: "Operaciones" });
    expect(owner).toBeChecked();
    expect(member).not.toBeChecked();
    fireEvent.click(member);
    fireEvent.click(group);
    fireEvent.change(screen.getByPlaceholderText("Resumen diario del proyecto"), { target: { value: "Informe nuevo" } });
    fireEvent.change(screen.getByPlaceholderText("Revisa las novedades del proyecto y prepara un resumen con próximos pasos."), { target: { value: "Prepara el informe nuevo." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: {
        audience: { membershipPolicy: "current", userIds: [ownerId, memberId], groupIds: [groupId] },
      },
    });
  });

  it("keeps the empty action centered and labels the standalone project as Sin proyecto", async () => {
    const standaloneProject = { ...project, name: "Conversaciones", slug: "aibrain-standalone-chats" };
    const standaloneTask = { ...viewerTask, projectId: standaloneProject.id, projectName: "Conversaciones" };
    let tasks: AutomationTaskView[] = [standaloneTask];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      tasks,
      worker: null,
      audienceDirectory: {
        membershipPolicy: "current",
        currentUserId: ownerId,
        users: [{ id: ownerId, name: "Owner" }],
        groups: [{ id: groupId, name: "Operaciones" }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const view = render(<AutomationsPanel open projects={[standaloneProject]} />);
    expect(await screen.findByText(/Sin proyecto ·/)).toBeInTheDocument();
    view.unmount();

    tasks = [];
    render(<AutomationsPanel open projects={[standaloneProject]} />);
    const emptyAction = await screen.findByRole("button", { name: "Nueva" });
    expect(emptyAction).toHaveClass("mx-auto");
    expect(emptyAction.parentElement).toHaveClass("workspace-empty-state");
  });

  it("persists an edited one-time date and minute instead of the form default", async () => {
    const onceTask: AutomationTaskView = {
      ...viewerTask,
      access: { canManage: true, canViewResults: true },
      audience: { membershipPolicy: "current", userIds: [ownerId], groupIds: [] },
      schedule: { kind: "once", runAt: "2030-08-29T23:28:00.000Z" },
    };
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify({
          tasks: [onceTask],
          audienceDirectory: {
            membershipPolicy: "current",
            currentUserId: ownerId,
            users: [{ id: ownerId, name: "Owner" }],
            groups: [],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ method, body });
      return new Response(JSON.stringify({ task: { ...onceTask, ...body } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    render(<AutomationsPanel open projects={[project]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar Informe compartido" }));
    fireEvent.change(screen.getByLabelText("Fecha"), { target: { value: "2030-08-30" } });
    fireEvent.change(screen.getByLabelText("Hora"), { target: { value: "00:31" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      method: "PATCH",
      body: {
        schedule: { kind: "once", runAt: "2030-08-29T22:31:00.000Z" },
        timeZone: "Europe/Madrid",
      },
    });
  });

  it("opens the editor as a named focus-trapped dialog and restores its opener on Escape", async () => {
    const managedTask = { ...viewerTask, access: { canManage: true, canViewResults: true } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      tasks: [managedTask],
      audienceDirectory: {
        membershipPolicy: "current",
        currentUserId: ownerId,
        users: [{ id: ownerId, name: "Owner" }],
        groups: [],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    render(<AutomationsPanel open projects={[project]} />);
    const opener = await screen.findByRole("button", { name: "Editar Informe compartido" });
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Editar automatización" });
    const name = screen.getByRole("textbox", { name: "Nombre" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(name).toHaveFocus());

    const cancel = screen.getByRole("button", { name: "Cancelar" });
    cancel.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("combobox", { name: "Zona horaria" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar automatización" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("keeps a dirty draft on Escape until the user explicitly discards it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      tasks: [],
      audienceDirectory: {
        membershipPolicy: "current",
        currentUserId: ownerId,
        users: [{ id: ownerId, name: "Owner" }],
        groups: [],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    render(<AutomationsPanel open projects={[project]} />);
    const opener = await screen.findByRole("button", { name: "Nueva" });
    fireEvent.click(opener);
    const name = screen.getByRole("textbox", { name: "Nombre" });
    await waitFor(() => expect(name).toHaveFocus());
    fireEvent.change(name, { target: { value: "Borrador importante" } });
    fireEvent.keyDown(document, { key: "Escape" });

    const confirmation = await screen.findByRole("alertdialog", { name: "¿Descartar los cambios?" });
    expect(confirmation).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Nueva automatización" })).toBeInTheDocument();
    const continueEditing = screen.getByRole("button", { name: "Seguir editando" });
    const discard = screen.getByRole("button", { name: "Descartar cambios" });
    await waitFor(() => expect(continueEditing).toHaveFocus());
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(discard).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(continueEditing).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog", { name: "¿Descartar los cambios?" })).not.toBeInTheDocument();
    await waitFor(() => expect(name).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: "Descartar cambios" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nueva automatización" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("uses a focus-managed confirmation dialog before deleting an automation", async () => {
    // A frame may run before React commits the asynchronous deletion.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(performance.now()); return 0; });
    const managedTask = { ...viewerTask, access: { canManage: true, canViewResults: true } };
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") {
        requests.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({
        tasks: [managedTask],
        audienceDirectory: {
          membershipPolicy: "current",
          currentUserId: ownerId,
          users: [{ id: ownerId, name: "Owner" }],
          groups: [],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    render(<AutomationsPanel open projects={[project]} />);
    const opener = await screen.findByRole("button", { name: "Eliminar Informe compartido" });
    fireEvent.click(opener);

    expect(screen.getByRole("alertdialog", { name: "¿Eliminar “Informe compartido”?" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancelar" })).toHaveFocus());
    expect(requests).toEqual([]);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "¿Eliminar “Informe compartido”?" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();

    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar automatización" }));
    await waitFor(() => expect(requests).toEqual([`/api/automations/${viewerTask.id}`]));
    expect(screen.queryByText("Informe compartido")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Nueva" })).toHaveFocus());
  });

  it("reports editor and deletion surfaces so the app can prevent stacked global dialogs", async () => {
    const managedTask = { ...viewerTask, access: { canManage: true, canViewResults: true } };
    const onBlockingSurfaceChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      tasks: [managedTask],
      audienceDirectory: {
        membershipPolicy: "current",
        currentUserId: ownerId,
        users: [{ id: ownerId, name: "Owner" }],
        groups: [],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    render(
      <AutomationsPanel
        open
        projects={[project]}
        onBlockingSurfaceChange={onBlockingSurfaceChange}
      />,
    );
    await screen.findByRole("button", { name: "Editar Informe compartido" });
    await waitFor(() => expect(onBlockingSurfaceChange).toHaveBeenLastCalledWith(false));
    onBlockingSurfaceChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Nueva" }));
    expect(onBlockingSurfaceChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre" }), { target: { value: "Borrador" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByRole("alertdialog", { name: "¿Descartar los cambios?" })).toBeInTheDocument();
    expect(onBlockingSurfaceChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Descartar cambios" }));
    await waitFor(() => expect(onBlockingSurfaceChange).toHaveBeenLastCalledWith(false));

    onBlockingSurfaceChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar Informe compartido" }));
    expect(onBlockingSurfaceChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onBlockingSurfaceChange).toHaveBeenLastCalledWith(false));
  });


  it("creates a durable 120-minute interval task from the UI", async () => {
    let submitted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return Response.json({ tasks: [], worker: null, audienceDirectory: { membershipPolicy: "current", currentUserId: ownerId, users: [{ id: ownerId, name: "Owner" }], groups: [] } });
      submitted = JSON.parse(String(init.body));
      return Response.json({ task: { ...viewerTask, ...submitted, access: { canManage: true, canViewResults: true } } });
    }));
    render(<AutomationsPanel open projects={[project]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Nueva" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Nueva" }));
    fireEvent.change(screen.getByPlaceholderText("Resumen diario del proyecto"), { target: { value: "Facturas" } });
    fireEvent.change(screen.getByPlaceholderText("Revisa las novedades del proyecto y prepara un resumen con próximos pasos."), { target: { value: "Importa facturas del correo de empresa." } });
    fireEvent.click(screen.getByRole("button", { name: "Por intervalo" }));
    expect(screen.getByRole("spinbutton", { name: /Intervalo en minutos/ })).toHaveValue(120);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(submitted).toMatchObject({ schedule: { kind: "interval", minutes: 120, anchorAt: expect.any(String) } }));
  });


  it("updates a queued task after the worker finishes without reloading or resubmitting it", async () => {
    let completed = false;
    const request = vi.fn(async () => Response.json({ tasks: [{ ...viewerTask,
      manualRun: completed ? null : { requestId: "30000000-0000-4000-8000-000000000001", scheduledFor: "2026-10-07T12:00:00.000Z" },
      lastRunStatus: completed ? "succeeded" : null,
      lastRunAt: completed ? "2026-10-07T12:00:00.000Z" : null,
      access: { canManage: true, canViewResults: true },
    }], audienceDirectory: { membershipPolicy: "current", currentUserId: ownerId, users: [], groups: [] } }));
    vi.stubGlobal("fetch", request);
    vi.useFakeTimers();
    await act(async () => { render(<AutomationsPanel open projects={[project]} />); });
    expect(screen.getByText("Ejecución en cola")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ejecutar ahora" })).toBeDisabled();
    completed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.queryByText("Ejecución en cola")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ejecutar ahora" })).toBeEnabled();
    expect(request.mock.calls).toHaveLength(2);
  });


  it("shows a leased automatic run as in progress and prevents duplicate manual submission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tasks: [{ ...viewerTask,
      lease: { workerId: "worker", runKey: "automatic", attempt: 1, claimedAt: "2026-10-07T12:00:00.000Z", expiresAt: "2026-10-07T12:10:00.000Z" },
      access: { canManage: true, canViewResults: true },
    }], audienceDirectory: { membershipPolicy: "current", currentUserId: ownerId, users: [], groups: [] } })));
    render(<AutomationsPanel open projects={[project]} />);
    expect(await screen.findByText("En curso")).toBeInTheDocument();
    expect(screen.queryByText("Ejecución en cola")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ejecutar ahora" })).toBeDisabled();
  });


  it("waits for the current recipient identity before opening a new automation", async () => {
    let resolveDirectory!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveDirectory = resolve; })));
    render(<AutomationsPanel open projects={[project]} />);
    const prematureButton = screen.queryByRole("button", { name: "Nueva" });
    if (prematureButton) expect(prematureButton).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(resolveDirectory).toBeTypeOf("function"));
    await act(async () => { resolveDirectory(Response.json({ tasks: [], audienceDirectory: { membershipPolicy: "current", currentUserId: ownerId, users: [{ id: ownerId, name: "Owner" }], groups: [] } })); });
    const newButton = screen.getByRole("button", { name: "Nueva" });
    expect(newButton).toBeEnabled();
    fireEvent.click(newButton);
    expect(screen.getByRole("checkbox", { name: "Owner" })).toBeChecked();
  });
});

it.each([true,false])('resolves a result outside the sidebar using project permission (allowed=%s)', async allowed => {
 const threadId='30000000-0000-4000-8000-000000000001',onOpenThread=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
  const url=String(input);
  if(url.includes('/runs'))return Response.json({runs:[{runKey:'run',attempt:1,status:'succeeded',threadId,startedAt:'2026-10-08T00:00:00.000Z',finishedAt:'2026-10-08T00:01:00.000Z'}]});
  if(url.includes('/api/projects/'))return allowed?Response.json({project:{...project,workspace:{...project.workspace,id:"40000000-0000-4000-8000-000000000001"}}}):Response.json({error:'Not found'},{status:404});
  if(url.includes('/api/threads/'))return Response.json({thread:{id:threadId,projectId,title:'Resultado',status:'active',pinned:false,createdAt:'2026-10-08T00:00:00.000Z',updatedAt:'2026-10-08T00:01:00.000Z',messages:[]}});
  return Response.json({tasks:[viewerTask],audienceDirectory:{membershipPolicy:'current',currentUserId:memberId,users:[],groups:[]}});
 }));
 render(<AutomationsPanel open projects={[]} onOpenThread={onOpenThread}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Historial y resultados'}));
 fireEvent.click(await screen.findByRole('button',{name:'Abrir resultado'}));
 if(allowed)await waitFor(()=>expect(onOpenThread).toHaveBeenCalledWith(threadId));
 else {expect(await screen.findByRole('region',{name:'Resultado de la automatización'})).toBeInTheDocument();await waitFor(()=>expect(screen.queryByRole('status')).not.toBeInTheDocument());expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(onOpenThread).not.toHaveBeenCalled();expect(screen.queryByRole('textbox')).not.toBeInTheDocument();}
});



  it("preserves an owner's private project when an administrator edits the prompt", async () => {
    const task = { ...viewerTask, audience: { membershipPolicy: "current" as const, userIds: [ownerId], groupIds: [] }, access: { canManage: true, canViewResults: true } };
    const changes: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        changes.push(body);
        return Response.json({ task: { ...task, ...body } });
      }
      return Response.json({ tasks: [task], audienceDirectory: { membershipPolicy: "current", currentUserId: memberId, users: [{ id: ownerId, name: "Owner" }], groups: [] } });
    }));
    render(<AutomationsPanel open projects={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar Informe compartido" }));
    expect(screen.getByRole("combobox", { name: "Proyecto" })).toHaveValue(projectId);
    expect(screen.getByRole("option", { name: "Operaciones" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Qué debe hacer" }), { target: { value: "Revisa un lote y conserva el resto pendiente." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).not.toHaveProperty("projectId");
    expect(changes[0]).not.toHaveProperty("projectName");
    expect(changes[0]).toMatchObject({ prompt: "Revisa un lote y conserva el resto pendiente.", audience: task.audience, timeZone: task.timeZone, schedule: task.schedule });
  });


  it("still submits an actual project change for server validation", async () => {
    const task = { ...viewerTask, audience: { membershipPolicy: "current" as const, userIds: [ownerId], groupIds: [] }, access: { canManage: true, canViewResults: true } };
    let submitted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        submitted = JSON.parse(String(init.body));
        return Response.json({ task: { ...task, ...submitted } });
      }
      return Response.json({ tasks: [task], audienceDirectory: { membershipPolicy: "current", currentUserId: memberId, users: [{ id: ownerId, name: "Owner" }], groups: [] } });
    }));
    const other = { ...project, id: "10000000-0000-4000-8000-000000000002", name: "Otro proyecto" };
    render(<AutomationsPanel open projects={[other]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar Informe compartido" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Proyecto" }), { target: { value: other.id } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted).toMatchObject({ projectId: other.id, projectName: other.name });
  });


it.each(["daily", "weekly", "interval", "monthly"] as const)("preserves and allows clearing a paused %s first date without losing its cadence", async kind => {
  const startAt = "2026-11-09T08:00:00.123Z";
  const schedule = kind === "interval" ? {kind, minutes: 60, anchorAt: "2026-11-04T08:15:00.000Z", startAt, window: {weekdays:[1,2,3,4,5],startHour:9,endHour:18}} : kind === "monthly" ? {kind,day:9,months:[11],hour:9,minute:0,startAt} : {kind,hour:9,minute:0,startAt,...(kind === "weekly" ? {weekdays:[1,2,3,4,5]} : {})};
  const task = {...viewerTask, schedule, state:"paused" as const, audience: {membershipPolicy: "current" as const,userIds:[ownerId],groupIds:[]}, access: {canManage:true,canViewResults:true}};
  const changes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {const body = JSON.parse(String(init.body)); changes.push(body); return Response.json({task:{...task,...body}});}
    return Response.json({tasks:[task], audienceDirectory: {...emptyAudience,users:[{id:ownerId,name:"Owner"}]}});
  }));
  render(<AutomationsPanel open projects={[project]} />);
  fireEvent.click(await screen.findByRole("button", {name:"Editar Informe compartido"}));
  expect(screen.getByLabelText("Primera fecha, opcional")).toHaveValue("2026-11-09T09:00");
  fireEvent.change(screen.getByRole("textbox",{name:"Nombre"}),{target:{value:"Edited"}});
  fireEvent.click(screen.getByRole("button",{name:"Guardar"}));
  await waitFor(()=>expect(changes).toHaveLength(1));
  expect(changes[0].schedule).toEqual(schedule);
  fireEvent.click(await screen.findByRole("button", {name:"Editar Edited"}));
  fireEvent.change(screen.getByLabelText("Primera fecha, opcional"),{target:{value:""}});
  fireEvent.click(screen.getByRole("button",{name:"Guardar"}));
  await waitFor(()=>expect(changes).toHaveLength(2));
  const {startAt: _removed, ...legacy} = schedule;
  expect(changes[1].schedule).toEqual(legacy);
});
