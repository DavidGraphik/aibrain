import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FilePublicationCapacityGate,
} from "@/documents/publication-capacity";

const roots: string[] = [];

async function fixture(readCapacity: () => Promise<{ bavail: bigint; bsize: bigint; blocks: bigint }>) {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-publication-capacity-"));
  roots.push(root);
  return new FilePublicationCapacityGate({
    rootDirectory: path.join(root, "locks"),
    capacityRoot: path.join(root, "publish-rw"),
    minimumFreeBytes: 1_000,
    minimumFreeRatioPpm: 100_000,
    retryAfterMs: 2_000,
    readCapacity,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FilePublicationCapacityGate", () => {
  it("holds admission through the operation when the publication volume has headroom", async () => {
    const gate = await fixture(async () => ({ bavail: 2_000n, bsize: 1n, blocks: 10_000n }));
    await expect(gate.run(500, async () => "published")).resolves.toBe("published");
  });

  it("returns typed retryable backpressure before calling the publisher", async () => {
    const gate = await fixture(async () => ({ bavail: 1_499n, bsize: 1n, blocks: 10_000n }));
    let called = false;
    await expect(gate.run(500, async () => {
      called = true;
    })).rejects.toMatchObject({
      code: "PUBLICATION_STORAGE_BACKPRESSURE",
      retryable: true,
      retryAfterMs: 2_000,
    });
    expect(called).toBe(false);
  });

  it("fails closed when capacity cannot be measured", async () => {
    const gate = await fixture(async () => { throw new Error("synthetic statfs failure"); });
    await expect(gate.run(1, async () => undefined)).rejects.toMatchObject({
      code: "PUBLICATION_STORAGE_CAPACITY_UNAVAILABLE",
      retryable: true,
    });
  });
});
