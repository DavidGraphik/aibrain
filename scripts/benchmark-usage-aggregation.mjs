// CPU-only benchmark of the actual aggregation functions; no user data or IO is timed.
// Usage: node scripts/benchmark-usage-aggregation.mjs <baseline-git-revision>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";

const file = "src/usage/file-usage-store.ts";
const revision = process.argv[2];
if (!revision) throw new Error("Pass a baseline Git revision.");
const baseline = execFileSync("git", ["show", `${revision}:${file}`], { encoding: "utf8" });
const current = readFileSync(file, "utf8");
const tokens = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
  cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
function load(source) {
  const start = source.indexOf("function percentile(");
  const end = source.indexOf("function snapshotComparable(");
  assert.ok(start >= 0 && end > start, "Aggregation source boundaries changed");
  const { code } = transformSync(source.slice(start, end).replace("export function", "function"), { loader: "ts" });
  return new Function("zeroTokenUsage", `${code}; return aggregateTurnUsage;`)(tokens);
}
const before = load(baseline);
const after = load(current);
let equivalenceCases = 0;
for (const count of [0, 1, 19, 20, 21, 99, 100, 101, 10_000, 100_000]) {
  const records = Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
    userId: index % 2,
    durationMs: index % 5 === 0 ? 0 : ((index * 7919) % 120_000) / 10,
    firstTextMs: index % 3 === 0 ? null : index % 7 === 0 ? 0 : (index * 101) % 3000,
    status: ["completed", "error", "stopped"][index % 3],
    startedAt: `2026-08-${String(index % 28 + 1).padStart(2, "0")}T10:00:00.000Z`,
    tokenUsage: index % 4 === 0 ? null : Object.freeze(Object.fromEntries(
      Object.keys(tokens).map((key, field) => [key, (index * (field + 1)) % 1000]),
    )),
  })));
  for (const subset of [records, records.filter((r) => r.userId === 0),
    records.filter((r) => r.status === "error"), records.filter((r) => r.firstTextMs === null),
    records.filter((r) => r.startedAt.slice(0, 10) >= "2026-08-20")]) {
    assert.deepEqual(after(subset), before(subset));
    equivalenceCases += 1;
  }
}
console.log(JSON.stringify({ equivalenceCases, frozenInputs: true, exact: true }));
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
for (const count of [0, 1, 100, 10_000, 100_000]) {
  const records = Array.from({ length: count }, (_, index) => ({
    durationMs: (index * 7919) % 120_000,
    firstTextMs: index % 3 === 0 ? null : (index * 101) % 3000,
    status: ["completed", "error", "stopped"][index % 3],
    startedAt: `2026-08-${String(index % 28 + 1).padStart(2, "0")}T10:00:00.000Z`,
    tokenUsage: index % 4 === 0 ? null : { ...tokens, totalTokens: 100, inputTokens: 70, outputTokens: 30 },
  }));
  assert.deepEqual(after(records), before(records));
  const repetitions = Math.max(1, Math.floor(10_000 / Math.max(1, count)));
  for (let i = 0; i < 10 * repetitions; i++) { before(records); after(records); }
  const samples = [[], []];
  for (let i = 0; i < 15; i++) {
    for (const slot of i % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      const aggregate = slot === 0 ? before : after;
      for (let repeat = 0; repeat < repetitions; repeat++) aggregate(records);
      samples[slot].push((performance.now() - start) / repetitions);
    }
  }
  const baselineMs = median(samples[0]);
  const currentMs = median(samples[1]);
  console.log(JSON.stringify({ count, baselineMs, currentMs, speedup: baselineMs / currentMs, equivalent: true }));
}
