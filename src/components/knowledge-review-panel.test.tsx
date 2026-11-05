// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "../../tests/render-spanish";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReviewPanel } from "./knowledge-review-panel";

const id = "10000000-0000-4000-8000-000000000001", nextId = "20000000-0000-4000-8000-000000000001";
const original = { id, kind: "fact", label: "Ejemplo ficticio", topic: "Función", content: "Responsable del proyecto.", status: "proposed", revision: 1,
  citations: [{ source: "Y:\\fixture.txt", sha256: "a".repeat(64), locator: "line:1", quote: "Coordina el proyecto de prueba.", path: "fixture" }], conflicts: [], events: [] };
let canReview = true, conflict = false, corrected: object | null = null;
let posted: Record<string, unknown>[] = [];
beforeEach(() => {
  canReview = true; conflict = false; corrected = null; posted = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, options?: RequestInit) => {
    const url = new URL(input, "https://fixture.test");
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)); posted.push(body);
      if (conflict) return Response.json({ error: "El registro ha cambiado. Actualiza la lista antes de revisarlo." }, { status: 409 });
      corrected = { ...original, id: nextId, status: "confirmed", content: body.content,
        correction: { previousRecordId: id, previousRevision: 1, previousContent: original.content, reason: body.reason } };
      return Response.json({ available: true, record: corrected });
    }
    if (!url.searchParams.has("scope")) return Response.json({ scopes: [{ scope: "company", scopeId: null, label: "Empresa", canReview }] });
    return Response.json({ available: true, connectionId: "arnall", records: url.searchParams.get("status") === "confirmed" ? corrected ? [corrected] : [] : corrected ? [] : [original], nextCursor: null });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function openEditor() {
  render(<KnowledgeReviewPanel projectId={id} />);
  fireEvent.click(screen.getByRole("button", { name: "Revisar propuestas" }));
  fireEvent.click(await screen.findByRole("button", { name: "Corregir" }));
}
describe("source-backed correction editor", () => {
  it("requires a changed statement and reason, then shows the preserved history", async () => {
    await openEditor();
    const save = screen.getByRole("button", { name: "Guardar y confirmar corrección" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Texto corregido"), { target: { value: "Coordina el proyecto de prueba." } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Motivo de la corrección"), { target: { value: "Precisar la función según la cita." } });
    fireEvent.click(save);
    await screen.findByText(/Corrección guardada y confirmada/);
    expect(posted[0]).toMatchObject({ recordId: id, revision: 1, decision: "correct", content: "Coordina el proyecto de prueba.", reason: "Precisar la función según la cita." });
    expect(posted[0]).not.toHaveProperty("actorId"); expect(posted[0]).not.toHaveProperty("citations");
    fireEvent.change(screen.getByLabelText("Estado del conocimiento"), { target: { value: "confirmed" } });
    await screen.findByText("Texto anterior");
    expect(screen.getByText(original.content)).toBeTruthy();
    expect(screen.getByText("Precisar la función según la cita.")).toBeTruthy();
  });
  it("keeps edits after a revision conflict and requires an explicit refresh", async () => {
    conflict = true; await openEditor();
    fireEvent.change(screen.getByLabelText("Texto corregido"), { target: { value: "Texto corregido" } });
    fireEvent.change(screen.getByLabelText("Motivo de la corrección"), { target: { value: "Matiz" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar y confirmar corrección" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Texto corregido") as HTMLTextAreaElement).value).toBe("Texto corregido");
    fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
    await waitFor(() => expect(screen.queryByLabelText("Texto corregido")).toBeNull());
  });
  it("does not offer corrections without review capability", async () => {
    canReview = false; render(<KnowledgeReviewPanel projectId={id} />);
    fireEvent.click(screen.getByRole("button", { name: "Revisar propuestas" }));
    await screen.findByText("Tienes acceso de lectura a este ámbito.");
    expect(screen.queryByRole("button", { name: "Corregir" })).toBeNull();
    expect(posted).toHaveLength(0);
  });
});
