import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("handles eight cold metadata reads of one 29MB Unicode history within one bounded heap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-access-concurrency-"));
  const bundle = path.join(root, "fixture.mjs"), data = path.join(root, "data");
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, AIBRAIN_HEAP_FIXTURE_BYTES: "29166280", AIBRAIN_HEAP_FIXTURE_CONCURRENCY: "8" },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  };
  const heap = ["--max-old-space-size=384", "--max-semi-space-size=16", bundle];
  try {
    run(["scripts/verify-workbench-heap.mjs", bundle]);
    expect(run([...heap, "setup", data])[0]).toMatchObject({ targetBytes: 29_166_280 });
    const results = run([...heap, "access-burst", data]);
    expect(results.at(-1)).toMatchObject({ stage: "access-burst-complete", heapLimit: 432 * 1024 * 1024 });
    expect(results.every(({ maxRssKiB }) => maxRssKiB < 768 * 1024)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
