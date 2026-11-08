import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import { acceptOutlookDesktopChunk, persistOutlookDesktopFile, resolveOutlookDesktopAttachment, materializeOutlookDesktopArtifact } from "./outlook-desktop-files";
import { resourceLocationIndexForInstallation } from "@/library/server-resource-access";
import { GET } from "@/app/api/threads/[threadId]/outlook-files/[artifactId]/route";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ session: vi.fn(), resource: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/library/server-resource-access", async original => ({ ...await original<typeof import("@/library/server-resource-access")>(), resolveGeneratedDocumentResource: mocks.resource }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "outlook-file-test-")); roots.push(dataRoot);
  const context = { installation: { installationId: "g03-production", paths: { dataRoot } as InstallationConfig["paths"] }, projectId: "11111111-1111-4111-8111-111111111111", threadId: "11111111-1111-4111-8111-111111111112", messageId: "11111111-1111-4111-8111-111111111113", storageOwnerId: "11111111-1111-4111-8111-111111111114" };
  const bytes = Buffer.from("Original confidential attachment bytes"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = { filename: "old.pdf", contentType: "application/pdf", bytes, sha256 };
  return { dataRoot, context, bytes, sha256, file };
}
it("assembles all chunks and only releases exact hash-verified original bytes", async () => {
  const f = await fixture(), args = { storeId: "S", entryId: "E", index: 1 };
  const chunk = (offset: number, bytes: Buffer) => ({ filename: f.file.filename, contentType: f.file.contentType, totalSize: f.bytes.length, offset, dataBase64: bytes.toString("base64"), sha256: f.sha256 });
  expect(await acceptOutlookDesktopChunk(args, chunk(0, f.bytes.subarray(0, 8)), f.context)).toMatchObject({ complete: false, nextOffset: 8 });
  const result = await acceptOutlookDesktopChunk({ ...args, offset: 8 }, chunk(8, f.bytes.subarray(8)), f.context); expect(result.complete).toBe(true);
  if (!result.complete) throw Error("missing original");
  const replay = await acceptOutlookDesktopChunk({ ...args, offset: 8 }, chunk(8, f.bytes.subarray(8)), f.context); expect(replay).toMatchObject({ complete: true, artifact: { id: result.artifact.id } });
  const reference = await resolveOutlookDesktopAttachment(result.artifact.id, f.context); expect(Buffer.from(reference.dataBase64, "base64")).toEqual(f.bytes);
  const workspace = await mkdtemp(path.join(tmpdir(), "outlook-workspace-test-")); roots.push(workspace);
  const local = await materializeOutlookDesktopArtifact(result.artifact.id, f.context, workspace); expect(await readFile(path.join(workspace, local.relativePath))).toEqual(f.bytes);
});
it("rejects forged encoding/hash, changed transfer identity, cross-user/project/thread and symlink paths", async () => {
  const f = await fixture();
  await expect(acceptOutlookDesktopChunk({ offset: 0 }, { filename: "x", contentType: "application/pdf", sha256: f.sha256, totalSize: f.bytes.length, offset: 0, dataBase64: "??" }, f.context)).rejects.toThrow();
  await expect(persistOutlookDesktopFile({ ...f.file, sha256: "f".repeat(64) }, f.context)).rejects.toThrow();
  const artifact = await persistOutlookDesktopFile(f.file, f.context);
  for (const patch of [{ storageOwnerId: "22222222-2222-4222-8222-222222222222" }, { threadId: "22222222-2222-4222-8222-222222222222" }, { projectId: "22222222-2222-4222-8222-222222222222" }]) await expect(resolveOutlookDesktopAttachment(artifact.id, { ...f.context, ...patch })).rejects.toThrow();
  const second = await fixture(), outside = await mkdtemp(path.join(tmpdir(), "outlook-outside-")); roots.push(outside); await mkdir(path.join(second.dataRoot, "outlook-desktop-files")); await symlink(outside, path.join(second.dataRoot, "outlook-desktop-files", second.context.storageOwnerId)); await expect(persistOutlookDesktopFile(second.file, second.context)).rejects.toThrow("OUTLOOK_FILE_PATH_UNSAFE");
});
it("serves owner-bound original attachment safely and rejects another owner, tenant or changed bytes", async () => {
  const f = await fixture(), artifact = await persistOutlookDesktopFile(f.file, f.context);
  const location = await resourceLocationIndexForInstallation(f.context.installation).binding("generated-document", artifact.id);
  const params = { params: Promise.resolve({ threadId: f.context.threadId, artifactId: artifact.id }) };
  mocks.session.mockResolvedValue({ user: { id: f.context.storageOwnerId } }); mocks.resource.mockResolvedValue({ installation: f.context.installation, location });
  const result = await GET(new Request("https://test.invalid"), params); expect(result.status).toBe(200); expect(Buffer.from(await result.arrayBuffer())).toEqual(f.bytes); expect(result.headers.get("content-security-policy")).toContain("sandbox");
  mocks.session.mockResolvedValue({ user: { id: "other-user" } }); expect((await GET(new Request("https://test.invalid"), params)).status).toBe(404);
  mocks.session.mockResolvedValue({ user: { id: f.context.storageOwnerId } }); await writeFile(path.join(f.dataRoot, location!.relativePath!), "changed"); expect((await GET(new Request("https://test.invalid"), params)).status).toBe(409);
});
