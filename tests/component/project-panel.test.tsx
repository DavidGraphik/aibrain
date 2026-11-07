// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPanel } from "@/components/project-panel";
import type { UpdateProjectInput, WorkbenchProject } from "@/workbench/types";

const project: WorkbenchProject = {
  id: "project-operations",
  name: "Operaciones",
  slug: "operaciones",
  status: "active",
  pinned: false,
  instructions: "",
  sources: [],
  memory: { enabled: true, notes: "", updatedAt: null },
  sharing: {
    visibility: "shared",
    members: [{
      id: "member-ada",
      email: "ada@example.com",
      name: "Ada",
      role: "viewer",
      status: "active",
      addedAt: "2026-08-30T08:00:00.000Z",
    }],
  },
  workspace: { id: "workspace-operations", label: "Operaciones", hostType: "managed", status: "ready", isPrimary: true },
  createdAt: "2026-08-30T08:00:00.000Z",
  updatedAt: "2026-08-30T08:00:00.000Z",
};

function ProjectPanelHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Abrir ajustes</button>
      <ProjectPanel project={project} open={open} onClose={() => setOpen(false)} onSave={vi.fn(async () => true)} />
    </>
  );
}

function PersistingEditorPanelHarness() {
  const [currentProject, setCurrentProject] = useState<WorkbenchProject>({
    ...project,
    access: { role: "editor", canEdit: true, canManage: false },
  });
  return (
    <ProjectPanel
      project={currentProject}
      open
      onClose={vi.fn()}
      onSave={async (patch) => {
        setCurrentProject((current) => ({
          ...current,
          ...patch,
          updatedAt: "2026-08-30T09:00:00.000Z",
        }));
        return true;
      }}
    />
  );
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ProjectPanel", () => {
  it("focuses the modal, closes on Escape and restores the opener", async () => {
    render(<ProjectPanelHarness />);
    const opener = screen.getByRole("button", { name: "Abrir ajustes" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Configurar proyecto" });
    const close = screen.getByRole("button", { name: "Cerrar" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(dialog).toHaveAttribute("aria-modal", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    const exiting = document.querySelector('[data-overlay-presence="exiting"]');
    expect(exiting).toHaveAttribute("inert");
    expect(exiting).toHaveAttribute("aria-hidden", "true");
    expect(opener).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configurar proyecto" })).not.toBeInTheDocument());
  });

  it("keeps every settings field persistently named", async () => {
    render(<ProjectPanel project={project} open onClose={vi.fn()} onSave={vi.fn(async () => true)} />);

    expect(screen.getByRole("textbox", { name: "Instrucciones del proyecto" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Activar memoria del proyecto" })).not.toBeInTheDocument();
    expect(screen.getByText(/Siempre activa/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Notas de memoria del proyecto" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fuentes" }));
    expect(screen.getByLabelText("Archivos de referencia")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Nombre de la referencia/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "URL o nota de contexto" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Personas" }));
    expect(screen.getByRole("combobox", { name: "Visibilidad del proyecto" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Correo de la persona" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Rol de la persona" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Rol de ada@example.com" })).toBeInTheDocument();
  });

  it("refreshes the form when the selected project changes while the panel stays open", () => {
    const { rerender } = render(<ProjectPanel project={{ ...project, instructions: "Proyecto A" }} open onClose={vi.fn()} onSave={vi.fn(async () => true)} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Instrucciones del proyecto" }), { target: { value: "Borrador sin guardar" } });

    rerender(<ProjectPanel project={{ ...project, id: "project-sales", name: "Ventas", instructions: "Proyecto B" }} open onClose={vi.fn()} onSave={vi.fn(async () => true)} />);

    expect(screen.getByRole("textbox", { name: "Instrucciones del proyecto" })).toHaveValue("Proyecto B");
  });

  it("discards an unsaved draft when the panel is closed and reopened", async () => {
    render(<ProjectPanelHarness />);
    const opener = screen.getByRole("button", { name: "Abrir ajustes" });
    fireEvent.click(opener);
    fireEvent.change(screen.getByRole("textbox", { name: "Instrucciones del proyecto" }), {
      target: { value: "Borrador sin guardar" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configurar proyecto" })).not.toBeInTheDocument());
    fireEvent.click(opener);

    expect(screen.getByRole("textbox", { name: "Instrucciones del proyecto" })).toHaveValue("");
  });

  it("renders a viewer project as a fully readable but non-mutable surface", () => {
    const viewerProject: WorkbenchProject = {
      ...project,
      instructions: "Conservar el historial y el contexto.",
      access: { role: "viewer", canEdit: false, canManage: false },
    };
    render(<ProjectPanel project={viewerProject} open onClose={vi.fn()} onSave={vi.fn(async () => true)} />);

    expect(screen.getByText(/Tienes acceso de solo lectura/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Instrucciones del proyecto" })).toHaveAttribute("readonly");
    expect(screen.queryByRole("switch", { name: "Activar memoria del proyecto" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fuentes" }));
    expect(screen.queryByLabelText("Archivos de referencia")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Nombre de la referencia/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Personas" }));
    expect(screen.getByRole("combobox", { name: "Visibilidad del proyecto" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Rol de ada@example.com" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "Correo de la persona" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quitar ada@example.com" })).not.toBeInTheDocument();
  });

  it("lets editors save content without sending owner-only sharing changes", async () => {
    const onSave = vi.fn(async (_patch: UpdateProjectInput) => true);
    const editorProject: WorkbenchProject = {
      ...project,
      access: { role: "editor", canEdit: true, canManage: false },
    };
    render(<ProjectPanel project={editorProject} open onClose={vi.fn()} onSave={onSave} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Instrucciones del proyecto" }), {
      target: { value: "Contexto actualizado por el editor." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Personas" }));
    expect(screen.getByRole("combobox", { name: "Visibilidad del proyecto" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "Correo de la persona" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const patch = onSave.mock.calls[0]?.[0];
    expect(patch).toMatchObject({ instructions: "Contexto actualizado por el editor." });
    expect(patch).not.toHaveProperty("sharing");
  });

  it("keeps the active settings tab and confirmation after a persisted editor save", async () => {
    render(<PersistingEditorPanelHarness />);

    fireEvent.change(screen.getByRole("textbox", { name: "Instrucciones del proyecto" }), {
      target: { value: "Contexto persistido por el editor." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Personas" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.getByText("Proyecto actualizado.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Personas" })).toHaveAttribute("aria-current", "page");
  });
});

it("uploads original bytes and replaces a legacy pending reference only after server success", async () => {
  const file = new File(["original workbook bytes"], "CONTROL DE COSTOS.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const old = { id: "old", kind: "file" as const, name: file.name, url: null, mimeType: file.type, size: file.size, excerpt: null, status: "pending-index" as const, createdAt: project.createdAt };
  const source = { ...old, id: "saved", status: "ready" as const };
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    expect((options.body as FormData).get("file")).toBe(file);
    return { ok: true, json: async () => ({ source }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  const save = vi.fn(async () => true);
  render(<ProjectPanel project={{ ...project, sources: [old] }} open onClose={vi.fn()} onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Fuentes" }));
  expect(screen.getByText(/Falta el archivo original/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Archivos de referencia"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText("Disponible para las conversaciones")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ sources: [source] })));
});
