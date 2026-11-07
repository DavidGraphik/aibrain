import { mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StagedDocument } from "@/documents/staging-store";
import { FileDocumentVersionStore, parseIfMatch, quotedDocumentEtag } from "@/documents/version-store";
import { ResourceLockManager } from "@/storage/resource-lock";

const THREAD_ID = "0198b9f0-6631-7000-8000-000000000601";
const DOCUMENT_ID = "0198b9f0-6631-7000-8000-000000000611";
const VERSION_TWO = "0198b9f0-6631-7000-8000-000000000612";
const RESTORE_ID = "0198b9f0-6631-7000-8000-000000000613";
const USER_ID = "example-user";
const roots: string[] = [];

function staged(uploadId: string, fileName: string, content: string): StagedDocument {
  const sha256 = Buffer.from(content).toString("hex").padEnd(64, "0").slice(0, 64);
  return {
    schemaVersion: 1,
    uploadId,
    threadId: THREAD_ID,
    fileName,
    relativePath: `threads/${THREAD_ID}/uploads/${uploadId}/${fileName}`,
    kind: "text",
    mediaType: "text/plain",
    size: Buffer.byteLength(content),
    sha256,
    status: "staged",
    createdAt: "2026-08-30T08:00:00.000Z",
  };
}

async function store() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-document-history-"));
  roots.push(root);
  return new FileDocumentVersionStore(
    path.join(root, "history"),
    new ResourceLockManager({ rootDirectory: path.join(root, "locks") }),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("versioned document history", () => {
  it("keeps v1, appends a roundtrip v2 and restores v1 as a new immutable version", async () => {
    const versions = await store();
    const original = staged(DOCUMENT_ID, "plan.txt", "version one");
    const created = await versions.create({
      threadId: THREAD_ID,
      documentId: DOCUMENT_ID,
      document: original,
      author: { userId: USER_ID, name: "David" },
      scope: { kind: "project", id: "0198b9f0-6631-7000-8000-000000000631" },
    });
    const v1 = created.versions[0]!;

    const updated = await versions.appendUpload({
      threadId: THREAD_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_TWO,
      baseEtag: v1.etag,
      document: staged(VERSION_TWO, "plan.txt", "version two"),
      author: { userId: USER_ID, name: "David" },
    });
    expect(updated.versions).toHaveLength(2);
    expect(updated.versions[0]).toEqual(v1);
    expect(updated.versions[1]).toMatchObject({
      versionId: VERSION_TWO,
      number: 2,
      provenance: { type: "roundtrip_upload", sourceVersionId: DOCUMENT_ID },
    });

    const restored = await versions.restore({
      threadId: THREAD_ID,
      documentId: DOCUMENT_ID,
      sourceVersionId: DOCUMENT_ID,
      restoreVersionId: RESTORE_ID,
      baseEtag: updated.versions[1]!.etag,
      author: { userId: USER_ID, name: "David" },
    });
    expect(restored.versions).toHaveLength(3);
    expect(restored.versions[0]).toEqual(v1);
    expect(restored.versions[2]).toMatchObject({
      versionId: RESTORE_ID,
      contentUploadId: DOCUMENT_ID,
      sha256: v1.sha256,
      provenance: { type: "restore", sourceVersionId: DOCUMENT_ID },
    });
    expect((await versions.read(THREAD_ID, DOCUMENT_ID)).latestVersionId).toBe(RESTORE_ID);
  });

  it("rejects a stale base etag without silently overwriting the latest version", async () => {
    const versions = await store();
    const created = await versions.create({
      threadId: THREAD_ID,
      documentId: DOCUMENT_ID,
      document: staged(DOCUMENT_ID, "notes.txt", "one"),
      author: { userId: USER_ID, name: "David" },
      scope: { kind: "private", id: USER_ID },
    });
    const stale = created.versions[0]!.etag;
    await versions.appendUpload({
      threadId: THREAD_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_TWO,
      baseEtag: stale,
      document: staged(VERSION_TWO, "notes.txt", "two"),
      author: { userId: USER_ID, name: "David" },
    });
    await expect(versions.restore({
      threadId: THREAD_ID,
      documentId: DOCUMENT_ID,
      sourceVersionId: DOCUMENT_ID,
      restoreVersionId: RESTORE_ID,
      baseEtag: stale,
      author: { userId: USER_ID, name: "David" },
    })).rejects.toMatchObject({ code: "DOCUMENT_VERSION_CONFLICT" });
    expect((await versions.read(THREAD_ID, DOCUMENT_ID)).versions).toHaveLength(2);
  });

  it("fails closed when the durable manifest is replaced by a symlink", async () => {
    const versions = await store();
    await versions.create({
      threadId: THREAD_ID,
      documentId: DOCUMENT_ID,
      document: staged(DOCUMENT_ID, "notes.txt", "one"),
      author: { userId: USER_ID, name: "David" },
      scope: { kind: "company", id: "documents-lab" },
    });
    const manifest = path.join(versions.rootDirectory, THREAD_ID, DOCUMENT_ID, "document.json");
    await unlink(manifest);
    await symlink("/etc/hosts", manifest);
    await expect(versions.read(THREAD_ID, DOCUMENT_ID)).rejects.toMatchObject({
      code: "DOCUMENT_VERSION_MANIFEST_UNSAFE",
    });
  });

  it("uses strict quoted If-Match etags", () => {
    const etag = "a".repeat(64);
    expect(quotedDocumentEtag(etag)).toBe(`"${etag}"`);
    expect(parseIfMatch(`"${etag}"`)).toBe(etag);
    expect(parseIfMatch(etag)).toBeNull();
    expect(parseIfMatch("*")).toBeNull();
  });
});
