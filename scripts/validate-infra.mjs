import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Public source validation: no network, image pulls, host changes or enrollment.
// Runtime container acceptance on Linux remains a separate required gate.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
const docker = read("Dockerfile");
const compose = read("infra/hetzner/compose.yaml");
const required = (text, values, label) => {
  for (const value of values) assert.ok(text.includes(value), `${label}: missing ${value}`);
};
required(docker, ["node:24.18.1-bookworm-slim@sha256:", "FROM ${NODE_IMAGE} AS native-runtime", "chromium-sandbox", "bubblewrap", "libreoffice-writer", "libreoffice-calc", "libreoffice-impress", "poppler-utils", "qpdf", "restic", "python3-openpyxl", "python3-pil", "--require-hashes", "@openai/codex@0.162.1", "USER aibrain:aibrain", 'VOLUME ["/var/lib/aibrain/data", "/var/lib/aibrain-restores"]'], "native runtime");
assert.ok(!/FROM\s+ghcr\.io\//u.test(docker), "Runtime build must not depend on an unpublished registry base");
for (const line of docker.replace(/\\\n\s*/gu, " ").split("\n")) {
  if (!line.startsWith("COPY ") || line.includes("--from=")) continue;
  const fields = line.split(/\s+/u).slice(1).filter(value => !value.startsWith("--"));
  for (const file of fields.slice(0, -1)) assert.ok(existsSync(path.join(root, file)), `Missing Docker source: ${file}`);
}
required(compose, ["read_only: true", "no-new-privileges:true", "apparmor=aibrain-container", "seccomp=./browser/seccomp_profile.json", "cap_drop:", "internal: true", "egress-gateway", "AIBRAIN_EGRESS_ENV_FILE", "AIBRAIN_INSTALLATION_CONFIG"], "container policy");
assert.ok(!/privileged:\s*true|network_mode:\s*host/u.test(compose), "Container isolation must remain enforced");
const seccomp = JSON.parse(read("infra/hetzner/browser/seccomp_profile.json"));
assert.equal(seccomp.defaultAction, "SCMP_ACT_ERRNO");
const apparmor = read("infra/hetzner/apparmor/aibrain-container");
required(apparmor, ["profile aibrain-container", "userns", "mount", "pivot_root"], "AppArmor");
for (const name of ["worker-sandbox.sh", "browser-sandbox.sh", "soffice-safe.sh", "xls-passive-safe.sh", "g03-paged-spreadsheet-safe.sh", "entrypoint.sh"]) {
  const file = `infra/hetzner/app/${name}`;
  execFileSync("sh", ["-n", path.join(root, file)], { stdio: "pipe" });
  const wrapper = read(file);
  if (name !== "entrypoint.sh") required(wrapper, ["bwrap", "--remount-ro"], name);
}
required(read("infra/hetzner/app/browser-sandbox.sh"), ["--unshare-pid", "--unshare-ipc", "--unshare-uts", "--tmpfs \"$data_root\"", "--bind \"$browser_root\""], "browser filesystem isolation");
required(read("infra/hetzner/app/worker-sandbox.sh"), ["--unshare-pid", "--unshare-ipc", "--unshare-uts", "workers must not run as root"], "worker");
required(read("infra/hetzner/app/soffice-safe.sh"), ["--unshare-net", "--cap-drop ALL", "--clearenv"], "documents");
for (const name of ["xls-passive-safe.sh", "g03-paged-spreadsheet-safe.sh"]) required(read(`infra/hetzner/app/${name}`), ["--unshare-all", "--cap-drop ALL", "--clearenv"], name);
required(read("infra/hetzner/app/entrypoint.sh"), ["AIBRAIN_CHROME_EXPECTED_VERSION", "AIBRAIN_CODEX_EXPECTED_VERSION", "--unshare-pid", "fail"], "runtime readiness");
for (const value of Object.values(JSON.parse(read("package.json")).scripts)) {
  for (const match of value.matchAll(/scripts\/[A-Za-z0-9_./-]+\.(?:mjs|ts|py)/gu)) assert.ok(existsSync(path.join(root, match[0])), `Missing package script: ${match[0]}`);
}
console.log("Public infrastructure source and isolation checks PASS; Linux container/runtime acceptance not executed.");
