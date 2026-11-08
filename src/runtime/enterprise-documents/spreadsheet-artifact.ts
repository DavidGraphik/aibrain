import { createHash } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { DocumentArtifact } from "@/lib/chat-contract";
import { isSpreadsheetPreview } from "@/documents/spreadsheet-preview";
import { FileLibraryResourceLocationIndex } from "@/library/resource-location-index";
import { readRegularFileWithin } from "@/security/safe-file";
import { generatedDocumentArtifactId } from "@/runtime/generated-document-artifacts";

type Context = {
  installationId: string; dataRoot: string; userId: string; projectId: string;
  threadId: string; messageId: string; workspace: string;
};

/** Called only after a turn-authorized, hash-verified server read, never on model-supplied data. */
export async function createSpreadsheetArtifact(result: Record<string, unknown>, context: Context): Promise<DocumentArtifact | null> {
  if (result.available !== true || result.scope !== "company" || result.part !== 1 ||
      typeof result.path !== "string" || !/\.xls[mx]$/i.test(result.path) ||
      typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.sha256) ||
      typeof result.checkedAt !== "string" || !Number.isFinite(Date.parse(result.checkedAt)) ||
      !isSpreadsheetPreview(result.preview)) return null;
  const name = decodeURIComponent(result.path.split("/").at(-1)!).slice(0, 120);
  const data = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "spreadsheet",
    truncated: result.preview.truncated, sheets: result.preview.sheets.map((sheet) => ({
      name: sheet.name, hidden: sheet.hidden, cells: sheet.cells.map(({ address, value }) => ({ address, value })),
    })), source: {
    name, sha256: result.sha256, checkedAt: result.checkedAt,
  } }));
  const sha256 = createHash("sha256").update(data).digest("hex");
  const id = generatedDocumentArtifactId(context.messageId, `${result.path}\0${sha256}`);
  const directory = path.join(context.workspace, "document-previews");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== path.join(await realpath(context.workspace), "document-previews")) {
    throw new Error("Unsafe preview directory");
  }
  const relativePath = `document-previews/${id}.json`;
  try {
    const file = await open(path.join(directory, `${id}.json`), "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stored = await readRegularFileWithin(context.workspace, relativePath, 100_000);
  if (!stored.equals(data)) throw new Error("Preview readback mismatch");
  const index = new FileLibraryResourceLocationIndex({ installationId: context.installationId, dataRoot: context.dataRoot });
  await index.register({ kind: "workspace-file", resourceId: id, projectId: context.projectId,
    threadId: context.threadId, messageId: context.messageId, storageOwnerId: context.userId,
    relativePath, fileName: `${name.slice(0, 100)}.preview.json`, mediaType: "application/json", size: data.length, sha256 });
  const url = `/api/projects/${context.projectId}/files?path=${encodeURIComponent(relativePath)}&raw=1&download=1&resourceId=${id}`;
  return { id, type: "document", name, url, kind: "text", mimeType: "application/json", size: data.length,
    status: "ready", pages: null, previewUrl: url, previewFormat: "spreadsheet", publicationStatus: null,
    publicationError: null, targetLabel: null, error: null };
}
