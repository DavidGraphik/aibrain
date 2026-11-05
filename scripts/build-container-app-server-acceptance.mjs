import { build } from "esbuild";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repositoryRoot, "dist", "container-app-server-acceptance.mjs");

await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
await chmod(output, 0o644).catch((error) => {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
  throw error;
});
await build({
  entryPoints: [path.join(repositoryRoot, "scripts", "container-app-server-acceptance.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["react-server", "node", "import"],
  alias: { "@": path.join(repositoryRoot, "src") },
  legalComments: "none",
  banner: {
    js: `// Generated at image-build time. Do not edit.
import { createRequire as __aibrainCreateRequire } from "node:module";
const require = __aibrainCreateRequire(import.meta.url);`,
  },
});

const bundle = await readFile(output, "utf8");
if (bundle.includes("This module cannot be imported from a Client Component")) {
  throw new Error("container App Server acceptance retained the server-only client sentinel");
}
await chmod(output, 0o555);
