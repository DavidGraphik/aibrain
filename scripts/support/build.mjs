import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
await build({
  entryPoints: [path.join(root, "scripts/support/control.ts")],
  outfile: path.join(root, "dist/support-control.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node24",
  conditions: ["react-server", "node", "require"],
  alias: { "@": path.join(root, "src") }, legalComments: "none",
});
