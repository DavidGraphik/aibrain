import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";

it("recovers a journal larger than the worker heap without losing pending events", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aibrain-journal-bundle-"));
  try {
    const outfile = path.join(directory, "verify.mjs");
    await build({ entryPoints: [path.resolve("tests/fixtures/transport-journal-memory.ts")],
      outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
    const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=128", outfile],
      { timeout: 60_000, maxBuffer: 4096 });
    const receipt = JSON.parse(stdout.trim());
    expect(receipt).toMatchObject({ outcome: "PASS", verifiedPendingEvents: 83, heapLimitMiB: 128 });
    expect(receipt.originalBytes).toBeGreaterThan(160 * 1024 * 1024);
    expect(receipt.pages).toBeGreaterThan(20);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);
