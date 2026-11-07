import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileLibraryResourceLocationIndex,
  LibraryResourceLocationConflictError,
  LibraryResourceLocationNotFoundError,
} from "@/library/resource-location-index";

vi.mock("server-only", () => ({}));

const OWNER = "0198b9f0-6631-7000-8000-000000000801";
const EDITOR = "0198b9f0-6631-7000-8000-000000000802";
const PROJECT = "0198b9f0-6631-7000-8000-000000000803";
const THREAD = "0198b9f0-6631-7000-8000-000000000804";
const UPLOAD = "0198b9f0-6631-7000-8000-000000000805";

describe("library resource location index", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps an immutable actor/path/hash binding and rejects same-id substitution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-resource-locations-"));
    roots.push(root);
    let now = Date.parse("2026-08-30T08:00:00.000Z");
    const store = new FileLibraryResourceLocationIndex({
      dataRoot: root,
      installationId: "resource-location-test",
      now: () => now,
    });
    const input = {
      kind: "upload" as const,
      resourceId: UPLOAD,
      projectId: PROJECT,
      threadId: THREAD,
      messageId: null,
      storageOwnerId: EDITOR,
      relativePath: `threads/${THREAD}/uploads/${UPLOAD}/report.pdf`,
      fileName: "report.pdf",
      mediaType: "application/pdf",
      size: 8,
      sha256: "a".repeat(64),
    };

    const created = await store.register(input);
    now += 1_000;
    await expect(store.register(input)).resolves.toEqual(created);
    await expect(store.register({ ...input, storageOwnerId: OWNER }))
      .rejects.toBeInstanceOf(LibraryResourceLocationConflictError);
    await expect(store.register({ ...input, sha256: "b".repeat(64) }))
      .rejects.toBeInstanceOf(LibraryResourceLocationConflictError);

    const restarted = new FileLibraryResourceLocationIndex({
      dataRoot: root,
      installationId: "resource-location-test",
    });
    await expect(restarted.resolve("upload", UPLOAD, { projectId: PROJECT, threadId: THREAD }))
      .resolves.toMatchObject({ storageOwnerId: EDITOR, sha256: "a".repeat(64) });
    await expect(restarted.resolve("upload", UPLOAD, {
      projectId: "0198b9f0-6631-7000-8000-000000000899",
      threadId: THREAD,
    })).rejects.toBeInstanceOf(LibraryResourceLocationNotFoundError);
  });

  it("allows integrity movement only for a bound advanced artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-resource-locations-"));
    roots.push(root);
    const store = new FileLibraryResourceLocationIndex({
      dataRoot: root,
      installationId: "resource-location-test",
    });
    const artifactId = "0198b9f0-6631-7000-8000-000000000806";
    await store.register({
      kind: "advanced-artifact",
      resourceId: artifactId,
      projectId: PROJECT,
      threadId: THREAD,
      messageId: "0198b9f0-6631-7000-8000-000000000807",
      storageOwnerId: EDITOR,
      relativePath: null,
      fileName: "Quarterly view",
      mediaType: "application/vnd.aibrain.artifact+json",
      size: 120,
      sha256: "c".repeat(64),
    });
    await expect(store.updateIntegrity("advanced-artifact", artifactId, {
      size: 144,
      sha256: "d".repeat(64),
    })).resolves.toMatchObject({
      storageOwnerId: EDITOR,
      projectId: PROJECT,
      size: 144,
      sha256: "d".repeat(64),
    });
    await expect(store.updateIntegrity("upload", UPLOAD, { size: 1, sha256: "e".repeat(64) }))
      .rejects.toBeInstanceOf(LibraryResourceLocationConflictError);
  });

  it("refreshes a generated workspace file only when its stable binding is unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-resource-locations-"));
    roots.push(root);
    let now = Date.parse("2026-08-30T08:00:00.000Z");
    const store = new FileLibraryResourceLocationIndex({
      dataRoot: root,
      installationId: "resource-location-test",
      now: () => now,
    });
    const artifactId = "0198b9f0-6631-7000-8000-000000000808";
    const input = {
      kind: "workspace-file" as const,
      resourceId: artifactId,
      projectId: PROJECT,
      threadId: THREAD,
      messageId: "0198b9f0-6631-7000-8000-000000000809",
      storageOwnerId: EDITOR,
      relativePath: "reports/current.pdf",
      fileName: "current.pdf",
      mediaType: "application/pdf",
      size: 120,
      sha256: "f".repeat(64),
    };
    const original = await store.register(input);

    now += 1_000;
    const refreshed = await store.register({ ...input, size: 144, sha256: "0".repeat(64) });
    expect(refreshed).toMatchObject({
      createdAt: original.createdAt,
      updatedAt: "2026-08-30T08:00:01.000Z",
      size: 144,
      sha256: "0".repeat(64),
    });
    await expect(store.register({
      ...input,
      size: 155,
      sha256: "1".repeat(64),
      relativePath: "reports/substitute.pdf",
    })).rejects.toBeInstanceOf(LibraryResourceLocationConflictError);
  });
});
