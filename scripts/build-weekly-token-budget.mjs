import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist", "initialize-weekly-token-budget.mjs");
await mkdir(path.dirname(outfile), { recursive: true });
await chmod(outfile, 0o644).catch((error) => { if (error.code !== "ENOENT") throw error; });
await build({ entryPoints: [path.join(root, "scripts/initialize-weekly-token-budget.ts")], outfile,
  bundle: true, platform: "node", format: "esm", target: "node24", conditions: ["react-server", "node", "import"],
  alias: { "@": path.join(root, "src") }, legalComments: "none" });
const smoke = spawnSync(process.execPath, [outfile], { encoding: "utf8", timeout: 30_000 });
if (smoke.status !== 1 || !smoke.stderr.includes("Use --offline [--apply]")) {
  throw new Error(`weekly budget initializer failed its Node runtime smoke test: ${smoke.stderr || smoke.error?.message}`);
}
await chmod(outfile, 0o555);
