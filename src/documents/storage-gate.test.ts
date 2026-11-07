import { mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileDocumentStorageGate } from "@/documents/storage-gate";
import { UploadValidationError, validateUploadedDocumentFile } from "@/documents/upload-validation";

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), statfs: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-document-storage-gate-"));
  roots.push(root);
  return { root, lockRoot: path.join(root, "locks") };
}

describe("installation-wide document storage admission", () => {
  it.each([7_631_003_648n, 0n])("admits a 63748-byte synthetic PDF without reserving headroom (%s available)", async (available) => {
    const { root, lockRoot } = await fixture();
    vi.stubEnv("AIBRAIN_MINIMUM_FREE_RATIO", "0.20");
    vi.stubEnv("AIBRAIN_MINIMUM_FREE_BYTES", "1073741824");
    vi.stubEnv("AIBRAIN_DOCUMENT_WORST_CASE_ACTIVE_BYTES", "536870912");
    vi.mocked(statfs).mockResolvedValue({ bavail: available, blocks: 39_964_635_136n, bsize: 1n } as never);
    const gate = new FileDocumentStorageGate({ rootDirectory: lockRoot, maxActiveUploads: 1 });
    const bytes = Buffer.alloc(63_748, 0x20);
    bytes.write("%PDF-1.4\n");
    const filePath = path.join(root, "synthetic.pdf");
    const validated = await gate.run(async () => {
      await writeFile(filePath, bytes, { mode: 0o600 });
      return validateUploadedDocumentFile({ filePath, fileName: "synthetic.pdf", declaredMimeType: "application/pdf" });
    });
    expect(validated).toMatchObject({ kind: "pdf", size: 63_748 });
    expect(await readFile(filePath)).toEqual(bytes);
    expect(statfs).not.toHaveBeenCalled();
  });

  it("applies active-upload backpressure across independent instances", async () => {
    const { lockRoot } = await fixture();
    const options = { rootDirectory: lockRoot, maxActiveUploads: 1 };
    const first = new FileDocumentStorageGate(options);
    const second = new FileDocumentStorageGate(options);
    let started!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const running = first.run(async () => { started(); await held; return "first"; });
    await admitted;
    await expect(second.run(() => "second")).rejects.toMatchObject({ code: "DOCUMENT_STORAGE_BACKPRESSURE", reason: "busy" });
    release();
    await expect(running).resolves.toBe("first");
    await expect(second.run(() => "second")).resolves.toBe("second");
  });

  it.each(["ENOSPC", "EDQUOT"])("reports a real %s write failure and releases its slot", async (code) => {
    const { lockRoot } = await fixture();
    const gate = new FileDocumentStorageGate({ rootDirectory: lockRoot, maxActiveUploads: 1 });
    const physicalError = Object.assign(new Error("synthetic filesystem failure"), { code });
    let attempted = false;
    await expect(gate.run(() => {
      attempted = true;
      throw new UploadValidationError("UPLOAD_MULTIPART_INVALID", "wrapped write failure", { cause: physicalError });
    })).rejects.toMatchObject({ code: "DOCUMENT_STORAGE_FULL", cause: { cause: physicalError } });
    expect(attempted).toBe(true);
    await expect(new FileDocumentStorageGate({ rootDirectory: lockRoot, maxActiveUploads: 1 }).run(() => "retry")).resolves.toBe("retry");
  });

  it("preserves other validation and filesystem errors", async () => {
    const { lockRoot } = await fixture();
    const gate = new FileDocumentStorageGate({ rootDirectory: lockRoot });
    for (const error of [new UploadValidationError("UPLOAD_SIZE_INVALID", "too large"), Object.assign(new Error("permission denied"), { code: "EACCES" })]) {
      await expect(gate.run(() => { throw error; })).rejects.toBe(error);
    }
  });

  it("rejects unsafe roots and invalid slot settings", async () => {
    const { lockRoot } = await fixture();
    expect(() => new FileDocumentStorageGate({ rootDirectory: path.parse(lockRoot).root }))
      .toThrow(expect.objectContaining({ code: "DOCUMENT_STORAGE_GATE_INVALID" }));
    expect(() => new FileDocumentStorageGate({ rootDirectory: lockRoot, maxActiveUploads: 65 }))
      .toThrow(expect.objectContaining({ code: "DOCUMENT_STORAGE_GATE_INVALID" }));
  });
});
