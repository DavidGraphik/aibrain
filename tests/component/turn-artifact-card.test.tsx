// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnArtifactCard } from "@/components/turn-artifact-card";
import type { DocumentArtifact } from "@/lib/chat-contract";

afterEach(cleanup);

const documentArtifact: DocumentArtifact = {
  id: "018f5f68-4a6e-7abc-8def-0123456789ae",
  type: "document",
  name: "informe.pdf",
  url: "/api/projects/project/artifacts/document",
  kind: "pdf",
  mimeType: "application/pdf",
  size: 2048,
  status: "ready",
  pages: 3,
  previewUrl: "/api/projects/project/artifacts/document/preview/1",
  publicationStatus: "awaiting_confirmation",
  publicationError: null,
  targetLabel: "Informes/informe.pdf",
  error: null,
};

describe("TurnArtifactCard", () => {
  it("shows a safe Office/PDF preview and an honest publication state", () => {
    const onPreview = vi.fn();
    render(<TurnArtifactCard artifact={documentArtifact} onPreviewDocument={onPreview} />);
    expect(screen.getByRole("heading", { name: "informe.pdf" })).toBeInTheDocument();
    screen.getByRole("button", { name: "Previsualizar informe.pdf" }).click();
    expect(onPreview).toHaveBeenCalledWith(documentArtifact);
    expect(screen.getByRole("button", { name: "Revisar antes de descargar" })).toBeInTheDocument();
    expect(screen.getByText("Pendiente de confirmación segura")).toBeInTheDocument();
    expect(screen.getByText("Informes/informe.pdf")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Descargar informe.pdf" })).toHaveAttribute("href", documentArtifact.url);
  });

  it("announces document conversion errors", () => {
    render(<TurnArtifactCard artifact={{ ...documentArtifact, status: "error", previewUrl: null, publicationStatus: null, error: "El PDF está cifrado." }} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("El PDF está cifrado.");
    expect(alert).toHaveClass("text-body-2-medium");
  });

  it.each([
    ["docx", "DOCX"],
    ["xlsx", "XLSX"],
    ["pptx", "PPTX"],
  ] as const)("shows %s metadata after server-side conversion", (kind, label) => {
    render(<TurnArtifactCard artifact={{ ...documentArtifact, kind, name: `informe.${kind}`, pages: 1 }} />);
    expect(screen.getByText(new RegExp(`^${label} ·`))).toBeInTheDocument();
    expect(screen.getByText("Vista previa ›")).toBeInTheDocument();
    expect(screen.getByText(new RegExp("1 página$"))).toBeInTheDocument();
  });

  it.each([
    ["publishing", "Publicando…"],
    ["published", "Publicado y versionado"],
    ["declined", "Publicación rechazada"],
    ["conflict", "Conflicto: el original ha cambiado"],
  ] as const)("shows the %s publication lifecycle state", (publicationStatus, label) => {
    render(<TurnArtifactCard artifact={{ ...documentArtifact, publicationStatus }} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("announces publication failures without claiming success", () => {
    render(<TurnArtifactCard artifact={{ ...documentArtifact, publicationStatus: null, publicationError: "No se ha podido publicar." }} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("No se ha podido publicar.");
    expect(alert).toHaveClass("text-body-2-medium");
  });

  it("renders a generated image through the image generation component", async () => {
    render(<TurnArtifactCard artifact={{
      id: "018f5f68-4a6e-7abc-8def-0123456789ad",
      type: "image",
      name: "diagrama.png",
      url: "/api/projects/project/artifacts/image",
      prompt: "Un diagrama verificable",
    }} />);

    expect(document.querySelector("[data-slot='image-generation']")).toBeInTheDocument();
    const image = screen.getByRole("img", { name: "Un diagrama verificable" });
    expect(new URL(image.getAttribute("src")!, window.location.href).pathname).toBe("/api/projects/project/artifacts/image");
    expect(image).toHaveClass("object-contain");
    expect(image).not.toHaveClass("object-cover");
    fireEvent.load(image);
    await waitFor(() => expect(screen.queryByText("Cargando imagen…")).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Descargar diagrama.png" })).toHaveAttribute("href", "/api/projects/project/artifacts/image?download=1");
    expect(screen.queryByRole("button", { name: "Volver a generar la imagen" })).not.toBeInTheDocument();
  });

  it("recovers the same private preview without requesting another generation", async () => {
    render(<TurnArtifactCard artifact={{ id: "image", type: "image", name: "diagrama.png", url: "/api/projects/project/artifacts/image", prompt: "Diagrama" }} />);
    fireEvent.error(screen.getByRole("img", { name: "Diagrama" }));
    expect(screen.getByRole("alert")).toHaveTextContent("No se ha podido cargar la imagen");
    expect(screen.queryByRole("link", { name: "Descargar diagrama.png" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Volver a cargar" }));
    const image = screen.getByRole("img", { name: "Diagrama" });
    expect(new URL(image.getAttribute("src")!, window.location.href).pathname).toBe("/api/projects/project/artifacts/image");
    fireEvent.load(image);
    await waitFor(() => expect(screen.getByRole("link", { name: "Descargar diagrama.png" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /generar/i })).not.toBeInTheDocument();
  });

  it.each(["starting", "ready", "active", "reconnecting", "disconnected", "closed", "error"] as const)("reads a historical %s browser artifact without live controls or dead links", status => {
    render(<TurnArtifactCard artifact={{
      id: "018f5f68-4a6e-7abc-8def-0123456789af", type: "browser", name: "Comprobación web histórica",
      status, control: "employee",
      viewerUrl: "/api/browser/sessions/018f5f68-4a6e-7abc-8def-0123456789af/viewer",
      captureUrl: null,
      downloadUrl: "/api/browser/sessions/018f5f68-4a6e-7abc-8def-0123456789af/download",
      error: status === "error" ? "Error original conservado" : null,
    }} />);
    expect(screen.getByText("Comprobación web histórica")).toBeInTheDocument();
    expect(screen.getByText("Registro histórico")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    if (status === "error") expect(screen.getByText("Error original conservado")).toBeInTheDocument();
  });
});
