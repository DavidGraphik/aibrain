import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { StorageError } from "@/storage";
import { LibraryResourceForbiddenError } from "@/library/server-resource-access";
import { GET as originalPreview } from "@/app/api/threads/[threadId]/documents/[uploadId]/preview/[fileName]/route";
import { GET as versionPreview } from "@/app/api/threads/[threadId]/documents/[uploadId]/versions/[versionId]/preview/[fileName]/route";

const threadId = "0198b9f0-6631-7000-8000-000000000101";
const uploadId = "0198b9f0-6631-7000-8000-000000000102";
const versionId = "0198b9f0-6631-7000-8000-000000000103";
const contentUploadId = "0198b9f0-6631-7000-8000-000000000104";
const fixture = vi.hoisted(() => ({
  session: null as AuthSession | null,
  services: vi.fn(), resolve: vi.fn(), staged: vi.fn(), versions: vi.fn(), create: vi.fn(), readFile: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: async () => fixture.session }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ installationId: "preview-qa" }) }));
vi.mock("@/documents/server-service", () => ({ documentServicesForUser: (...args: unknown[]) => fixture.services(...args) }));
vi.mock("@/library/server-resource-access", async original => ({
  ...await original<typeof import("@/library/server-resource-access")>(),
  resolveThreadLibraryResource: (...args: unknown[]) => fixture.resolve(...args),
}));

const bytes = Buffer.from([0, 255, 128, 13, 10, 65]);
const staged = { fileName: "original.pdf", kind: "pdf", mediaType: "application/pdf", size: 6, sha256: "a".repeat(64), relativePath: "private/original.pdf" };
const variants = [
  { name: "original", get: originalPreview },
  { name: "versioned", get: versionPreview },
] as const;
function call(get: typeof originalPreview | typeof versionPreview, fileName = "document.pdf", request = new Request("http://localhost/preview")) {
  return get(request, { params: Promise.resolve({ threadId, uploadId, versionId, fileName }) });
}
beforeEach(() => {
  vi.resetAllMocks();
  fixture.session = { provider: "local", user: { id: "owner", email: "owner@example.test", name: "Owner" }, tenant: { id: "preview-qa", name: "QA" }, expiresAt: "2030-01-01T00:00:00Z" };
  fixture.resolve.mockResolvedValue({ location: { ...staged, storageOwnerId: "owner" } });
  fixture.services.mockResolvedValue({ staging: { readById: fixture.staged }, versions: { read: fixture.versions }, previews: { create: fixture.create, readFile: fixture.readFile } });
  fixture.staged.mockResolvedValue(staged);
  fixture.versions.mockResolvedValue({ versions: [{ ...staged, versionId, contentUploadId }] });
  fixture.create.mockResolvedValue(undefined);
  fixture.readFile.mockResolvedValue(bytes);
});

describe.each(variants)("$name preview route compatibility", ({ name, get }) => {
  it.each([
    ["document.pdf", "application/pdf", "pdf", "original.pdf"],
    ["preview.png", "image/png", "image", "original.png"],
    ["preview.jpg", "image/jpeg", "image", "original.jpg"],
    ["preview.jpeg", "image/jpeg", "image", "original.jpeg"],
    ["preview.gif", "image/gif", "image", "original.gif"],
    ["preview.webp", "image/webp", "image", "original.webp"],
    ["preview.txt", "text/plain; charset=utf-8", "text", "original.txt"],
  ])("preserves exact bytes and headers for %s", async (fileName, mediaType, kind, originalFileName) => {
    const source = { ...staged, kind, fileName: originalFileName };
    fixture.resolve.mockResolvedValue({ location: { ...source, storageOwnerId: "owner" } });
    fixture.staged.mockResolvedValue(source);
    fixture.versions.mockResolvedValue({ versions: [{ ...source, versionId, contentUploadId }] });
    const response = await call(get, fileName);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(Object.fromEntries(response.headers)).toEqual({
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${fileName}"`,
      "content-length": "6",
      "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "content-type": mediaType,
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    expect(fixture.resolve.mock.invocationCallOrder[0]).toBeLessThan(fixture.services.mock.invocationCallOrder[0]);
    expect(fixture.staged.mock.invocationCallOrder[0]).toBeLessThan(fixture.create.mock.invocationCallOrder[0]);
    expect(fixture.create.mock.invocationCallOrder[0]).toBeLessThan(fixture.readFile.mock.invocationCallOrder[0]);
    expect(fixture.readFile).toHaveBeenCalledWith(threadId, name === "original" ? uploadId : contentUploadId, fileName);
  });

  it("rejects unauthenticated, invalid and foreign-tenant requests before resolving or repairing", async () => {
    fixture.session = null;
    const anonymous = await call(get);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: name === "original" ? "No autenticat." : "No autenticado." });
    fixture.session = { provider: "local", user: { id: "owner", email: "owner@example.test", name: "Owner" }, tenant: { id: "other", name: "Other" }, expiresAt: "2030-01-01T00:00:00Z" };
    expect((await call(get, "../private.pdf")).status).toBe(400);
    expect((await call(get)).status).toBe(403);
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.services).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("keeps rejected access ahead of all service or cache work", async () => {
    fixture.resolve.mockRejectedValue(new Error("denied"));
    expect((await call(get)).status).toBe(name === "original" ? 503 : 404);
    expect(fixture.services).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("preserves an explicit permission denial and its message", async () => {
    fixture.resolve.mockRejectedValue(new LibraryResourceForbiddenError("Access revoked"));
    const response = await call(get);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Access revoked" });
    expect(fixture.services).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("rejects source drift without repairing or reading cached bytes", async () => {
    fixture.staged.mockResolvedValue({ ...staged, sha256: "b".repeat(64) });
    expect((await call(get)).status).toBe(409);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.readFile).not.toHaveBeenCalled();
  });

  it("propagates the exact request abort signal and keeps aborted conversion failures unchanged", async () => {
    const controller = new AbortController(); controller.abort();
    fixture.create.mockRejectedValue(new StorageError("DOCUMENT_OPERATION_ABORTED", "aborted"));
    const request = new Request("http://localhost/preview", { signal: controller.signal });
    const response = await call(get, "document.pdf", request);
    expect(fixture.create).toHaveBeenCalledWith(staged, { signal: request.signal });
    expect(response.status).toBe(name === "original" ? 503 : 404);
    expect(fixture.readFile).not.toHaveBeenCalled();
  });

  it("preserves the missing preview response", async () => {
    fixture.readFile.mockRejectedValue(new StorageError("DOCUMENT_PREVIEW_FILE_NOT_FOUND", "missing"));
    expect((await call(get)).status).toBe(404);
  });
});
