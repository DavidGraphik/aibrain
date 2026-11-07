import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const roots: string[] = [];
const command = path.resolve("deployments/g03/prepare-runtime.mjs");
const publishable = "sb_publishable_synthetic_public_fixture";
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "g03-private-runtime-")));
  roots.push(root);
  await writeFile(path.join(root, "auth.env"), [
    "AIBRAIN_AUTH_MODE=supabase",
    "NEXT_PUBLIC_SUPABASE_URL=https://project-ref.supabase.co",
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${publishable}`,
  ].join("\n") + "\n", { mode: 0o600 });
  await writeFile(path.join(root, "users.json"), JSON.stringify([{
    userId: "00000000-0000-4000-8000-000000000001",
    email: "operator@example.invalid", requireInitialPasswordChange: true,
  }]), { mode: 0o600 });
  return root;
}
const prepare = (root: string) => exec(process.execPath, [command, root, "151.0.7922.137"]);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("offline G03 runtime preparation", () => {
  it("generates private disjoint secrets without deploying, printing or silently rotating them", async () => {
    const root = await fixture();
    const result = await prepare(root);
    const prepared = path.join(root, "runtime-prepared");
    expect(JSON.parse(result.stdout)).toMatchObject({
      installationId: "g03-production", prepared: true, deployed: false, remoteChanges: false,
      secretsPrinted: false,
    });
    const runtime = await readFile(path.join(prepared, "runtime.env"), "utf8");
    const egress = await readFile(path.join(prepared, "egress.env"), "utf8");
    const secrets = [...runtime.matchAll(/^AIBRAIN_\w+_SECRET=(.+)$/gmu),
      ...egress.matchAll(/^AIBRAIN_EGRESS_\w+_TOKEN=(.+)$/gmu)].map((match) => match[1]);
    expect(secrets).toHaveLength(9);
    expect(new Set(secrets).size).toBe(9);
    for (const secret of secrets) {
      expect(secret).toMatch(/^[A-Za-z0-9_-]{64}$/u);
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
    for (const name of ["runtime.env", "egress.env", "users.json", "installation.json",
      "restic-password", ".aibrain-owner.json", "readiness.json"]) {
      expect((await stat(path.join(prepared, name))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(prepared)).mode & 0o777).toBe(0o700);
    expect(runtime).toContain("AIBRAIN_AUTOMATION_WORKER_ENABLED=false");
    expect(JSON.parse(await readFile(path.join(prepared, "readiness.json"), "utf8")))
      .toMatchObject({ deployed: false, disabled: ["Windows writes", "Sage", "automations"] });
    await expect(prepare(root)).rejects.toThrow();
    expect(await readFile(path.join(prepared, "runtime.env"), "utf8")).toBe(runtime);
  });

  it("rejects foreign Auth projects before generating any runtime", async () => {
    const root = await fixture();
    const input = path.join(root, "auth.env");
    await writeFile(input, (await readFile(input, "utf8"))
      .replace("project-ref", "foreignprojectfixture"));
    await expect(prepare(root)).rejects.toThrow(/Only G03 publishable/u);
    await expect(stat(path.join(root, "runtime-prepared"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("packages explicit G03 host-only recovery without changing existing secrets", async () => {
    const root = await fixture();
    await prepare(root);
    const revision = "b".repeat(40);
    const manifest = path.join(root, "release.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, revision,
      image: `ghcr.io/example-owner/graphikai-brain@sha256:${"c".repeat(64)}`,
      egressImage: `ghcr.io/example-owner/graphikai-brain-egress@sha256:${"d".repeat(64)}`,
    }), { mode: 0o600 });
    const command = path.resolve("deployments/g03/prepare-host-local-release.mjs");
    const result = await exec(process.execPath, [command, root, manifest], { env: { ...process.env, AIBRAIN_HOST_LOSS_ACCEPTANCE_ID: "synthetic-test-explicit-host-loss" } });
    expect(JSON.parse(result.stdout)).toMatchObject({ externalBackup: false, deployed: false, secretsPrinted: false });
    const output = path.join(root, `release-inputs-${revision}`);
    expect(await readFile(path.join(output, "runtime.env"), "utf8"))
      .toBe((await readFile(path.join(root, "runtime-prepared/runtime.env"), "utf8"))
        + "AIBRAIN_ADMIN_USER_IDS=00000000-0000-4000-8000-000000000001\nAIBRAIN_G03_PUBLICATION_ENABLED=true\n");
    expect(await readFile(path.join(output, "replica.env"), "utf8"))
      .toBe("AIBRAIN_G03_RECOVERY_DECISION=synthetic-test-explicit-host-loss\n");
    expect(await readFile(path.join(output, "compose.env"), "utf8"))
      .toContain("AIBRAIN_AUTOMATION_WORKER_ENABLED=false");
    await expect(exec(process.execPath, [command, root, manifest], { env: { ...process.env, AIBRAIN_HOST_LOSS_ACCEPTANCE_ID: "synthetic-test-explicit-host-loss" } })).rejects.toThrow();
  });

  it("rejects secret keys and symlinked input files", async () => {
    const root = await fixture();
    const input = path.join(root, "auth.env");
    await writeFile(input, (await readFile(input, "utf8")).replace(publishable, "sb_secret_synthetic"));
    await expect(prepare(root)).rejects.toThrow(/Only G03 publishable/u);
    await rm(input);
    await symlink(path.join(root, "users.json"), input);
    await expect(prepare(root)).rejects.toThrow();
    await expect(stat(path.join(root, "runtime-prepared"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
