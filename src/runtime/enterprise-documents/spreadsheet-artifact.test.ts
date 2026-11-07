import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSpreadsheetArtifact } from "./spreadsheet-artifact";
import { FileLibraryResourceLocationIndex } from "@/library/resource-location-index";
import { isGeneratedArtifact } from "@/lib/chat-contract";
import { isSpreadsheetPreview } from "@/documents/spreadsheet-preview";
import { handleCompanyFilesDynamicToolCall } from "./dynamic-tools";

vi.mock("server-only", () => ({}));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const preview = { schemaVersion: 1, kind: "spreadsheet", truncated: false, sheets: [{ name: "Torre", hidden: false, cells: [{ address: "C3", value: "09:00" }] }] };
const result = { available: true, scope: "company", path: "server-arnall/Y/Horaris.xlsm", part: 1,
  sha256: "a".repeat(64), checkedAt: "2026-09-03T12:00:00Z", content: "C3: 09:00", preview };
async function context() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-grid-")); roots.push(root);
  return { installationId: "test-grid", dataRoot: root, workspace: root,
    userId: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002",
    threadId: "00000000-0000-4000-8000-000000000003", messageId: "00000000-0000-4000-8000-000000000004" };
}

it("persists a verified, idempotent source representation with an actor-bound resource", async () => {
  const ctx = await context();
  const artifact = await createSpreadsheetArtifact(result, ctx);
  expect(isGeneratedArtifact(artifact)).toBe(true);
  expect(artifact?.previewFormat).toBe("spreadsheet");
  expect(await createSpreadsheetArtifact(result, ctx)).toEqual(artifact);
  const index = new FileLibraryResourceLocationIndex(ctx);
  const binding = await index.binding("workspace-file", artifact!.id);
  expect(binding).toMatchObject({ storageOwnerId: ctx.userId, projectId: ctx.projectId, threadId: ctx.threadId });
  const file = path.join(ctx.workspace, binding!.relativePath!);
  const payload = JSON.parse(await readFile(file, "utf8"));
  expect(payload.source).toEqual({ name: "Horaris.xlsm", sha256: result.sha256, checkedAt: result.checkedAt });
  expect(payload.sheets).toEqual(preview.sheets);
  await writeFile(file, "corrupt");
  await expect(createSpreadsheetArtifact(result, ctx)).rejects.toThrow("readback");
});

it("does not persist unavailable reads, later chunks or malformed grids", async () => {
  const ctx = await context();
  for (const changed of [{ ...result, available: false }, { ...result, part: 2 }, { ...result, scope: "private" },
    { ...result, sha256: "bad" }, { ...result, preview: { ...preview, sheets: [] } }]) {
    expect(await createSpreadsheetArtifact(changed, ctx)).toBeNull();
  }
  expect(isSpreadsheetPreview({ ...preview, sheets: [{ ...preview.sheets[0], cells: [{ address: "A1", value: "x".repeat(60001) }] }] })).toBe(false);
  const outside = await context();
  await symlink(outside.workspace, path.join(ctx.workspace, "document-previews"));
  await expect(createSpreadsheetArtifact(result, ctx)).rejects.toThrow("Unsafe");
});

it("calls the preview hook only after an authorized successful server read and preserves text on preview failure", async () => {
  const params = { namespace: "aibrain_company_files", tool: "read", threadId: "thread", turnId: "turn", callId: "call", arguments: { scope: "company", path: result.path } };
  let emitted = 0;
  const ctx = { network: {}, roots: [], runtimeThreadId: "thread", runtimeTurnId: "turn", serverFiles: { read: async () => result },
    onServerRead: async () => { emitted++; throw new Error("disk unavailable"); } };
  const response = await handleCompanyFilesDynamicToolCall(params as never, ctx as never);
  expect(response.success).toBe(true);
  expect(JSON.stringify(response)).toContain("previewWarning");
  expect(JSON.stringify(response)).toContain("09:00");
  expect(emitted).toBe(1);
  await handleCompanyFilesDynamicToolCall({ ...params, turnId: "foreign" } as never, ctx as never);
  await handleCompanyFilesDynamicToolCall(params as never, { ...ctx, serverFiles: { read: async () => ({ available: false }) } } as never);
  expect(emitted).toBe(1);
});
