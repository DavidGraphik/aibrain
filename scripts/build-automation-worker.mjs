import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repositoryRoot, "dist", "automation-worker.mjs");

await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
// The previous artifact is read-only by design. Make just that generated file
// replaceable while rebuilding; the runtime image is made immutable afterwards.
await chmod(output, 0o644).catch((error) => {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
  throw error;
});
await build({
  entryPoints: [path.join(repositoryRoot, "scripts", "run-automations.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["react-server", "node", "import"],
  alias: { "@": path.join(repositoryRoot, "src") },
  legalComments: "none",
  // Some server dependencies (notably ws) still contain CommonJS dynamic
  // requires. Give the ESM bundle a Node-native require without weakening the
  // browser/server module boundary.
  banner: {
    js: `// Generated at image-build time. Do not edit.
import { createRequire as __aibrainCreateRequire } from "node:module";
const require = __aibrainCreateRequire(import.meta.url);`,
  },
});

// `server-only` is a conditional marker. Resolving it under react-server while
// bundling proves the independent worker has no Next/client sentinel at runtime.
const bundle = await readFile(output, "utf8");
if (bundle.includes("This module cannot be imported from a Client Component")) {
  throw new Error("automation worker retained the server-only client sentinel");
}
const smoke = spawnSync(process.execPath, [output, "--bundle-smoke-test"], {
  encoding: "utf8",
  timeout: 30_000,
});
if (smoke.status !== 1 || !smoke.stderr.includes("Argumento desconocido: --bundle-smoke-test")) {
  const detail = smoke.stderr.trim() || smoke.error?.message || `status=${String(smoke.status)} signal=${String(smoke.signal)}`;
  throw new Error(`automation worker bundle failed its Node runtime smoke test: ${detail}`);
}
await chmod(output, 0o555);
