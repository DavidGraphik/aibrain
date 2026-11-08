import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist/trinalum-recover-unbound.cjs");
await build({ entryPoints: [path.join(root, "scripts/recover-trinalum-unbound-starts.ts")], outfile, bundle: true, platform: "node", format: "cjs", target: "node24", conditions: ["react-server", "node", "require"], alias: { "@": path.join(root, "src") }, legalComments: "none" });
const smoke = spawnSync(process.execPath, [outfile], { encoding: "utf8", timeout: 30_000 });
if (smoke.status !== 1 || !smoke.stderr.startsWith("Use --output-dir")) throw new Error("Trinalum recovery operator runtime smoke test failed");
