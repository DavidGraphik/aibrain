// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentPreviewPanel } from "@/components/document-preview-panel";
import type { DocumentArtifact } from "@/lib/chat-contract";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const artifact: DocumentArtifact = {
  id: "018f5f68-4a6e-7abc-8def-0123456789ae",
  type: "document",
  name: "informe-precios.pdf",
  url: "/api/projects/project/files?path=informe.pdf&raw=1&download=1",
  kind: "pdf",
  mimeType: "application/pdf",
  size: 4096,
  status: "ready",
  pages: 4,
  previewUrl: "/api/projects/project/files?path=informe.pdf&raw=1",
  publicationStatus: null,
  publicationError: null,
  targetLabel: null,
  error: null,
};

function MobilePreviewHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Abrir documento</button>
      {open ? <DocumentPreviewPanel artifact={artifact} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

describe("DocumentPreviewPanel", () => {
  it("resets a failed preview when selecting another document", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL: () => "blob:second", revokeObjectURL: vi.fn() });
    const { rerender } = render(<DocumentPreviewPanel artifact={artifact} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No se ha podido mostrar el PDF");
    rerender(<DocumentPreviewPanel artifact={{ ...artifact, id: "second", name: "second.pdf", previewUrl: "/api/projects/project/files?path=second.pdf&raw=1" }} onClose={vi.fn()} />);
    expect(await screen.findByTitle("Documento second.pdf")).toHaveAttribute("src", "blob:second");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("previews the private PDF blob and keeps download and close actions available", async () => {
    const onClose = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("%PDF-1.7\\n%%EOF", {
      headers: { "Content-Length": "14", "Content-Type": "application/pdf" },
    })));
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:https://brain.example/document"), revokeObjectURL: vi.fn() });
    render(<DocumentPreviewPanel artifact={artifact} onClose={onClose} />);

    expect(screen.getByRole("complementary", { name: "Vista previa de informe-precios.pdf" })).toBeInTheDocument();
    expect(await screen.findByTitle("Documento informe-precios.pdf")).toHaveAttribute("src", "blob:https://brain.example/document");
    expect(screen.getByRole("link", { name: "Descargar informe-precios.pdf" })).toHaveAttribute("href", artifact.url);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar vista previa" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not leave an unavailable PDF in an endless loading state", () => {
    render(<DocumentPreviewPanel artifact={{ ...artifact, previewUrl: null }} onClose={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("No se ha podido mostrar el PDF");
    expect(screen.queryByRole("status", { name: "Cargando vista previa del PDF" })).not.toBeInTheDocument();
  });

  it("renders a text document as escaped authenticated text instead of an iframe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<script>unsafe()</script>\nVisible text", {
      headers: { "Content-Length": "37", "Content-Type": "text/plain" },
    })));
    render(<DocumentPreviewPanel artifact={{
      ...artifact,
      kind: "text",
      mimeType: "text/plain",
      name: "notes.txt",
      previewUrl: "/api/threads/thread/documents/upload/preview/preview.txt",
    }} onClose={vi.fn()} />);

    expect(await screen.findByLabelText("Documento notes.txt")).toHaveTextContent("<script>unsafe()</script>");
    expect(screen.queryByTitle("Documento notes.txt")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Descargar notes.txt" })).toBeInTheDocument();
  });

  it("behaves as a focus-managed modal on mobile and restores its opener", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("%PDF-1.7\\n%%EOF", {
      headers: { "Content-Length": "14", "Content-Type": "application/pdf" },
    })));
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:https://brain.example/document"), revokeObjectURL: vi.fn() });
    render(<MobilePreviewHarness />);

    const opener = screen.getByRole("button", { name: "Abrir documento" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole("dialog", { name: "Vista previa de informe-precios.pdf" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(screen.getByRole("button", { name: "Cerrar vista previa" })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vista previa de informe-precios.pdf" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("offers persisted page navigation, zoom and document-only fullscreen", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), {
      headers: { "Content-Type": "image/png", "Content-Length": "5" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:page"), revokeObjectURL: vi.fn() });
    render(<DocumentPreviewPanel artifact={{
      ...artifact,
      id: "00000000-0000-4000-8000-000000000099",
      pages: 3,
      previewUrl: "/api/threads/00000000-0000-4000-8000-000000000013/artifacts/00000000-0000-4000-8000-000000000099?preview=1",
      url: "/api/threads/00000000-0000-4000-8000-000000000013/artifacts/00000000-0000-4000-8000-000000000099?download=1",
    }} onClose={vi.fn()} />);

    const first = await screen.findByRole("img", { name: "Documento informe-precios.pdf, página 1" });
    fireEvent.load(first);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("page=1"), expect.objectContaining({ credentials: "same-origin" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Página siguiente" })[0]!);
    expect(await screen.findByRole("img", { name: "Documento informe-precios.pdf, página 2" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("page=2"), expect.anything());
    fireEvent.click(screen.getAllByRole("button", { name: "Acercar" })[0]!);
    expect(screen.getAllByText("125%").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Pantalla completa" }));
    expect(screen.getByRole("dialog")).toHaveClass("xl:fixed");
    expect(screen.getByRole("link", { name: "Descargar informe-precios.pdf" })).toHaveAttribute("href", expect.stringContaining("/api/threads/"));
  });
  it.each(["pdf", "docx", "pptx", "xlsx"] as const)("renders historic %s deliveries without stored page counts", async (kind) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "Content-Type": "image/png", "X-Document-Page-Count": "3" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:page"), revokeObjectURL: vi.fn() });
    render(<DocumentPreviewPanel artifact={{ ...artifact, kind, pages: null,
      previewUrl: "/api/threads/thread/artifacts/artifact?preview=1",
    }} onClose={vi.fn()} />);
    const first = await screen.findByRole("img", { name: "Documento informe-precios.pdf, página 1" });
    fireEvent.load(first);
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getAllByText("1 / 3")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Navegación del documento" }).closest("header")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Página siguiente" })[0]!);
    expect(await screen.findByRole("img", { name: "Documento informe-precios.pdf, página 2" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("page=2"), expect.anything());
  });

  it("switches a generated workbook between rendered pages and data without a native PDF plugin", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => url.includes("grid=1")
      ? new Response(JSON.stringify({ schemaVersion: 1, kind: "spreadsheet", truncated: false,
        sheets: [{ name: "Inventario", hidden: false, cells: [{ address: "A1", value: "Producto de prueba" }] }],
      }), { headers: { "Content-Type": "application/json" } })
      : new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png", "X-Document-Page-Count": "2" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL: () => "blob:workbook-page", revokeObjectURL: vi.fn() });
    render(<DocumentPreviewPanel artifact={{ ...artifact, kind: "xlsx", name: "Inventario.xlsx", pages: null,
      previewUrl: "/api/threads/thread/artifacts/inventory?preview=1",
    }} onClose={vi.fn()} />);
    fireEvent.load(await screen.findByRole("img", { name: "Documento Inventario.xlsx, página 1" }));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Página siguiente" })[0]!);
    fireEvent.load(await screen.findByRole("img", { name: "Documento Inventario.xlsx, página 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Datos" }));
    expect(await screen.findByRole("cell", { name: "Producto de prueba" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Página siguiente" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Formato" }));
    fireEvent.load(await screen.findByRole("img", { name: "Documento Inventario.xlsx, página 2" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("preview=1&page=2"),
      expect.objectContaining({ credentials: "same-origin", headers: { Accept: "image/png" } }));
  });

  it("keeps document shortcuts local to the preview, leaving composer editing alone", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "Content-Type": "image/png", "X-Document-Page-Count": "3" },
    })));
    vi.stubGlobal("URL", { createObjectURL: () => "blob:page", revokeObjectURL: vi.fn() });
    render(<><textarea aria-label="Mensaje" /><DocumentPreviewPanel artifact={{ ...artifact,
      previewUrl: "/api/threads/thread/artifacts/artifact?preview=1",
    }} onClose={vi.fn()} /></>);
    await screen.findByRole("img");
    const composer = screen.getByRole("textbox", { name: "Mensaje" });
    composer.focus();
    fireEvent.keyDown(composer, { key: "-" });
    fireEvent.keyDown(composer, { key: "ArrowRight" });
    expect(screen.getAllByText("100%")).toHaveLength(1);
    expect(screen.getAllByText("1 / 3")).toHaveLength(1);
    const page = screen.getByLabelText("Documento informe-precios.pdf, página 1", { selector: "div" });
    page.focus();
    fireEvent.keyDown(page, { key: "-", ctrlKey: true });
    expect(screen.getAllByText("100%")).toHaveLength(1);
    fireEvent.keyDown(page, { key: "-" });
    expect(screen.getAllByText("75%")).toHaveLength(1);
    fireEvent.keyDown(page, { key: "ArrowRight" });
    expect(await screen.findByRole("img", { name: "Documento informe-precios.pdf, página 2" })).toBeInTheDocument();
  });

  it("contains desktop fullscreen focus and Escape restores the fullscreen opener", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } })));
    vi.stubGlobal("URL", { createObjectURL: () => "blob:pdf", revokeObjectURL: vi.fn() });
    const onClose = vi.fn();
    render(<><button>Outside</button><DocumentPreviewPanel artifact={artifact} onClose={onClose} /></>);
    const opener = screen.getByRole("button", { name: "Pantalla completa" });
    opener.focus();
    fireEvent.click(opener);
    expect(await screen.findByRole("dialog")).toHaveAttribute("aria-modal", "true");
    const close = screen.getByRole("button", { name: "Cerrar vista previa" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(close, { key: "Tab" });
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

});
