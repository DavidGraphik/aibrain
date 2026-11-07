// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentPreviewPanel } from "@/components/document-preview-panel";
import { AuthenticatedSpreadsheetPreview, SpreadsheetTable } from "@/components/authenticated-spreadsheet-preview";
import { isSpreadsheetPreview, type SpreadsheetPreview } from "@/documents/spreadsheet-preview";

const preview: SpreadsheetPreview = { schemaVersion: 1, kind: "spreadsheet", truncated: false, sheets: [
  { name: "S’Agaró", hidden: false, cells: [{ address: "A1", value: "<script>unsafe()</script>" }, { address: "C3", value: "09:00" }] },
  { name: "Torre", hidden: true, cells: [{ address: "B9", value: "17:00" }] },
] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("opens a populated visible sheet instead of a hidden template", () => {
  render(<SpreadsheetTable preview={{ ...preview, sheets: [preview.sheets[1], preview.sheets[0]] }} />);
  const sheetPicker = screen.getByRole("combobox", { name: "Hoja del libro" });
  expect(sheetPicker).toHaveValue("1");
  expect(sheetPicker).not.toHaveClass("sr-only");
  expect(sheetPicker.closest("label")).not.toHaveClass("sr-only");
  expect(screen.getByRole("cell", { name: "09:00" })).toBeInTheDocument();
});

it("opens a spreadsheet inside the document panel with escaped values and sheet navigation", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(preview), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  render(<DocumentPreviewPanel artifact={{ id: "00000000-0000-4000-8000-000000000099", type: "document", name: "Horaris.xlsm",
    kind: "text", mimeType: "application/json", size: 500, status: "ready", pages: null, previewFormat: "spreadsheet",
    url: "/api/projects/test/files?download=1", previewUrl: "/api/projects/test/files?download=1",
    publicationStatus: null, publicationError: null, targetLabel: null, error: null }} onClose={vi.fn()} />);
  expect(await screen.findByRole("cell", { name: "09:00" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "<script>unsafe()</script>" })).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByRole("columnheader", { name: "C" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Descargar datos de la vista previa" })).toHaveAttribute("download", "Horaris.xlsm.preview.json");
  fireEvent.change(screen.getByRole("combobox", { name: "Hoja del libro" }), { target: { value: "1" } });
  expect(screen.getByRole("cell", { name: "17:00" })).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/projects/"), expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
});

it("opens a generated XLSX in the private grid and keeps its original download", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(preview), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  render(<DocumentPreviewPanel artifact={{ id: "00000000-0000-4000-8000-000000000099", type: "document", name: "Resultat.xlsx",
    kind: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 500, status: "ready", pages: null,
    url: "/api/threads/test/artifacts/file?download=1", previewUrl: "/api/threads/test/artifacts/file?preview=1",
    publicationStatus: null, publicationError: null, targetLabel: null, error: null }} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Datos" }));
  expect(await screen.findByRole("cell", { name: "09:00" })).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith("/api/threads/test/artifacts/file?grid=1", expect.any(Object));
  expect(screen.getByRole("link", { name: "Descargar Resultat.xlsx" })).toHaveAttribute("href", "/api/threads/test/artifacts/file?download=1");
});

it("starts a generated XLSX in the formatted page view", async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { "Content-Type": "image/png", "X-Document-Page-Count": "2" },
  }));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:formatted-workbook", revokeObjectURL: vi.fn() });
  render(<DocumentPreviewPanel artifact={{ id: "00000000-0000-4000-8000-000000000098", type: "document", name: "Informe.xlsx",
    kind: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 500, status: "ready", pages: null,
    url: "/api/threads/test/artifacts/file?download=1", previewUrl: "/api/threads/test/artifacts/file?preview=1",
    publicationStatus: null, publicationError: null, targetLabel: null, error: null }} onClose={vi.fn()} />);
  const first = await screen.findByRole("img", { name: "Documento Informe.xlsx, página 1" });
  expect(first).toHaveAttribute("src", "blob:formatted-workbook");
  fireEvent.load(first);
  expect(screen.queryByRole("status")).toBeNull();
  expect(document.querySelector("iframe")).toBeNull();
  expect(screen.getByText("Excel · vista con formato")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith("/api/threads/test/artifacts/file?preview=1&page=1", expect.objectContaining({ credentials: "same-origin", headers: { Accept: "image/png" } }));
});

it("recovers from an unavailable route", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("denied", { status: 403 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(preview), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  render(<AuthenticatedSpreadsheetPreview previewUrl="/api/projects/test/files" />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
  expect(await screen.findByRole("cell", { name: "09:00" })).toBeInTheDocument();
});

it.each(["x".repeat(100001), JSON.stringify({ ...preview, sheets: [] }), JSON.stringify({ ...preview,
  sheets: [{ ...preview.sheets[0], cells: [{ address: "A1", value: "one" }, { address: "A1", value: "two" }] }],
})])("rejects oversized and malformed response data", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "Content-Type": "application/json" } })));
  render(<AuthenticatedSpreadsheetPreview previewUrl="/api/projects/test/files" />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("never fetches external preview URLs", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<AuthenticatedSpreadsheetPreview previewUrl="https://invalid.test/private" />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("bounds the DOM and exposes partial and empty states", () => {
  render(<SpreadsheetTable preview={{ ...preview, truncated: true, sheets: [
    { name: "Large", hidden: false, cells: Array.from({ length: 120 }, (_, i) => ({ address: `A${i + 1}`, value: `Value ${i + 1}` })) },
    { name: "Empty", hidden: false, cells: [] },
  ] }} />);
  expect(screen.getAllByRole("cell")).toHaveLength(50);
  expect(screen.getByRole("status")).toHaveTextContent("Vista parcial");
  fireEvent.click(screen.getByRole("button", { name: "Más filas" }));
  expect(screen.getByRole("cell", { name: "Value 51" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "1" } });
  expect(screen.getByText(/No se han incluido valores/)).toBeInTheDocument();
});

it("reports incompleteness for the selected sheet rather than other sheets", () => {
  render(<SpreadsheetTable preview={{ ...preview, truncated: true, sheets: [
    { name: "Partial", hidden: false, truncated: true, cells: [{ address: "A1", value: "Partial value" }] },
    { name: "Summary", hidden: false, truncated: false, cells: [{ address: "A1", value: "Complete summary" }] },
    { name: "Empty", hidden: false, truncated: false, cells: [] },
    { name: "Omitted", hidden: false, truncated: true, cells: [] },
  ] }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Vista parcial");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "1" } });
  expect(screen.getByRole("cell", { name: "Complete summary" })).toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "2" } });
  expect(screen.getByText("No hay celdas con valores en esta hoja.")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "3" } });
  expect(screen.getByText(/No se han incluido valores/)).toBeInTheDocument();
  expect(screen.queryByText(/No hay celdas/)).not.toBeInTheDocument();
});

it("validates per-sheet completeness metadata while accepting legacy previews", () => {
  expect(isSpreadsheetPreview(preview)).toBe(true);
  expect(isSpreadsheetPreview({ ...preview, sheets: [{ ...preview.sheets[0], truncated: false }] })).toBe(true);
  expect(isSpreadsheetPreview({ ...preview, sheets: [{ ...preview.sheets[0], truncated: "false" }] })).toBe(false);
});
