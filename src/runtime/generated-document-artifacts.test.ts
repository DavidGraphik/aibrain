import type { InstallationConfig } from "@/config/installation-schema";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatedDocumentArtifactId, persistGeneratedDocumentArtifact } from "@/runtime/generated-document-artifacts";

vi.mock("server-only", () => ({}));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "aibrain-explicit-document-"));
  roots.push(dataRoot);
  const turnId = "00000000-0000-4000-8000-000000000012";
  const relativePath = "documents/review.pdf";
  return { artifactId: generatedDocumentArtifactId(turnId, relativePath), relativePath,
    contents: Buffer.from("%PDF-1.7\nfixture"), pages: 4,
    context: { installation: { installationId: "document-test", paths: { dataRoot } as InstallationConfig["paths"] },
      projectId: "00000000-0000-4000-8000-000000000011", messageId: turnId,
      threadId: "00000000-0000-4000-8000-000000000013", storageOwnerId: "00000000-0000-4000-8000-000000000014" } };
}
describe("explicit generated document persistence", () => {
  it("persists verified bytes immutably behind owner-scoped preview and download URLs", async () => {
    const input = await fixture();
    const artifact = await persistGeneratedDocumentArtifact(input);
    expect(artifact).toMatchObject({ name: "review.pdf", pages: 4, status: "ready",
      previewUrl: expect.stringContaining(`/api/threads/${input.context.threadId}/artifacts/`), url: expect.stringContaining("?download=1") });
    const saved = path.join(input.context.installation.paths.dataRoot, "generated-document-artifacts", input.context.storageOwnerId, artifact.id, "review.pdf");
    expect(await readFile(saved)).toEqual(input.contents);
    expect(await persistGeneratedDocumentArtifact(input)).toEqual(artifact);
    await expect(persistGeneratedDocumentArtifact({ ...input, contents: Buffer.from("%PDF-1.7\nchanged") })).rejects.toThrow();
    expect(await readFile(saved)).toEqual(input.contents);
  });
  it("rejects invalid bytes and linked storage roots", async () => {
    const input = await fixture();
    await expect(persistGeneratedDocumentArtifact({ ...input, contents: Buffer.from("not a pdf") })).rejects.toThrow();
    const outside = await mkdtemp(path.join(tmpdir(), "aibrain-outside-")); roots.push(outside);
    const artifactsRoot = path.join(input.context.installation.paths.dataRoot, "generated-document-artifacts");
    await mkdir(artifactsRoot, { recursive: true });
    await symlink(outside, path.join(artifactsRoot, input.context.storageOwnerId));
    await expect(persistGeneratedDocumentArtifact(input)).rejects.toThrow();
  });
});
