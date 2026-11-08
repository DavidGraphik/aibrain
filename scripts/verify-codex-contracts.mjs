import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const version = "0.162.1";
const generationTimeoutMs = 360_000;
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const checkedRoot = path.join(repositoryRoot, "contracts", "codex", version);
const generatedRoot = mkdtempSync(path.join(tmpdir(), "aibrain-codex-contracts-"));

function files(root, relative = "") {
  return readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(relative, entry.name);
      return entry.isDirectory() ? files(root, child) : [child];
    })
    .sort();
}

function compareDirectory(name) {
  const checked = path.join(checkedRoot, name);
  const generated = path.join(generatedRoot, name);
  const checkedFiles = files(checked);
  const generatedFiles = files(generated);
  if (JSON.stringify(checkedFiles) !== JSON.stringify(generatedFiles)) {
    throw new Error(`${name} file list differs from Codex ${version}.`);
  }
  for (const relative of checkedFiles) {
    const expected = readFileSync(path.join(generated, relative));
    const actual = readFileSync(path.join(checked, relative));
    if (!actual.equals(expected)) {
      throw new Error(`${name}/${relative} differs from Codex ${version}.`);
    }
  }
}

try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const base = ["exec", "--yes", `--package=@openai/codex@${version}`, "--", "codex", "app-server"];
  execFileSync(npm, [...base, "generate-ts", "--experimental", "--out", path.join(generatedRoot, "types")], {
    cwd: repositoryRoot,
    stdio: "inherit",
    timeout: generationTimeoutMs,
  });
  execFileSync(npm, [...base, "generate-json-schema", "--experimental", "--out", path.join(generatedRoot, "schema")], {
    cwd: repositoryRoot,
    stdio: "inherit",
    timeout: generationTimeoutMs,
  });
  compareDirectory("types");
  compareDirectory("schema");
  process.stdout.write(`Codex ${version} generated contracts: PASS\n`);
} finally {
  rmSync(generatedRoot, { recursive: true, force: true });
}
