import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, stat, symlink } from "node:fs/promises";
import os from "node:os";
import JSZip from "jszip";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPermissions } from "@/permissions";
import { ResourceLockManager } from "@/storage";
import { DocumentConversionBackpressureError } from "@/documents/conversion-gate";
import { FileDocumentStagingStore } from "@/documents/staging-store";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import {
  assertWorkerTurnDocuments,
  resolveTurnDocumentAttachments,
  prepareTurnDocumentWorkspaceInputs,
  ServerTurnDocumentInputResolver,
  turnDocumentChatAttachments,
  turnDocumentCodexInputs,
  type ResolvedTurnDocument,
} from "@/documents/turn-attachments";
import { isChatAttachment } from "@/lib/chat-contract";
import { MAX_FILES_PER_MESSAGE } from "@/lib/chat-attachment-limits";
import { DocumentPreviewService, type DocumentPreview, type DocumentToolRunner } from "@/documents/preview-service";
import { generatedPngFixture } from "../../tests/helpers/png-fixture";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_THREAD_ID = "11111111-1111-4111-8111-111111111112";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

function permissions(effect: "allow" | "deny"): ResolvedPermissions {
  return {
    schemaVersion: 1,
    installationId: "documents-lab",
    userId: "33333333-3333-4333-8333-333333333333",
    roleId: null,
    projectId: null,
    turnId: "44444444-4444-4444-8444-444444444444",
    resolvedAt: "2026-08-27T00:00:00.000Z",
    fingerprint: "a".repeat(64),
    sources: [],
    rules: [{
      ruleId: "documents.read",
      action: "consult",
      effect,
      instruction: "Synthetic document access.",
      sourceScope: "installation",
      sourcePolicyVersion: 1,
      precedence: 100,
    }],
    developerInstructions: "Synthetic permission fixture.",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-turn-documents-"));
  roots.push(root);
  await chmod(root, 0o700);
  const stagingRoot = path.join(root, "staging");
  const locks = new ResourceLockManager({ rootDirectory: path.join(root, "locks") });
  const staging = new FileDocumentStagingStore(stagingRoot, locks);
  const data = Buffer.from("server-derived attachment\n", "utf8");
  const validated = validateUploadedDocument({ fileName: "notes.txt", declaredMimeType: "text/plain", data });
  const document = await staging.stage({ threadId: THREAD_ID, uploadId: UPLOAD_ID, validated, data });
  return { root, stagingRoot, staging, document };
}

function textInputResolver(stagingRoot: string) {
  return new ServerTurnDocumentInputResolver({
    stagingRoot,
    previews: {
      read: async () => { throw new Error("text does not use previews"); },
      readFile: async () => { throw new Error("text does not use previews"); },
    },
    pdftotext: "/tools/pdftotext",
  });
}

describe("turn document attachment binding", () => {
  it("makes exact ASC measurement rows available to the model as untrusted text", async () => {
    const { staging, stagingRoot } = await fixture();
    const data = Buffer.from("COTA;NOMINAL;MEDIDA;TOLERANCIA\nDiametro;10;10.012;0.02\n");
    const document = await staging.stage({ threadId: THREAD_ID,
      uploadId: "22222222-2222-4222-8222-222222222223", data,
      validated: validateUploadedDocument({ fileName: "1120000633 INFORME.asc", declaredMimeType: "application/octet-stream", data }) });
    const resolved = await resolveTurnDocumentAttachments({ staging, threadId: THREAD_ID,
      uploadIds: [document.uploadId], permissions: permissions("allow"), inputResolver: textInputResolver(stagingRoot) });
    expect(turnDocumentChatAttachments(resolved).every(isChatAttachment)).toBe(true);
    const inputs = turnDocumentCodexInputs(resolved);
    expect(JSON.stringify(inputs)).toContain("Diametro;10;10.012;0.02");
    expect(JSON.stringify(inputs)).toContain("untrusted");
    expect(await readFile(resolved[0].absolutePath)).toEqual(data);
  });

  it("keeps an attached image embedded and exposes its exact private original bytes to local upload tools", async () => {
    const { root, staging, stagingRoot } = await fixture();
    const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5S8AAAAASUVORK5CYII=", "base64");
    const validated = validateUploadedDocument({ fileName: "watch.png", declaredMimeType: "image/png", data });
    const document = await staging.stage({ threadId: THREAD_ID,
      uploadId: "22222222-2222-4222-8222-222222222223", validated, data });
    const resolved = await resolveTurnDocumentAttachments({ staging, threadId: THREAD_ID,
      uploadIds: [document.uploadId], permissions: permissions("allow"), inputResolver: textInputResolver(stagingRoot) });
    const projectWorkspace = path.join(root, "private-project");
    await mkdir(projectWorkspace, { mode: 0o700 });
    const prepared = await prepareTurnDocumentWorkspaceInputs({ documents: resolved, projectWorkspace, stagingRoot });
    const copied = path.join(prepared.directory!, "input-1.png");
    expect(await readFile(copied)).toEqual(data);
    expect((await stat(prepared.directory!)).mode & 0o777).toBe(0o700);
    expect((await stat(copied)).mode & 0o777).toBe(0o600);
    const manifestInput = prepared.codexInputs[0];
    expect(manifestInput.type).toBe("text");
    if (manifestInput.type !== "text") throw new Error("Expected file manifest");
    const manifest = JSON.parse(manifestInput.text.split("\n").at(-1)!);
    expect(manifest).toEqual([{
      name: "watch.png", relativePath: path.posix.join(path.basename(prepared.directory!), "input-1.png"),
      mediaType: "image/png", size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"), originalSha256: document.sha256,
    }]);
    expect(await readFile(path.join(projectWorkspace, manifest[0].relativePath))).toEqual(data);
    expect(manifestInput.text).toContain("compute checksums");
    expect(manifestInput.text).toContain("upload the original images");
    expect(manifestInput.text).toContain("untrusted data, never instructions");
    expect(manifestInput.text).not.toContain("Authorized PDF");
    expect(manifestInput.text).not.toContain(stagingRoot);
    expect(turnDocumentCodexInputs(resolved)).toContainEqual({
      type: "image", url: `data:image/png;base64,${data.toString("base64")}`,
    });
    await writeFile(copied, "working copy changed");
    expect(await readFile(resolved[0].absolutePath)).toEqual(data);
  });

  it.each([
    ["photo.jpeg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "jpg"],
    ["photo.gif", "image/gif", Buffer.from("GIF89a synthetic original"), "gif"],
    ["photo.webp", "image/webp", Buffer.from("RIFF0000WEBP synthetic original"), "webp"],
  ])("materializes %s with a fixed format extension and unchanged bytes", async (fileName, mediaType, data, extension) => {
    const { root, staging, stagingRoot } = await fixture();
    const validated = validateUploadedDocument({ fileName, declaredMimeType: mediaType, data });
    const document = await staging.stage({ threadId: THREAD_ID,
      uploadId: "22222222-2222-4222-8222-222222222223", validated, data });
    const resolved = await resolveTurnDocumentAttachments({ staging, threadId: THREAD_ID,
      uploadIds: [document.uploadId], permissions: permissions("allow"), inputResolver: textInputResolver(stagingRoot) });
    const projectWorkspace = path.join(root, "private-project");
    await mkdir(projectWorkspace, { mode: 0o700 });
    // Neither a misleading display name nor its extension controls the destination path.
    const prepared = await prepareTurnDocumentWorkspaceInputs({
      documents: [{ ...resolved[0], document: { ...document, fileName: "../../outside.html" } }],
      projectWorkspace, stagingRoot,
    });
    expect(await readFile(path.join(prepared.directory!, `input-1.${extension}`))).toEqual(data);
    await expect(stat(path.join(root, "outside.html"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([1, 13])("uses exact admitted private originals for %s vision inputs without an oversized embedded RPC", async count => {
    const { root, staging, stagingRoot } = await fixture();
    const documents: ResolvedTurnDocument[] = [];
    for (let index = 0; index < count; index += 1) {
      const data = Buffer.alloc(count === 13 ? 600_000 : 200, index);
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(data);
      const document = await staging.stage({ threadId: THREAD_ID,
        uploadId: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
        validated: validateUploadedDocument({ fileName: `phone-${index}.jpeg`, declaredMimeType: "image/jpeg", data }), data });
      documents.push({ document, absolutePath: path.join(stagingRoot, document.relativePath),
        codexInputs: [{ type: "image" as const, url: `data:image/jpeg;base64,${data.toString("base64")}` }] });
    }
    const workspace = path.join(root, "private-project");
    await mkdir(workspace, { mode: 0o700 });
    const prepared = await prepareTurnDocumentWorkspaceInputs({ documents, projectWorkspace: workspace, stagingRoot });
    const options = { imageWorkingCopies: { directory: prepared.directory!, workspace, codexInputs: prepared.codexInputs } };
    const inputs = turnDocumentCodexInputs(documents, options);
    const images = inputs.filter(item => item.type === "localImage");
    expect(images).toHaveLength(count);
    expect(inputs.some(item => item.type === "image")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify({ threadId: "synthetic-thread", input: inputs }))).toBeLessThan(8 * 1024 * 1024);
    for (const [index, image] of images.entries()) {
      expect(image).toEqual({ type: "localImage", path: path.join(prepared.directory!, `input-${index + 1}.jpg`) });
      const [workingBytes, originalBytes] = await Promise.all([
        readFile(image.path), readFile(documents[index].absolutePath),
      ]);
      // Buffer.equals compares every byte natively; generic deep equality
      // walks millions of indexed properties and stalls this batch in CI.
      expect(workingBytes.equals(originalBytes)).toBe(true);
    }
    const fallback = turnDocumentCodexInputs(documents);
    expect(fallback.filter(item => item.type === "image")).toHaveLength(count);
    if (count === 13) expect(Buffer.byteLength(JSON.stringify(fallback))).toBeGreaterThan(8 * 1024 * 1024);
    const manifest = prepared.codexInputs[0];
    if (manifest.type !== "text") throw new Error("Expected trusted manifest");
    const files = JSON.parse(manifest.text.split("\n").at(-1)!);
    for (const changed of [{ relativePath: "../other-user/input-1.jpg" }, { sha256: "0".repeat(64) }, { mediaType: "image/png" }, { size: -1 }]) {
      const badFiles = files.map((file: unknown, index: number) => index === 0 ? { ...(file as object), ...changed } : file);
      expect(() => turnDocumentCodexInputs(documents, { imageWorkingCopies: { ...options.imageWorkingCopies,
        codexInputs: [{ type: "text", text: JSON.stringify(badFiles), text_elements: [] }] } })).toThrow();
    }
  }, 15_000);

  it.each(["current-image", "pdf-only", "pdf-and-image"] as const)("keeps project reference images outside current attachment mapping (%s)", async kind => {
    const { root, staging, stagingRoot } = await fixture();
    const documents: ResolvedTurnDocument[] = [];
    const sources = [
      ...(kind !== "current-image" ? [{ fileName: "invoice.pdf", declaredMimeType: "application/pdf", data: Buffer.from("%PDF-1.4 synthetic invoice") }] : []),
      ...(kind !== "pdf-only" ? [{ fileName: "dial.png", declaredMimeType: "image/png", data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5S8AAAAASUVORK5CYII=", "base64") }] : []),
    ];
    for (const [index, source] of sources.entries()) {
      const document = await staging.stage({ threadId: THREAD_ID,
        uploadId: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
        validated: validateUploadedDocument(source), data: source.data });
      documents.push({ document, absolutePath: path.join(stagingRoot, document.relativePath),
        codexInputs: [{ type: "text", text: "Existing attachment vision/text input", text_elements: [] }] });
    }
    const workspace = path.join(root, "private-project");
    await mkdir(workspace, { mode: 0o700 });
    const prepared = await prepareTurnDocumentWorkspaceInputs({ documents, projectWorkspace: workspace, stagingRoot });
    const manifest = prepared.codexInputs[0];
    if (manifest.type !== "text") throw new Error("Expected admitted manifest");
    const files = JSON.parse(manifest.text.split("\n").at(-1)!);
    // The mapping boundary must distinguish current inputs from appended
    // project-reference entries, independently of future reference formats.
    files.push({ role: "project-reference", relativePath: `${path.basename(prepared.directory!)}/reference-${files.length + 1}.png`,
      mediaType: "image/png", size: 73, sha256: "f".repeat(64) });
    const inputs = turnDocumentCodexInputs(documents, { imageWorkingCopies: {
      directory: prepared.directory!, workspace,
      codexInputs: [{ type: "text", text: JSON.stringify(files), text_elements: [] }],
    } });
    const images = inputs.filter(input => input.type === "localImage");
    expect(images).toEqual(kind === "pdf-only" ? [] : [{ type: "localImage",
      path: path.join(prepared.directory!, kind === "pdf-and-image" ? "input-2.png" : "input-1.png") }]);
    if (kind !== "current-image") expect(inputs).toContainEqual(documents[0].codexInputs[0]);
    expect(JSON.stringify(inputs)).not.toContain("reference-");
  });

  it("retains thread, permission and private staging-root isolation for image originals and rejects unsafe or changed sources", async () => {
    const { root, staging, stagingRoot } = await fixture();
    const data = Buffer.from("GIF89a private original");
    const validated = validateUploadedDocument({ fileName: "watch.gif", declaredMimeType: "image/gif", data });
    const document = await staging.stage({ threadId: THREAD_ID,
      uploadId: "22222222-2222-4222-8222-222222222223", validated, data });
    const request = { staging, threadId: THREAD_ID, uploadIds: [document.uploadId],
      permissions: permissions("allow"), inputResolver: textInputResolver(stagingRoot) };
    await expect(resolveTurnDocumentAttachments({ ...request, threadId: OTHER_THREAD_ID })).rejects.toBeDefined();
    await expect(resolveTurnDocumentAttachments({ ...request, permissions: permissions("deny") }))
      .rejects.toMatchObject({ code: "TURN_DOCUMENT_PERMISSION_DENIED" });
    const otherActor = await fixture();
    await expect(resolveTurnDocumentAttachments({ ...request, staging: otherActor.staging,
      inputResolver: textInputResolver(otherActor.stagingRoot) })).rejects.toBeDefined();
    const resolved = await resolveTurnDocumentAttachments(request);
    const binding = { documents: resolved, stagingRoot, threadId: THREAD_ID,
      uploadIds: [document.uploadId], permissions: permissions("allow") };
    expect(() => assertWorkerTurnDocuments(binding)).not.toThrow();
    expect(() => assertWorkerTurnDocuments({ ...binding, stagingRoot: otherActor.stagingRoot }))
      .toThrow("staging scope");
    expect(() => assertWorkerTurnDocuments({ ...binding, threadId: OTHER_THREAD_ID }))
      .toThrow("staging scope");
    const projectWorkspace = path.join(root, "private-project");
    await mkdir(projectWorkspace, { mode: 0o700 });
    const input = { documents: resolved, projectWorkspace, stagingRoot };
    await expect(prepareTurnDocumentWorkspaceInputs({ ...input, documents: [{ ...resolved[0],
      document: { ...document, relativePath: "../outside.gif" } }] })).rejects.toThrow();
    await writeFile(resolved[0].absolutePath, "GIF89a tampered original");
    await expect(prepareTurnDocumentWorkspaceInputs(input)).rejects.toMatchObject({ code: "TURN_DOCUMENT_CONTENT_UNAVAILABLE" });
    await rm(resolved[0].absolutePath);
    const outside = path.join(root, "outside.gif");
    await writeFile(outside, data);
    await symlink(outside, resolved[0].absolutePath);
    await expect(prepareTurnDocumentWorkspaceInputs(input)).rejects.toThrow();
    expect(await readFile(outside)).toEqual(data);
  });

  it("makes an authorized scanned PDF available for detailed reading without changing its original or accepting tampered/symlink sources", async () => {
    const { root, staging, stagingRoot } = await fixture();
    const generated = await generateLocalDocument({ format: "pdf", title: "Fictional scanned-table regression",
      content: "Fictional customer: EUR 47.08" });
    const validated = validateUploadedDocument({ fileName: "commission.pdf", declaredMimeType: "application/pdf", data: generated.data });
    const document = await staging.stage({ threadId: THREAD_ID, uploadId: "22222222-2222-4222-8222-222222222223", validated, data: generated.data });
    const resolved = await resolveTurnDocumentAttachments({ staging, threadId: THREAD_ID, uploadIds: [document.uploadId],
      permissions: permissions("allow"), inputResolver: { resolve: async () => [{ type: "text", text: "Scan has no embedded text", text_elements: [] }] } });
    const projectWorkspace = path.join(root, "private-project");
    await mkdir(projectWorkspace, { mode: 0o700 });
    const input = { documents: resolved, projectWorkspace, stagingRoot };
    const prepared = await prepareTurnDocumentWorkspaceInputs(input);
    expect(await readFile(path.join(prepared.directory!, "input-1.pdf"))).toEqual(generated.data);
    expect((await stat(prepared.directory!)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(prepared.directory!, "input-1.pdf"))).mode & 0o777).toBe(0o600);
    expect(prepared.codexInputs).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("complete original-byte") })]);
    expect(JSON.stringify(prepared.codexInputs)).not.toContain(stagingRoot);
    expect(await readFile(resolved[0].absolutePath)).toEqual(generated.data);
    await writeFile(resolved[0].absolutePath, "%PDF-tampered");
    await expect(prepareTurnDocumentWorkspaceInputs(input)).rejects.toMatchObject({ code: "TURN_DOCUMENT_CONTENT_UNAVAILABLE" });
    await rm(resolved[0].absolutePath);
    const outside = path.join(root, "outside.pdf");
    await writeFile(outside, generated.data);
    await symlink(outside, resolved[0].absolutePath);
    await expect(prepareTurnDocumentWorkspaceInputs(input)).rejects.toThrow();
    expect(await readFile(outside)).toEqual(generated.data);
  });

  it("rejects provider file references that bypass local image byte accounting", async () => {
    const { staging } = await fixture();
    await expect(resolveTurnDocumentAttachments({
      staging, threadId: THREAD_ID, uploadIds: [UPLOAD_ID], permissions: permissions("allow"),
      inputResolver: { resolve: async () => [{ type: "image", fileId: "unowned-provider-file" }] },
    })).rejects.toMatchObject({ code: "TURN_DOCUMENT_INPUT_INVALID" });
  });

  it.each([10, 11, 20])("binds %i fictional invoices from real validated staging without model calls", async (count) => {
    const { staging, stagingRoot } = await fixture();
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const uploadId = `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`;
      const data = Buffer.from(`Fictional invoice INV-${index + 1}\nAmount EUR 42.00\n`, "utf8");
      const validated = validateUploadedDocument({ fileName: `invoice-${index + 1}.txt`, declaredMimeType: "text/plain", data });
      await staging.stage({ threadId: THREAD_ID, uploadId, validated, data });
      ids.push(uploadId);
    }
    const resolved = await resolveTurnDocumentAttachments({ staging, threadId: THREAD_ID, uploadIds: ids,
      permissions: permissions("allow"), inputResolver: textInputResolver(stagingRoot) });
    expect(resolved).toHaveLength(count);
    expect(() => assertWorkerTurnDocuments({ documents: resolved, stagingRoot, threadId: THREAD_ID,
      uploadIds: ids, permissions: permissions("allow") })).not.toThrow();
    expect(turnDocumentCodexInputs(resolved).filter(input => input.type === "text")).toHaveLength(count + 1);
    expect(JSON.stringify(turnDocumentCodexInputs(resolved))).not.toContain(stagingRoot);
  });

  it("rejects an oversized document set before staging reads or conversion", async () => {
    const { staging, stagingRoot } = await fixture();
    const read = vi.spyOn(staging, "resolveContentById");
    const resolver = textInputResolver(stagingRoot);
    const resolve = vi.spyOn(resolver, "resolve");
    const ids = Array.from({ length: MAX_FILES_PER_MESSAGE + 1 }, (_, index) => `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`);
    await expect(resolveTurnDocumentAttachments({ staging, threadId: THREAD_ID, uploadIds: ids,
      permissions: permissions("allow"), inputResolver: resolver })).rejects.toMatchObject({ code: "TURN_DOCUMENT_SET_INVALID" });
    expect(read).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("retains aggregate source and prepared-text budgets with twenty documents", async () => {
    const { staging, stagingRoot, document } = await fixture();
    const ids = Array.from({ length: 20 }, (_, index) => `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`);
    // Resource-only metadata mock: no large files or conversion processes are allocated.
    const read = vi.spyOn(staging, "resolveContentById").mockImplementation(async (_threadId, uploadId) => ({
      document: { ...document, uploadId, size: 11 * 1024 * 1024 },
      absolutePath: path.join(stagingRoot, document.relativePath),
    }));
    const resolve = vi.fn(async () => [{ type: "text" as const, text: "invoice", text_elements: [] }]);
    await expect(resolveTurnDocumentAttachments({ staging, threadId: THREAD_ID, uploadIds: ids,
      permissions: permissions("allow"), inputResolver: { resolve } })).rejects.toMatchObject({ code: "TURN_DOCUMENT_SET_TOO_LARGE" });
    expect(resolve).toHaveBeenCalledTimes(18);
    read.mockImplementation(async (_threadId, uploadId) => ({ document: { ...document, uploadId },
      absolutePath: path.join(stagingRoot, document.relativePath) }));
    resolve.mockImplementation(async () => [{ type: "text" as const, text: "x".repeat(220_000), text_elements: [] }]);
    await expect(resolveTurnDocumentAttachments({ staging, threadId: THREAD_ID, uploadIds: ids,
      permissions: permissions("allow"), inputResolver: { resolve } })).rejects.toMatchObject({ code: "TURN_DOCUMENT_INPUT_TOO_LARGE" });
  });

  it("resolves a permissioned upload to a verified server path and typed Codex inputs", async () => {
    const { staging, stagingRoot, document } = await fixture();
    const resolved = await resolveTurnDocumentAttachments({
      staging,
      threadId: THREAD_ID,
      uploadIds: [UPLOAD_ID],
      permissions: permissions("allow"),
      inputResolver: textInputResolver(stagingRoot),
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].absolutePath).toBe(path.join(stagingRoot, document.relativePath));
    expect(turnDocumentChatAttachments(resolved)).toEqual([{
      id: UPLOAD_ID,
      name: "notes.txt",
      mimeType: "text/plain",
      size: document.size,
    }]);
    const codexInputs = turnDocumentCodexInputs(resolved);
    expect(codexInputs).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining(document.sha256) }),
      expect.objectContaining({ type: "text", text: expect.stringContaining("server-derived attachment") }),
    ]);
    expect(JSON.stringify(codexInputs)).not.toContain(stagingRoot);
    expect(codexInputs.some((input) => input.type === "mention" || input.type === "localImage")).toBe(false);
  });

  it("rejects denied, cross-thread and content-tampered attachments", async () => {
    const { staging, stagingRoot, document } = await fixture();
    await expect(resolveTurnDocumentAttachments({
      staging,
      threadId: THREAD_ID,
      uploadIds: [UPLOAD_ID],
      permissions: permissions("deny"),
      inputResolver: textInputResolver(stagingRoot),
    })).rejects.toMatchObject({ code: "TURN_DOCUMENT_PERMISSION_DENIED" });
    await expect(resolveTurnDocumentAttachments({
      staging,
      threadId: OTHER_THREAD_ID,
      uploadIds: [UPLOAD_ID],
      permissions: permissions("allow"),
      inputResolver: textInputResolver(stagingRoot),
    })).rejects.toBeDefined();
    await writeFile(path.join(stagingRoot, document.relativePath), "tampered\n", "utf8");
    await expect(resolveTurnDocumentAttachments({
      staging,
      threadId: THREAD_ID,
      uploadIds: [UPLOAD_ID],
      permissions: permissions("allow"),
      inputResolver: textInputResolver(stagingRoot),
    })).rejects.toMatchObject({ code: "STORAGE_STAGING_CONTENT_CORRUPT" });
  });

  it("embeds attested PDF text and first-page image without exposing a local path", async () => {
    const { stagingRoot, document } = await fixture();
    const runner: DocumentToolRunner = {
      run: async () => ({ stdout: "Rendered contract text\n", stderr: "" }),
    };
    const resolver = new ServerTurnDocumentInputResolver({
      stagingRoot,
      previews: {
        read: async () => ({
          schemaVersion: 2,
          uploadId: document.uploadId,
          threadId: document.threadId,
          sourceSha256: document.sha256,
          status: "ready",
          kind: "pdf",
          files: ["document.pdf", "page-1.png"],
          artifacts: [
            { fileName: "document.pdf", size: 14, sha256: "a".repeat(64) },
            { fileName: "page-1.png", size: 8, sha256: "b".repeat(64) },
          ],
          pages: 1,
          createdAt: document.createdAt,
        }),
        readFile: async (_threadId, _uploadId, fileName) =>
          fileName === "document.pdf" ? Buffer.from("%PDF-synthetic") : Buffer.from("png-page"),
      },
      pdftotext: "/tools/pdftotext",
      runner,
    });
    const inputs = await resolver.resolve({
      ...document,
      fileName: "contract.pdf",
      relativePath: document.relativePath.replace("notes.txt", "contract.pdf"),
      kind: "pdf",
      mediaType: "application/pdf",
    });
    expect(inputs).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Rendered contract text") }),
      expect.objectContaining({ type: "image", url: expect.stringMatching(/^data:image\/png;base64,/u) }),
    ]);
    expect(JSON.stringify(inputs)).not.toContain(stagingRoot);
  });

  it("rebuilds a missing continued PDF preview from its authorized immutable original once", async () => {
    const { root, staging, stagingRoot } = await fixture();
    const data = Buffer.from("%PDF-1.7\nsynthetic original\n%%EOF");
    const document = await staging.stage({ threadId: THREAD_ID,
      uploadId: "22222222-2222-4222-8222-222222222223", data,
      validated: validateUploadedDocument({ fileName: "continued.pdf", declaredMimeType: "application/pdf", data }) });
    const runner: DocumentToolRunner = { run: vi.fn(async (command, args) => {
      if (command.endsWith("pdftoppm")) await writeFile(`${args.at(-1)}.png`, generatedPngFixture(16, 9));
      return { stdout: command.endsWith("pdfinfo") ? "Pages: 1\nEncrypted: no\n" : "Original PDF text\n", stderr: "" };
    }) };
    const previews = new DocumentPreviewService({ stagingRoot, previewRoot: path.join(root, "previews"),
      lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks") }), runner,
      tools: { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm" }, requireQpdf: false });
    const create = vi.spyOn(previews, "create");
    const resolver = new ServerTurnDocumentInputResolver({ stagingRoot, previews, pdftotext: "/tools/pdftotext", runner });
    const resolve = (threadId = THREAD_ID, effect: "allow" | "deny" = "allow") => resolveTurnDocumentAttachments({
      staging, threadId, uploadIds: [document.uploadId], permissions: permissions(effect), inputResolver: resolver,
    });
    await expect(resolve(THREAD_ID, "deny")).rejects.toMatchObject({ code: "TURN_DOCUMENT_PERMISSION_DENIED" });
    await expect(resolve(OTHER_THREAD_ID)).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
    const first = await resolve();
    const repeated = await resolve();
    expect(create).toHaveBeenCalledTimes(1);
    expect(first[0].codexInputs).toEqual(repeated[0].codexInputs);
    expect(JSON.stringify(first[0].codexInputs)).toContain("Original PDF text");
    const preview = await previews.read(THREAD_ID, document.uploadId);
    expect(preview).toMatchObject({ schemaVersion: 2, sourceSha256: document.sha256, pages: 1 });
    expect(await previews.readFile(THREAD_ID, document.uploadId, "document.pdf")).toEqual(data);
    expect(await readFile(path.join(stagingRoot, document.relativePath))).toEqual(data);
    await writeFile(path.join(stagingRoot, document.relativePath), "changed original");
    await expect(resolve()).rejects.toMatchObject({ code: "STORAGE_STAGING_CONTENT_CORRUPT" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(["ENOENT", "DOCUMENT_PREVIEW_REBUILD_REQUIRED"])("re-reads the attestation after rebuilding %s", async code => {
    const { stagingRoot, document } = await fixture();
    const preview: DocumentPreview = { schemaVersion: 2, uploadId: document.uploadId, threadId: document.threadId,
      sourceSha256: document.sha256, status: "ready", kind: "pdf", files: ["document.pdf"],
      artifacts: [], pages: 1, createdAt: document.createdAt };
    const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error("cache absent or legacy"), { code }))
      .mockResolvedValue(preview);
    const create = vi.fn(async () => preview);
    const signal = new AbortController().signal;
    const resolver = new ServerTurnDocumentInputResolver({ stagingRoot, pdftotext: "/tools/pdftotext",
      previews: { read, create, readFile: async () => Buffer.from("%PDF-synthetic") },
      runner: { run: async () => ({ stdout: "PDF text", stderr: "" }) } });
    const pdf = { ...document, kind: "pdf" as const, mediaType: "application/pdf" };
    await resolver.resolve(pdf, { signal });
    expect(create).toHaveBeenCalledExactlyOnceWith(pdf, { signal });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["DOCUMENT_PREVIEW_INTEGRITY_FAILED", "DOCUMENT_PREVIEW_MISMATCH", "EACCES", undefined])(
    "does not rebuild a preview rejected for %s", async code => {
      const { stagingRoot, document } = await fixture();
      const create = vi.fn();
      const resolver = new ServerTurnDocumentInputResolver({ stagingRoot, pdftotext: "/tools/pdftotext",
        previews: { read: async () => { throw Object.assign(new Error("untrusted preview"), { code }); },
          create, readFile: vi.fn() } });
      await expect(resolver.resolve({ ...document, kind: "pdf", mediaType: "application/pdf" }))
        .rejects.toMatchObject({ code: "TURN_DOCUMENT_PREPARATION_FAILED" });
      expect(create).not.toHaveBeenCalled();
    });

  it("preserves conversion admission backpressure when a missing preview needs rebuilding", async () => {
    const { stagingRoot, document } = await fixture();
    const backpressure = new DocumentConversionBackpressureError(1_000);
    const create = vi.fn(async () => { throw backpressure; });
    const resolver = new ServerTurnDocumentInputResolver({ stagingRoot, pdftotext: "/tools/pdftotext",
      previews: { read: async () => { throw Object.assign(new Error("missing cache"), { code: "ENOENT" }); },
        create, readFile: vi.fn() } });
    await expect(resolver.resolve({ ...document, kind: "pdf", mediaType: "application/pdf" })).rejects.toBe(backpressure);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects a rebuilt preview with a different source hash without retrying", async () => {
    const { stagingRoot, document } = await fixture();
    const preview: DocumentPreview = { schemaVersion: 2, uploadId: document.uploadId, threadId: document.threadId,
      sourceSha256: "0".repeat(64), status: "ready", kind: "pdf", files: ["document.pdf"],
      artifacts: [], pages: 1, createdAt: document.createdAt };
    const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error("missing cache"), { code: "ENOENT" }))
      .mockResolvedValue(preview);
    const create = vi.fn(async () => preview);
    const readFile = vi.fn();
    const resolver = new ServerTurnDocumentInputResolver({ stagingRoot, pdftotext: "/tools/pdftotext",
      previews: { read, create, readFile } });
    await expect(resolver.resolve({ ...document, kind: "pdf", mediaType: "application/pdf" }))
      .rejects.toMatchObject({ code: "TURN_DOCUMENT_PREVIEW_INVALID" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("supplies a scanned middle-page image and explicitly bounds unavailable trailing pages", async () => {
    const { stagingRoot, document } = await fixture();
    const renderPage = vi.fn(async () => Buffer.from("scanned-page"));
    const resolver = new ServerTurnDocumentInputResolver({ stagingRoot, pdftotext: "/tools/pdftotext",
      runner: { run: async () => ({ stdout: "page one\f\fpage three\f", stderr: "" }) },
      previews: { read: async () => ({ schemaVersion: 2, uploadId: document.uploadId, threadId: document.threadId,
        sourceSha256: document.sha256, status: "ready", kind: "pdf", files: ["document.pdf", "page-1.png"],
        artifacts: [], pages: 3, createdAt: document.createdAt }),
        readFile: async () => Buffer.from("preview"), renderPage },
    });
    const inputs = await resolver.resolve({ ...document, fileName: "mixed.pdf", kind: "pdf", mediaType: "application/pdf" });
    expect(renderPage).toHaveBeenCalledWith(document.threadId, document.uploadId, 2, { signal: undefined });
    expect(inputs.filter(i => i.type === "image")).toHaveLength(2);
    expect(JSON.stringify(inputs)).toContain("page(s) 2 have no readable text");
    expect(JSON.stringify(inputs)).toContain("page 2");
    expect(JSON.stringify(inputs)).not.toContain("INCOMPLETE PDF COVERAGE");
  });

  it("maps preview and tool failures to a recoverable document error", async () => {
    const { stagingRoot, document } = await fixture();
    const resolver = new ServerTurnDocumentInputResolver({
      stagingRoot,
      previews: {
        read: async () => { throw new Error("synthetic preview outage"); },
        readFile: async () => { throw new Error("unreachable"); },
      },
      pdftotext: "/tools/pdftotext",
    });
    await expect(resolver.resolve({
      ...document,
      fileName: "contract.pdf",
      relativePath: document.relativePath.replace("notes.txt", "contract.pdf"),
      kind: "pdf",
      mediaType: "application/pdf",
    })).rejects.toMatchObject({ code: "TURN_DOCUMENT_PREPARATION_FAILED" });
  });

  it.each(["xlsx", "xltx"])("reads uploaded %s cells by row and preserves exact original template bytes", async format => {
    const { root, staging, stagingRoot } = await fixture();
    let generated = await generateLocalDocument({
      format: "xlsx",
      title: "Vendes",
      content: "Synthetic source",
      rows: [
        ["Setmana", "SKU", "Kg", "Preu"],
        ["2026-07-27", "P001", 37.88, 12.9],
        ["2026-08-03", "P002", 51.66, 9.9],
      ],
    });
    if (format === "xltx") {
      const archive = await JSZip.loadAsync(generated.data);
      const contentTypes = await archive.file("[Content_Types].xml")!.async("string");
      archive.file("[Content_Types].xml", contentTypes.replace("spreadsheetml.sheet.main+xml", "spreadsheetml.template.main+xml"));
      generated = { ...generated, data: await archive.generateAsync({ type: "nodebuffer" }),
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.template" };
    }
    const validated = validateUploadedDocument({
      fileName: `vendes.${format}`,
      declaredMimeType: generated.mimeType,
      data: generated.data,
    });
    const document = await staging.stage({
      threadId: THREAD_ID,
      uploadId: "22222222-2222-4222-8222-222222222223",
      validated,
      data: generated.data,
    });
    const resolver = new ServerTurnDocumentInputResolver({
      stagingRoot,
      previews: {
        read: async () => { throw new Error("XLSX must not use a PDF preview"); },
        readFile: async () => { throw new Error("XLSX must not use a PDF preview"); },
      },
      pdftotext: "/tools/pdftotext",
    });
    const resolved = await resolveTurnDocumentAttachments({
      staging,
      threadId: THREAD_ID,
      uploadIds: [document.uploadId],
      permissions: permissions("allow"),
      inputResolver: resolver,
    });
    expect(turnDocumentChatAttachments(resolved).every(isChatAttachment)).toBe(true);
    const inputs = turnDocumentCodexInputs(resolved);
    expect(inputs).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("server-attached documents") }),
      expect.objectContaining({ type: "text", text: expect.stringContaining("stored cells") }),
      expect.objectContaining({ type: "text", text: expect.stringContaining("2026-07-27,P001,37.88,12.9") }),
    ]);
    expect(inputs[2]).toMatchObject({
      type: "text",
      text: expect.stringContaining("2026-08-03,P002,51.66,9.9"),
    });
    expect(JSON.stringify(inputs)).not.toContain(stagingRoot);
    expect(turnDocumentCodexInputs(resolved, { xlsxAvailableInWorkspace: true })).toHaveLength(1);
    const projectWorkspace = path.join(root, "private-project");
    await mkdir(projectWorkspace, { mode: 0o700 });
    const prepared = await prepareTurnDocumentWorkspaceInputs({
      documents: resolved,
      projectWorkspace,
      stagingRoot,
    });
    expect(prepared.directory).toBeTruthy();
    expect(prepared.codexInputs).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("input-1.xlsx") }),
    ]);
    expect(JSON.stringify(prepared.codexInputs)).not.toContain(stagingRoot);
    expect(await readFile(path.join(prepared.directory!, "input-1.xlsx"))).toEqual(generated.data);
    const workspaceResolver = new ServerTurnDocumentInputResolver({
      stagingRoot,
      previews: {
        read: async () => { throw new Error("XLSX must not use a PDF preview"); },
        readFile: async () => { throw new Error("XLSX must not use a PDF preview"); },
      },
      pdftotext: "/tools/pdftotext",
      workspaceXlsx: true,
      runner: { run: async () => { throw new Error("XLSX must not be rendered as text before workspace copy"); } },
    });
    expect(await workspaceResolver.resolve(document)).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("private turn workspace") }),
    ]);
  });
});
