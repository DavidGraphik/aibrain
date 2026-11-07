import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreRequestDocument } from "./restore-request-documents";

const threadId = "018f5f68-4a6e-7abc-8def-0123456789ab";
const attachment = { id: "018f5f68-4a6e-7abc-8def-0123456789ac", name: "informe.pdf", mimeType: "application/pdf", size: 2048 };
const originalVersionId = "018f5f68-4a6e-7abc-8def-0123456789ad";
const original = { versionId: originalVersionId, fileName: attachment.name, kind: "pdf", mediaType: attachment.mimeType, size: attachment.size,
  previewUrl: `/api/threads/${threadId}/documents/${attachment.id}/versions/${originalVersionId}/preview/document.pdf` };
const document = { documentId: attachment.id, threadId, originalVersionId, versions: [original, { ...original, versionId: "newer-version", fileName: "nuevo.pdf" }] };
const run = () => restoreRequestDocument(threadId, attachment, new AbortController().signal);
const respond = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));
afterEach(() => vi.unstubAllGlobals());

describe("restoreRequestDocument", () => {
  it("reuses the original upload and scoped preview, never the latest revision", async () => {
    respond({ document });
    expect(await run()).toMatchObject({ id: attachment.id, uploadId: attachment.id, threadId, name: attachment.name, status: "ready", previewFiles: [{ name: "document.pdf", url: original.previewUrl }] });
    expect(fetch).toHaveBeenCalledWith(`/api/threads/${threadId}/documents/${attachment.id}`, expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
  });
  it.each([401, 403, 404, 503])("keeps unavailable attachments explicit after HTTP %i", async (status) => {
    respond({}, status);
    expect(await run()).toMatchObject({ ...attachment, status: "error", previewFiles: [] });
  });
  it.each([
    { ...document, threadId: "foreign-thread" },
    { ...document, documentId: "foreign-document" },
    { ...document, versions: [{ ...original, size: 9999 }] },
    { ...document, versions: [{ ...original, fileName: "newer.pdf" }] },
    { ...document, versions: [{ ...original, previewUrl: "https://example.test/private.pdf" }] },
    { ...document, versions: [{ ...original, previewUrl: original.previewUrl + "?path=secret" }] },
  ])("rejects changed identity, metadata or preview scope", async (invalid) => {
    respond({ document: invalid });
    expect(await run()).toMatchObject({ ...attachment, status: "error", previewFiles: [] });
  });
});
