// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReviewPanel } from "@/components/knowledge-review-panel";
const projectId = "10000000-0000-4000-8000-000000000001";
const record = { id: "20000000-0000-4000-8000-000000000001", kind: "fact", label: "Proyecto ficticio", topic: "Revisión", content: "La revisión es semanal.", status: "proposed", revision: 1,
  citations: [{ source: "Y:\\example.txt", sha256: "a".repeat(64), locator: "line:1", quote: "Review weekly.", path: "knowledge-example" }], conflicts: [], events: [] };
const scopes = [{ scope: "company", scopeId: null, label: "Empresa", canReview: true }];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("document knowledge review", () => {
  it("loads on explicit opening and sends only record version/decision, never actor permissions", async () => {
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") return Response.json({ available: true, record: { ...record, status: "confirmed", revision: 2 } });
      return Response.json(_url.includes("scope=") ? { available: true, connectionId: "arnall", records: [record], nextCursor: null } : { scopes });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<KnowledgeReviewPanel projectId={projectId} />);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revisar propuestas" }));
    expect(await screen.findByText(record.content)).toBeVisible();
    expect(screen.getByText("Review weekly.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
    const sent = fetcher.mock.calls.find(([, options]) => options?.method === "POST")![1]!;
    expect(JSON.parse(String(sent.body))).toEqual({ projectId, scope: "company", scopeId: null, connectionId: "arnall", recordId: record.id, revision: 1, decision: "confirm" });
  });
  it("keeps unavailable indexes distinct from empty pages and hides old data after reopening", async () => {
    let unavailable = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("scope=") ? unavailable ? { available: false } : { available: true, connectionId: "arnall", records: [record], nextCursor: null } : { scopes })));
    render(<KnowledgeReviewPanel projectId={projectId} />);
    fireEvent.click(screen.getByRole("button", { name: "Revisar propuestas" }));
    await screen.findByText(record.content);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar revisión" }));
    unavailable = true;
    fireEvent.click(screen.getByRole("button", { name: "Revisar propuestas" }));
    expect(screen.queryByText(record.content)).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("índice de este ámbito no está disponible");
    expect(screen.queryByText(/No hay registros disponibles/)).not.toBeInTheDocument();
  });
  it("offers no mutation controls for a read-only scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("scope=") ? { available: true, connectionId: "arnall", records: [record], nextCursor: null } : { scopes: [{ ...scopes[0], canReview: false }] })));
    render(<KnowledgeReviewPanel projectId={projectId} />);
    fireEvent.click(screen.getByRole("button", { name: "Revisar propuestas" }));
    await screen.findByText(record.content);
    expect(screen.queryByRole("button", { name: "Confirmar" })).not.toBeInTheDocument();
    expect(screen.getByText("Tienes acceso de lectura a este ámbito.")).toBeVisible();
  });
});
