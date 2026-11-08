import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileDocumentStagingStore } from "@/documents/staging-store";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { ResourceLockManager } from "@/storage/resource-lock";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";

describe("file document staging store", () => {
  let root: string;
  let staging: string;
  let store: FileDocumentStagingStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aibrain-staging-"));
    staging = path.join(root, "private-staging");
    store = new FileDocumentStagingStore(
      staging,
      new ResourceLockManager({ rootDirectory: path.join(root, "locks") }),
      () => 1_000,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stages validated bytes atomically and is idempotent for the same upload id", async () => {
    const data = Buffer.from("private notes");
    const validated = validateUploadedDocument({
      fileName: "notes.txt",
      declaredMimeType: "text/plain",
      data,
    });
    const first = await store.stage({ threadId: THREAD_ID, uploadId: UPLOAD_ID, validated, data });
    const second = await store.stage({ threadId: THREAD_ID, uploadId: UPLOAD_ID, validated, data });

    expect(second).toEqual(first);
    expect(first).toMatchObject({ schemaVersion: 1, status: "staged", sha256: validated.sha256 });
    expect(await readFile(path.join(staging, first.relativePath), "utf8")).toBe("private notes");
    expect((await store.read(THREAD_ID, UPLOAD_ID, "notes.txt")).uploadId).toBe(UPLOAD_ID);
    expect((await store.readById(THREAD_ID, UPLOAD_ID)).fileName).toBe("notes.txt");
  });

  it("copies a validated private file without loading it as a Buffer", async () => {
    const data = Buffer.from("streamed private notes");
    const sourcePath = path.join(root, "incoming.upload");
    await writeFile(sourcePath, data, { mode: 0o600 });
    const validated = validateUploadedDocument({
      fileName: "notes.txt",
      declaredMimeType: "text/plain",
      data,
    });
    const staged = await store.stageFile({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      validated,
      sourcePath,
    });
    expect(await readFile(path.join(staging, staged.relativePath), "utf8")).toBe(data.toString("utf8"));
    expect(staged.sha256).toBe(validated.sha256);
  });

  it("recovers a crash after content publication and makes retry idempotent", async () => {
    const data = Buffer.from("crash-safe content");
    const sourcePath = path.join(root, "incoming.upload");
    await writeFile(sourcePath, data, { mode: 0o600 });
    const validated = validateUploadedDocument({
      fileName: "notes.txt",
      declaredMimeType: "text/plain",
      data,
    });
    const uploadDirectory = path.join(staging, "threads", THREAD_ID, "uploads", UPLOAD_ID);
    await mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
    const orphanPath = path.join(uploadDirectory, "notes.txt");
    await writeFile(orphanPath, data, { mode: 0o600 });

    const recovered = await store.stageFile({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      validated,
      sourcePath,
    });
    const retry = await store.stageFile({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      validated,
      sourcePath,
    });
    expect(retry).toEqual(recovered);
    expect(await readFile(orphanPath, "utf8")).toBe(data.toString("utf8"));
    expect((await readdir(uploadDirectory)).sort()).toEqual(["notes.txt", "upload.json"]);
  });

  it("never overwrites differing or ambiguous orphaned staged content", async () => {
    const sourceData = Buffer.from("new validated content");
    const sourcePath = path.join(root, "incoming.upload");
    await writeFile(sourcePath, sourceData, { mode: 0o600 });
    const validated = validateUploadedDocument({
      fileName: "notes.txt",
      declaredMimeType: "text/plain",
      data: sourceData,
    });
    const uploadDirectory = path.join(staging, "threads", THREAD_ID, "uploads", UPLOAD_ID);
    await mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
    const orphanPath = path.join(uploadDirectory, "notes.txt");
    await writeFile(orphanPath, "existing different content", { mode: 0o600 });
    await expect(store.stageFile({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      validated,
      sourcePath,
    })).rejects.toMatchObject({ code: "STORAGE_STAGING_ID_CONFLICT" });
    expect(await readFile(orphanPath, "utf8")).toBe("existing different content");

    await writeFile(path.join(uploadDirectory, "unexpected.tmp"), "orphan", { mode: 0o600 });
    await expect(store.stageFile({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      validated,
      sourcePath,
    })).rejects.toMatchObject({ code: "STORAGE_STAGING_ORPHAN_CONFLICT" });
    expect(await readFile(orphanPath, "utf8")).toBe("existing different content");
  });

  it("rejects reuse of an upload id for different content", async () => {
    const firstData = Buffer.from("one");
    const secondData = Buffer.from("two");
    await store.stage({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      validated: validateUploadedDocument({ fileName: "notes.txt", declaredMimeType: "text/plain", data: firstData }),
      data: firstData,
    });
    await expect(store.stage({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      validated: validateUploadedDocument({ fileName: "notes.txt", declaredMimeType: "text/plain", data: secondData }),
      data: secondData,
    })).rejects.toMatchObject({ code: "STORAGE_STAGING_ID_CONFLICT" });
  });

  it("does not traverse a symlinked thread staging directory", async () => {
    const outside = path.join(root, "outside");
    await mkdir(path.join(staging, "threads"), { recursive: true });
    await symlink(outside, path.join(staging, "threads", THREAD_ID), "dir");
    const data = Buffer.from("blocked");
    await expect(store.stage({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      validated: validateUploadedDocument({ fileName: "notes.txt", declaredMimeType: "text/plain", data }),
      data,
    })).rejects.toMatchObject({ code: "STORAGE_SYMLINK_REJECTED" });
    await expect(readdir(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked upload metadata on id-based reads", async () => {
    const data = Buffer.from("private notes");
    await store.stage({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      validated: validateUploadedDocument({ fileName: "notes.txt", declaredMimeType: "text/plain", data }),
      data,
    });
    const metadataPath = path.join(staging, "threads", THREAD_ID, "uploads", UPLOAD_ID, "upload.json");
    const outside = path.join(root, "outside-upload.json");
    await writeFile(outside, await readFile(metadataPath), { mode: 0o600 });
    await unlink(metadataPath);
    await symlink(outside, metadataPath);
    await expect(store.readById(THREAD_ID, UPLOAD_ID))
      .rejects.toMatchObject({ code: "STORAGE_STAGING_METADATA_UNSAFE" });
  });
});
