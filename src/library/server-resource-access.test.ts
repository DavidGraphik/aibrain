import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT = "00000000-0000-4000-8000-000000000011";
const THREAD = "00000000-0000-4000-8000-000000000012";
const OTHER_THREAD = "00000000-0000-4000-8000-000000000013";
const ARTIFACT = "00000000-0000-4000-8000-000000000014";
const OWNER = "00000000-0000-4000-8000-000000000015";
const state = vi.hoisted(() => ({ dataRoot: "", allowedThread: "00000000-0000-4000-8000-000000000012" }));

vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({
  loadInstallationConfig: async () => ({ installationId: "document-test", paths: { dataRoot: state.dataRoot } }),
}));
vi.mock("@/workbench/shared-access", () => ({
  resolveThreadAccess: async (_session: unknown, threadId: string) => {
    if (threadId !== state.allowedThread) throw new Error("thread denied");
    return { role: "owner", project: { id: PROJECT }, thread: { id: threadId } };
  },
  resolveProjectAccess: vi.fn(),
}));

import { FileLibraryResourceLocationIndex, LibraryResourceLocationNotFoundError } from "@/library/resource-location-index";
import { resolveGeneratedDocumentResource } from "@/library/server-resource-access";

const roots: string[] = [];
const session = {
  provider: "local" as const,
  tenant: { id: "document-test", name: "Document Test" },
  user: { id: OWNER, name: "Owner", email: "owner@example.test" },
  expiresAt: "2030-01-01T00:00:00.000Z",
};

describe("generated document server ACL", () => {
  beforeEach(async () => {
    state.dataRoot = await mkdtemp(path.join(tmpdir(), "aibrain-document-acl-"));
    roots.push(state.dataRoot);
    state.allowedThread = THREAD;
    await new FileLibraryResourceLocationIndex({ dataRoot: state.dataRoot, installationId: "document-test" }).register({
      kind: "generated-document",
      resourceId: ARTIFACT,
      projectId: PROJECT,
      threadId: THREAD,
      messageId: "00000000-0000-4000-8000-000000000016",
      storageOwnerId: OWNER,
      relativePath: `generated-document-artifacts/${OWNER}/${ARTIFACT}/report.pdf`,
      fileName: "report.pdf",
      mediaType: "application/pdf",
      size: 100,
      sha256: "a".repeat(64),
    });
  });
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("survives an index restart but requires the exact source conversation", async () => {
    await expect(resolveGeneratedDocumentResource(session, { artifactId: ARTIFACT, threadId: THREAD }))
      .resolves.toMatchObject({ location: { storageOwnerId: OWNER, threadId: THREAD, projectId: PROJECT } });
    await expect(resolveGeneratedDocumentResource(session, { artifactId: ARTIFACT, threadId: OTHER_THREAD }))
      .rejects.toBeInstanceOf(LibraryResourceLocationNotFoundError);
    state.allowedThread = OTHER_THREAD;
    await expect(resolveGeneratedDocumentResource(session, { artifactId: ARTIFACT, threadId: THREAD }))
      .rejects.toThrow("thread denied");
  });

  it("rejects a session from another installation before reading the index", async () => {
    await expect(resolveGeneratedDocumentResource({ ...session, tenant: { id: "foreign", name: "Foreign" } }, {
      artifactId: ARTIFACT,
      threadId: THREAD,
    })).rejects.toThrow("no pertenece");
  });
});
