// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "../render-spanish";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { TextDialog } from "@/components/workbench-dialogs";
import { isHiddenFromFocus, useModalFocus } from "@/ui/use-modal-focus";

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Abrir diálogo</button>
      <TextDialog
        open={open}
        title="Nuevo proyecto"
        label="Nombre"
        submitLabel="Crear"
        busy={false}
        onClose={() => setOpen(false)}
        onSubmit={() => setOpen(false)}
      />
    </>
  );
}

function HiddenControlsHarness() {
  const firstRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(true, () => undefined, firstRef);
  return (
    <div ref={dialogRef} role="dialog" aria-label="Prueba de foco" tabIndex={-1}>
      <button ref={firstRef} type="button">Primero</button>
      <details><summary>Salida cerrada</summary><pre tabIndex={0}>Contenido cerrado</pre></details>
      <div hidden><button type="button">Oculto por atributo</button></div>
      <div inert><button type="button">Oculto por inert</button></div>
      <div aria-hidden="true"><button type="button">Oculto para accesibilidad</button></div>
      <div style={{ display: "none" }}><button type="button">Oculto por display</button></div>
      <div style={{ visibility: "hidden" }}><button type="button">Oculto por visibilidad</button></div>
      <details open><summary>Último</summary></details>
    </div>
  );
}

function ExplicitReturnHarness() {
  const [open, setOpen] = useState(false);
  const stableReturnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(open, () => setOpen(false), undefined, stableReturnRef);
  return (
    <>
      <button ref={stableReturnRef} type="button">Cuenta</button>
      {!open ? <button type="button" onClick={() => setOpen(true)}>Opción temporal</button> : null}
      {open ? <div ref={dialogRef} role="dialog" aria-label="Configuración" tabIndex={-1}><button type="button">Cerrar configuración</button></div> : null}
    </>
  );
}

describe("modal focus", () => {
  it("focuses the requested field, traps Tab and restores the opener on Escape", async () => {
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "Abrir diálogo" });
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByRole("textbox", { name: "Nombre" });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.change(input, { target: { value: "Proyecto sintético" } });
    const submit = screen.getByRole("button", { name: "Crear" });
    submit.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Cerrar" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("traps focus in both directions and excludes hidden ancestor subtrees", async () => {
    render(<HiddenControlsHarness />);
    const first = screen.getByRole("button", { name: "Primero" });
    const last = screen.getByText("Último");
    const closedContent = screen.getByText("Contenido cerrado");
    const dialog = screen.getByRole("dialog", { name: "Prueba de foco" });
    await waitFor(() => expect(first).toHaveFocus());
    expect(isHiddenFromFocus(closedContent, dialog)).toBe(true);
    expect(isHiddenFromFocus(screen.getByText("Salida cerrada"), dialog)).toBe(false);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("restores a stable explicit target when the triggering menu item unmounts", async () => {
    render(<ExplicitReturnHarness />);
    const transient = screen.getByRole("button", { name: "Opción temporal" });
    transient.focus();
    fireEvent.click(transient);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cerrar configuración" })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configuración" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Cuenta" })).toHaveFocus();
  });
});
