// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/command-palette";
import type { WorkbenchProject } from "@/workbench/types";

const project: WorkbenchProject = {
  id: "project-operations",
  name: "Operaciones",
  slug: "operaciones",
  status: "active",
  pinned: false,
  instructions: "",
  sources: [],
  memory: { enabled: true, notes: "", updatedAt: null },
  sharing: { visibility: "private", members: [] },
  workspace: { id: "workspace-operations", label: "Operaciones", hostType: "managed", status: "ready", isPrimary: true },
  createdAt: "2026-08-30T08:00:00.000Z",
  updatedAt: "2026-08-30T08:00:00.000Z",
};

function CommandPaletteHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Buscar</button>
      <CommandPalette
        open={open}
        projects={[]}
        threads={[]}
        activeProjectId={null}
        onClose={() => setOpen(false)}
        onSelectProject={() => undefined}
        onSelectThread={() => undefined}
      />
    </>
  );
}

afterEach(cleanup);

describe("CommandPalette", () => {
  it("restores focus, hides its exiting surface from a11y, and can reverse the exit", async () => {
    render(<CommandPaletteHarness />);
    const opener = screen.getByRole("button", { name: "Buscar" });
    opener.focus();
    fireEvent.click(opener);

    const input = await screen.findByRole("combobox", { name: "Buscar proyectos y conversaciones" });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    const exiting = document.querySelector('[data-overlay-presence="exiting"]');
    expect(exiting).toHaveAttribute("inert");
    expect(exiting).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("dialog", { name: "Buscar proyectos y conversaciones" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Buscar proyectos y conversaciones" })).toBeInTheDocument());
    expect(document.querySelector('[data-overlay-presence="present"]')).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("keeps Home, End and composing Enter owned by the search field", async () => {
    const onSelectProject = vi.fn();
    render(<CommandPalette open projects={[project]} threads={[]} activeProjectId={project.id} onClose={vi.fn()} onSelectProject={onSelectProject} onSelectThread={vi.fn()} />);
    const input = await screen.findByRole("combobox", { name: "Buscar proyectos y conversaciones" });
    await waitFor(() => expect(input).toHaveFocus());

    expect(fireEvent.keyDown(input, { key: "Home" })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "End" })).toBe(true);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSelectProject).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Buscar proyectos y conversaciones" })).toBeInTheDocument();
  });
});
