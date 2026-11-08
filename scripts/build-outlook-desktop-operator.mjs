import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "outlook-desktop-operator.mjs");
await mkdir(path.dirname(output), { recursive: true });
await chmod(output, 0o644).catch(error => { if (error.code !== "ENOENT") throw error; });
await build({ entryPoints: [path.join(root, "scripts/manage-outlook-desktop.ts")], outfile: output, bundle: true,
  platform: "node", format: "esm", target: "node24", conditions: ["react-server", "node", "import"],
  alias: { "@": path.join(root, "src") }, legalComments: "none",
  banner: { js: 'import { createRequire as __outlookCreateRequire } from "node:module";\nconst require = __outlookCreateRequire(import.meta.url);' } });
if ((await readFile(output, "utf8")).includes("This module cannot be imported from a Client Component")) throw Error("OUTLOOK_OPERATOR_SERVER_BOUNDARY_INVALID");
const smoke = spawnSync(process.execPath, [output, "--bundle-smoke-test"], { encoding: "utf8", timeout: 15_000 });
if (smoke.status !== 1 || smoke.stderr.trim() !== "OUTLOOK_DESKTOP_CLI_ARGUMENTS_INVALID") throw Error("OUTLOOK_OPERATOR_BUNDLE_SMOKE_FAILED");
await chmod(output, 0o555);
