// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedPdfPreview } from "@/components/authenticated-pdf-preview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuthenticatedPdfPreview", () => {
  it("fetches an authenticated same-origin PDF into a revocable blob instead of framing the protected route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("%PDF-1.7\\n%%EOF", {
      headers: { "Content-Length": "14", "Content-Type": "application/pdf" },
    }));
    const createObjectURL = vi.fn(() => "blob:https://brain.example/private-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    const { unmount } = render(<AuthenticatedPdfPreview
      previewUrl="/api/projects/project/files?path=report.pdf&raw=1"
      title="Documento report.pdf"
      className="h-full w-full"
    />);

    const frame = await screen.findByTitle("Documento report.pdf");
    expect(frame).toHaveAttribute("src", "blob:https://brain.example/private-preview");
    // Chromium treats its native PDF viewer as a plugin and blocks it in every
    // sandboxed iframe. The frame may omit sandbox only because its source is
    // the validated, bounded, revocable blob produced above, never the private
    // API route or an arbitrary URL.
    expect(frame).not.toHaveAttribute("sandbox");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project/files?path=report.pdf&raw=1",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
    fireEvent.load(frame);
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:https://brain.example/private-preview");
  });

  it("rejects non-PDF or non-API preview URLs before they can be framed", async () => {
    const onError = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthenticatedPdfPreview
      previewUrl="https://untrusted.example/report.pdf"
      title="Documento no fiable"
      className="h-full w-full"
      onError={onError}
    />);

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Documento no fiable")).toBeNull();
  });

  it("does not turn an authenticated HTML response into a frame", async () => {
    const onError = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<script>alert(1)</script>", {
      headers: { "Content-Type": "text/html" },
    })));

    render(<AuthenticatedPdfPreview
      previewUrl="/api/projects/project/files?path=report.pdf&raw=1"
      title="Documento inválido"
      className="h-full w-full"
      onError={onError}
    />);

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(screen.queryByTitle("Documento inválido")).toBeNull();
  });
});
