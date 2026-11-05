import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileDocumentConversionGate } from "@/documents/conversion-gate";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const created = await mkdtemp(path.join(tmpdir(), "aibrain-conversion-gate-"));
  roots.push(created);
  return created;
}

describe("installation-wide document conversion admission", () => {
  it("applies fail-fast backpressure across independent gate instances", async () => {
    const gateRoot = await root();
    const first = new FileDocumentConversionGate({ rootDirectory: gateRoot, maxConcurrent: 1, retryAfterMs: 2_500 });
    const second = new FileDocumentConversionGate({ rootDirectory: gateRoot, maxConcurrent: 1, retryAfterMs: 2_500 });
    let release!: () => void;
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => { admitted = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const running = first.run(async () => {
      admitted();
      await held;
      return "first";
    });
    await started;

    await expect(second.run(() => "second")).rejects.toMatchObject({
      code: "DOCUMENT_CONVERSION_BACKPRESSURE",
      retryable: true,
      retryAfterMs: 2_500,
    });
    release();
    await expect(running).resolves.toBe("first");
    await expect(second.run(() => "second")).resolves.toBe("second");
  });

  it("releases the shared slot when conversion fails", async () => {
    const gateRoot = await root();
    const gate = new FileDocumentConversionGate({ rootDirectory: gateRoot, maxConcurrent: 1 });
    await expect(gate.run(() => { throw new Error("synthetic conversion failure"); }))
      .rejects.toThrow("synthetic conversion failure");
    await expect(gate.run(() => "recovered")).resolves.toBe("recovered");
  });

  it("rejects invalid operational capacity rather than silently widening it", async () => {
    const gateRoot = await root();
    expect(() => new FileDocumentConversionGate({ rootDirectory: gateRoot, maxConcurrent: 0 }))
      .toThrow(expect.objectContaining({ code: "DOCUMENT_CONVERSION_GATE_INVALID" }));
    expect(() => new FileDocumentConversionGate({ rootDirectory: gateRoot, maxConcurrent: 65 }))
      .toThrow(expect.objectContaining({ code: "DOCUMENT_CONVERSION_GATE_INVALID" }));
  });
});
