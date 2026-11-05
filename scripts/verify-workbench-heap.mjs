import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2]);
// An optional exact base commit allows RED/GREEN with the identical fixture
// and runtime imports, without checking out or modifying the active source.
const baselineRef = process.argv[3];
if (baselineRef && !/^[0-9a-f]{40}$/.test(baselineRef)) throw new Error("Baseline must be a full commit SHA");
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await build({
  entryPoints: [path.join(repository, "tests/fixtures/workbench-heap.ts")], outfile: output,
  bundle: true, platform: "node", format: "esm", target: "node24", conditions: ["react-server", "node", "import"],
  alias: { "@": path.join(repository, "src") },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  plugins: [{ name: "synthetic-inference", setup(builder) {
    if (baselineRef) builder.onLoad({ filter: /\/src\/(workbench\/(filesystem-store|shared-access|store)|storage\/atomic-file)\.ts$/ }, ({ path: sourcePath }) => {
      const relative = path.relative(repository, sourcePath);
      const source = spawnSync("git", ["show", `${baselineRef}:${relative}`], { cwd: repository, encoding: "utf8", maxBuffer: 1024 * 1024 });
      if (source.status !== 0) throw new Error(source.stderr);
      return { contents: source.stdout, loader: "ts" };
    });
    builder.onLoad({ filter: /\/worker-codex-turn\.ts$/ }, async ({ path: sourcePath }) => {
      const source = await readFile(sourcePath, "utf8");
      const marker = "  let submission: DurableTurnSubmission | null = null;";
      if (!source.includes(marker)) throw new Error("Synthetic runtime boundary was not found");
      return { contents: source.replace(marker, `
  if (process.env.AIBRAIN_HEAP_FIXTURE === "1") {
    const fixtureGlobal = globalThis as typeof globalThis & { __aibrainHeapInferenceCalls?: number };
    fixtureGlobal.__aibrainHeapInferenceCalls = (fixtureGlobal.__aibrainHeapInferenceCalls ?? 0) + 1;
    await emit({ type: "content", value: "SYNTHETIC-HEAP-OK" });
    await emit({ type: "done" });
    return;
  }
${marker}`), loader: "ts" };
    });
  } }],
});
