import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

describe("production Codex App Server acceptance gate", () => {
  it("keeps the verified execution-owner fd in bwrap for the sandbox lifetime", async () => {
    const worker=await readFile(path.join(repositoryRoot,"infra/hetzner/app/worker-sandbox.sh"),"utf8");
    const dockerfile=await readFile(path.join(repositoryRoot,"Dockerfile"),"utf8");
    expect(worker).toContain('fs.fstatSync(3)');expect(worker).toContain('worker_sync_options="--sync-fd 3"');
    expect(worker.slice(worker.indexOf("exec /usr/bin/bwrap"))).toContain('$worker_sync_options');
    expect(worker).toContain('unset AIBRAIN_WORKER_LOCK_FD');expect(dockerfile).toContain('test -x /usr/bin/flock');
  });

  it("reads installation paths before hiding operator configuration from the worker", async () => {
    const worker = await readFile(
      path.join(repositoryRoot, "infra/hetzner/app/worker-sandbox.sh"),
      "utf8",
    );
    const launcherIndex = worker.indexOf("exec /usr/bin/bwrap");
    const launcher = worker.slice(launcherIndex);

    expect(launcherIndex).toBeGreaterThan(worker.indexOf("publish_root=$(read_config_path publishWriteRoot)"));
    expect(launcher).toMatch(/--ro-bind \/ \/[\s\S]*--tmpfs \/etc\/aibrain[\s\S]*--remount-ro \/etc\/aibrain[\s\S]*\/usr\/local\/bin\/codex-real/u);
    expect(launcher).not.toMatch(/--(?:ro-)?bind[^\n]*\/etc\/aibrain/u);
    expect(launcher).not.toContain("read_config_path");
    expect(worker).toContain('"${1:-}" = app-server');
  });

  it("keeps gateway-owned transport audit logs behind the product data mask", async () => {
    const worker = await readFile(
      path.join(repositoryRoot, "infra/hetzner/app/worker-sandbox.sh"),
      "utf8",
    );
    const launcher = worker.slice(worker.indexOf("exec /usr/bin/bwrap"));

    expect(launcher).toContain('--tmpfs "$data_root"');
    expect(launcher).not.toMatch(/--(?:ro-)?bind[^\n]*\$transport_audit_root/u);
    expect(launcher).not.toMatch(/--(?:ro-)?bind[^\n]*\$user_root\/audit/u);
  });

  it("packages and runs the real restart probe before readiness can become green", async () => {
    const [dockerfile, entrypoint, workflow, readiness, appArmor] = await Promise.all([
      readFile(path.join(repositoryRoot, "Dockerfile"), "utf8"),
      readFile(path.join(repositoryRoot, "infra/hetzner/app/entrypoint.sh"), "utf8"),
      readFile(path.join(repositoryRoot, ".github/workflows/quality.yml"), "utf8"),
      readFile(path.join(repositoryRoot, "src/operations/runtime-readiness.ts"), "utf8"),
      readFile(path.join(repositoryRoot, "infra/hetzner/apparmor/aibrain-container"), "utf8"),
    ]);

    expect(dockerfile).toContain("npm run build:container-app-server-acceptance");
    expect(dockerfile).toContain("/usr/local/share/aibrain/container-app-server-acceptance.mjs");
    expect(entrypoint).toContain("node /usr/local/share/aibrain/container-app-server-acceptance.mjs");
    expect(entrypoint).toContain("export AIBRAIN_CODEX_APP_SERVER_ACCEPTED=1");
    expect(readiness).toContain('environment.AIBRAIN_CODEX_APP_SERVER_ACCEPTED !== "1"');
    expect(readiness).toContain('unavailable("CODEX_APP_SERVER_ACCEPTANCE_REQUIRED")');
    // Public source CI cannot fabricate a native runtime acceptance result.
    expect(workflow).toContain("Public source quality");
    expect(workflow).not.toContain("AIBRAIN_CODEX_APP_SERVER_ACCEPTED=1");
    expect(workflow).not.toMatch(/docker push|deploy-arnall|automatic-activation/u);
    expect(appArmor).toContain("userns,");
    expect(appArmor).toContain("mount,");
  });
});
