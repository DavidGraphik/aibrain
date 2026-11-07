import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("creates and recovers a scheduled turn with a 62.6 MB Unicode workbench under a 432 MiB heap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-workbench-heap-"));
  const bundle = path.join(root, "fixture.mjs");
  const data = path.join(root, "fixture");
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  const heap = ["--max-old-space-size=384", "--max-semi-space-size=16", bundle];
  try {
    run(["scripts/verify-workbench-heap.mjs", bundle]);
    expect(run([...heap, "setup", data])[0]).toMatchObject({ targetBytes: 62_627_367 });
    expect(run([...heap, "runtime", data]).at(-1)).toMatchObject({ stage: "runtime-context", heapLimit: 432 * 1024 * 1024 });
    expect(run([...heap, "prepare", data]).at(-1)).toMatchObject({ stage: "prepared-turn", heapLimit: 432 * 1024 * 1024 });
    const results = run([...heap, "scheduled", data]);
    expect(results.map(({ stage }) => stage)).toEqual(["start", "scheduled-turn", "recovered-turn", "write-limit-preserved"]);
    expect(results.every(({ heapLimit }) => heapLimit === 432 * 1024 * 1024)).toBe(true);
    expect(results.every(({ maxRssKiB }) => maxRssKiB < 768 * 1024)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
