import { mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileDocumentStorageGate } from "@/documents/storage-gate";
import { UploadValidationError, validateUploadedDocumentFile } from "@/documents/upload-validation";

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), statfs: vi.fn(),
}));
const roots: string[] = [];
beforeEach(() => {
  vi.mocked(statfs).mockReset();
  vi.mocked(statfs).mockResolvedValue({ bavail: 1_000_000_000n, bsize: 1n } as never);
});
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
  it.each([7_631_003_648n, 1_000_000_000n])("admits at or above the independent decimal 1 GB floor (%s available)", async (available) => {
    const { root, lockRoot } = await fixture();
    vi.stubEnv("AIBRAIN_MINIMUM_FREE_RATIO", "0.95");
    vi.stubEnv("AIBRAIN_MINIMUM_FREE_BYTES", "999999999999");
    vi.stubEnv("AIBRAIN_DOCUMENT_WORST_CASE_ACTIVE_BYTES", "999999999999");
    vi.mocked(statfs).mockResolvedValue({ bavail: available, blocks: 39_964_635_136n, bsize: 1n } as never);
    const gate = new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [root], maxActiveUploads: 1 });
    const bytes = Buffer.alloc(63_748, 0x20);
    bytes.write("%PDF-1.4\n");
    const filePath = path.join(root, "synthetic.pdf");
    const validated = await gate.run(async () => {
      await writeFile(filePath, bytes, { mode: 0o600 });
      return validateUploadedDocumentFile({ filePath, fileName: "synthetic.pdf", declaredMimeType: "application/pdf" });
    });
    expect(validated).toMatchObject({ kind: "pdf", size: 63_748 });
    expect(await readFile(filePath)).toEqual(bytes);
    expect(statfs).toHaveBeenCalledWith(root, { bigint: true });
  });

  it.each([0n, 999_999_999n])("rejects below 1 GB before the operation and releases the slot (%s available)", async (available) => {
    const { root, lockRoot } = await fixture();
    const gate = new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [root], maxActiveUploads: 1 });
    const operation = vi.fn();
    vi.mocked(statfs).mockResolvedValueOnce({ bavail: available, bsize: 1n } as never);
    await expect(gate.run(operation)).rejects.toMatchObject({ code: "DOCUMENT_STORAGE_CAPACITY_LOW", availableBytes: available, requiredBytes: 1_000_000_000n });
    expect(operation).not.toHaveBeenCalled();
    await expect(gate.run(() => "released")).resolves.toBe("released");
  });

  it("checks every actual destination independently of the lock filesystem", async () => {
    const { root, lockRoot } = await fixture();
    const preview = path.join(root, "preview");
    vi.mocked(statfs).mockImplementation(async (directory) => ({ bavail: directory === preview ? 244_140n : 1_000_000_000n, bsize: directory === preview ? 4096n : 1n } as never));
    const gate = new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [root, preview, root] });
    const operation = vi.fn();
    await expect(gate.run(operation)).rejects.toMatchObject({ code: "DOCUMENT_STORAGE_CAPACITY_LOW", availableBytes: 999_997_440n });
    expect(operation).not.toHaveBeenCalled();
    expect(vi.mocked(statfs).mock.calls.map(call => call[0])).toEqual([root, preview]);
  });

  it.each(["EACCES", "EIO", "ENOSPC"])("fails closed when capacity measurement fails (%s), without inventing availability", async (code) => {
    const { root, lockRoot } = await fixture();
    const gate = new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [root], maxActiveUploads: 1 });
    const error = Object.assign(new Error("measurement failed"), { code });
    const operation = vi.fn();
    vi.mocked(statfs).mockRejectedValueOnce(error);
    await expect(gate.run(operation)).rejects.toMatchObject({ code: "DOCUMENT_STORAGE_CAPACITY_UNAVAILABLE", cause: error });
    expect(operation).not.toHaveBeenCalled();
    await expect(gate.run(() => "released")).resolves.toBe("released");
  });

  it.each([{ bavail: -1n, bsize: 1n }, { bavail: 1n, bsize: 0n }, { bavail: 1_000_000_000, bsize: 1 }])("rejects invalid filesystem capacity (%s)", async (capacity) => {
    const { root, lockRoot } = await fixture();
    vi.mocked(statfs).mockResolvedValueOnce(capacity as never);
    await expect(new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [root] }).run(vi.fn()))
      .rejects.toMatchObject({ code: "DOCUMENT_STORAGE_CAPACITY_UNAVAILABLE" });
  });

  it("measures the existing parent for an as-yet uncreated upload destination", async () => {
    const { root, lockRoot } = await fixture();
    const destination = path.join(root, "new-user", "uploads");
    vi.mocked(statfs).mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [destination] }).run(() => "admitted")).resolves.toBe("admitted");
    expect(vi.mocked(statfs).mock.calls.map(call => call[0])).toEqual([destination, path.dirname(destination), root]);
  });

  it("applies active-upload backpressure across independent instances", async () => {
    const { lockRoot } = await fixture();
    const options = { rootDirectory: lockRoot, capacityDirectories: [lockRoot], maxActiveUploads: 1 };
    const first = new FileDocumentStorageGate(options);
    const second = new FileDocumentStorageGate(options);
    let started!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const running = first.run(async () => { started(); await held; return "first"; });
    await admitted;
    await expect(second.run(() => "second")).rejects.toMatchObject({ code: "DOCUMENT_STORAGE_BACKPRESSURE", reason: "busy" });
    expect(statfs).toHaveBeenCalledTimes(1);
    release();
    await expect(running).resolves.toBe("first");
    await expect(second.run(() => "second")).resolves.toBe("second");
  });

  it.each(["ENOSPC", "EDQUOT"])("reports a real %s write failure and releases its slot", async (code) => {
    const { lockRoot } = await fixture();
    const gate = new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [lockRoot], maxActiveUploads: 1 });
    const physicalError = Object.assign(new Error("synthetic filesystem failure"), { code });
    let attempted = false;
    await expect(gate.run(() => {
      attempted = true;
      throw new UploadValidationError("UPLOAD_MULTIPART_INVALID", "wrapped write failure", { cause: physicalError });
    })).rejects.toMatchObject({ code: "DOCUMENT_STORAGE_FULL", cause: { cause: physicalError } });
    expect(attempted).toBe(true);
    await expect(new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [lockRoot], maxActiveUploads: 1 }).run(() => "retry")).resolves.toBe("retry");
  });

  it("preserves other validation and filesystem errors", async () => {
    const { lockRoot } = await fixture();
    const gate = new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [lockRoot] });
    for (const error of [new UploadValidationError("UPLOAD_SIZE_INVALID", "too large"), Object.assign(new Error("permission denied"), { code: "EACCES" })]) {
      await expect(gate.run(() => { throw error; })).rejects.toBe(error);
    }
  });

  it("rejects unsafe roots and invalid slot settings", async () => {
    const { lockRoot } = await fixture();
    expect(() => new FileDocumentStorageGate({ rootDirectory: path.parse(lockRoot).root, capacityDirectories: [lockRoot] }))
      .toThrow(expect.objectContaining({ code: "DOCUMENT_STORAGE_GATE_INVALID" }));
    expect(() => new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [] }))
      .toThrow(expect.objectContaining({ code: "DOCUMENT_STORAGE_GATE_INVALID" }));
    expect(() => new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: ["relative"] }))
      .toThrow(expect.objectContaining({ code: "DOCUMENT_STORAGE_GATE_INVALID" }));
    expect(() => new FileDocumentStorageGate({ rootDirectory: lockRoot, capacityDirectories: [lockRoot], maxActiveUploads: 65 }))
      .toThrow(expect.objectContaining({ code: "DOCUMENT_STORAGE_GATE_INVALID" }));
  });
});
