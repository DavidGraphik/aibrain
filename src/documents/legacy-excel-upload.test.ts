import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ResourceLockManager } from "@/storage/resource-lock";
import { FileDocumentStagingStore } from "./staging-store";
import { stageLegacyExcelUpload } from "./legacy-excel-upload";
import { inspectLegacyExcelForStorage } from "./legacy-excel-validation";
import { ServerTurnDocumentInputResolver, prepareTurnDocumentWorkspaceInputs } from "./turn-attachments";

const threadId = "11111111-1111-4111-8111-111111111111";
const uploadId = "22222222-2222-4222-8222-222222222222";

describe("XLS storage independent of processing", () => {
  it.each(["encrypted", "older-biff"])("preserves %s without invoking a processor or exposing the original", async mode => {
    const root = await mkdtemp(path.join(tmpdir(), "xls-receipt-"));
    try {
      const bytes = await readFile("tests/fixtures/legacy-passive-links-macros.xls");
      const bof = bytes.indexOf(Buffer.from("0908100000060500", "hex"));
      expect(bof).toBeGreaterThan(0);
      if (mode === "encrypted") bytes.writeUInt16LE(0x002f, bof + 20);
      else bytes.writeUInt16LE(0x0500, bof + 4);
      const source = path.join(root, "source.xls");
      await writeFile(source, bytes, { mode: 0o600 });
      const locks = new ResourceLockManager({ rootDirectory: path.join(root, "locks") });
      const staging = new FileDocumentStagingStore(path.join(root, "staging"), locks);
      const originals = new FileDocumentStagingStore(path.join(root, "originals"), locks);
      const run = vi.fn();
      const options = { locks, staging, originals, reader: "/tools/passive", soffice: "/tools/office", runner: { run }, conversionGate: { run: async <T>(op: () => Promise<T>) => op() } };
      const input = { threadId, uploadId, size: bytes.length, filePath: source, fileName: "source.xls", declaredMimeType: "application/octet-stream" };
      const document = await stageLegacyExcelUpload(input, options);
      expect(document.storedLegacyExcel?.status).toBe("unavailable");
      expect(document.kind).toBe("text");
      expect(run).not.toHaveBeenCalled();
      expect(await readFile((await originals.resolveContentById(threadId, uploadId)).absolutePath)).toEqual(bytes);
      const resolver = new ServerTurnDocumentInputResolver({ stagingRoot: staging.rootDirectory, pdftotext: "/tools/pdf", previews: { read: vi.fn(), readFile: vi.fn() } });
      const inputs = await resolver.resolve(document);
      expect(JSON.stringify(inputs)).toContain("no contiene celdas ni resultados");
      expect(JSON.stringify(inputs)).not.toContain("INERT_TEST_VBA_PAYLOAD");
      const workspace = await prepareTurnDocumentWorkspaceInputs({ documents: [{ document, codexInputs: inputs, absolutePath: path.join(staging.rootDirectory, document.relativePath) }], projectWorkspace: root, stagingRoot: staging.rootDirectory });
      expect(workspace).toEqual({ directory: null, codexInputs: [] });
      expect(await stageLegacyExcelUpload(input, options)).toEqual(document);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("continues to reject truncated, cyclic and renamed non-workbooks before storage", async () => {
    const valid = await readFile("tests/fixtures/legacy-passive-links-macros.xls");
    const corrupt = Buffer.from(valid); corrupt.writeUInt32LE(0xffffffff, 48);
    for (const bytes of [valid.subarray(0, -1), corrupt, Buffer.from("MZ executable, not XLS")]) {
      expect(() => inspectLegacyExcelForStorage(bytes)).toThrow();
    }
  });
});
