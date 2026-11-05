import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/validate-host-preflight.mjs");

async function fixture(installationId = "company-alpha") {
  const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-host-preflight-"));
  const configRoot = path.join(root, "config", installationId);
  const hostRoot = path.join(root, `aibrain-${installationId}`);
  const sourceRoot = path.join(hostRoot, "source-ro");
  const publishRoot = path.join(hostRoot, "publish-rw");
  const replicaStateRoot = path.join(hostRoot, "replication");
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(sourceRoot, { recursive: true }),
    mkdir(publishRoot, { recursive: true }),
    mkdir(replicaStateRoot, { recursive: true }),
  ]);
  await Promise.all([
    chmod(sourceRoot, 0o550),
    chmod(publishRoot, 0o750),
    chmod(replicaStateRoot, 0o700),
  ]);
  const marker = JSON.stringify({ schemaVersion: 1, product: "aibrain", installationId });
  await Promise.all([
    writeFile(path.join(configRoot, ".aibrain-owner.json"), marker),
    writeFile(path.join(hostRoot, ".aibrain-owner.json"), marker),
    writeFile(path.join(configRoot, "installation.json"), "{}"),
    writeFile(path.join(configRoot, "runtime.env"), "NEXT_PUBLIC_SUPABASE_URL=https://project-ref.supabase.co\n", { mode: 0o600 }),
    writeFile(path.join(configRoot, "egress.env"), [
      `AIBRAIN_EGRESS_BROWSER_TOKEN=${"a".repeat(96)}`,
      `AIBRAIN_EGRESS_WORKER_TOKEN=${"b".repeat(96)}`,
      `AIBRAIN_EGRESS_SERVER_TOKEN=${"c".repeat(96)}`,
      `AIBRAIN_EGRESS_HEALTH_TOKEN=${"e".repeat(96)}`,
      "AIBRAIN_EGRESS_WORKER_HOSTS=api.openai.com,auth.openai.com,chatgpt.com",
      "AIBRAIN_EGRESS_SUPABASE_ORIGIN=https://project-ref.supabase.co",
      "",
    ].join("\n"), { mode: 0o600 }),
    writeFile(path.join(configRoot, "alerts.env"), [
      "AIBRAIN_ALERT_SINK=webhook",
      "AIBRAIN_ALERT_WEBHOOK_URL=https://alerts.example.test/aibrain",
      `AIBRAIN_ALERT_WEBHOOK_TOKEN=${"d".repeat(96)}`,
      `AIBRAIN_ALERT_EGRESS_HEALTH_TOKEN=${"e".repeat(96)}`,
      "",
    ].join("\n"), { mode: 0o600 }),
    writeFile(path.join(configRoot, "replica.env"), [
      "AIBRAIN_RESTIC_REPOSITORY=s3:https://backup.example.test/company-alpha",
      "AWS_ACCESS_KEY_ID=synthetic",
      "AWS_SECRET_ACCESS_KEY=synthetic",
      "",
    ].join("\n"), { mode: 0o600 }),
    writeFile(path.join(configRoot, "restic-password"), "synthetic-password\n", { mode: 0o400 }),
  ]);
  const envFile = path.join(root, "compose.env");
  const values = {
    AIBRAIN_INSTALLATION_ID: installationId,
    AIBRAIN_COMPOSE_PROJECT_NAME: `aibrain-${installationId}`,
    AIBRAIN_NETWORK_NAME: `aibrain-${installationId}-private`,
    AIBRAIN_EGRESS_NETWORK_NAME: `aibrain-${installationId}-egress`,
    AIBRAIN_INGRESS_NETWORK_NAME: `aibrain-${installationId}-ingress`,
    AIBRAIN_IMAGE: `registry.example.test/aibrain@sha256:${"a".repeat(64)}`,
    AIBRAIN_EGRESS_IMAGE: `registry.example.test/aibrain-egress@sha256:${"b".repeat(64)}`,
    AIBRAIN_DATA_VOLUME_NAME: `aibrain-${installationId}-data`,
    AIBRAIN_BACKUP_VOLUME_NAME: `aibrain-${installationId}-backups`,
    AIBRAIN_RESTORE_VOLUME_NAME: `aibrain-${installationId}-restores`,
    AIBRAIN_INSTALLATION_CONFIG_HOST: path.join(configRoot, "installation.json"),
    AIBRAIN_RUNTIME_ENV_FILE: path.join(configRoot, "runtime.env"),
    AIBRAIN_EGRESS_ENV_FILE: path.join(configRoot, "egress.env"),
    AIBRAIN_ALERTS_ENV_FILE: path.join(configRoot, "alerts.env"),
    AIBRAIN_REPLICA_ENV_FILE: path.join(configRoot, "replica.env"),
    AIBRAIN_RESTIC_PASSWORD_FILE_HOST: path.join(configRoot, "restic-password"),
    AIBRAIN_HOST_ROOT: hostRoot,
    AIBRAIN_SOURCE_HOST_PATH: sourceRoot,
    AIBRAIN_PUBLISH_HOST_PATH: publishRoot,
    AIBRAIN_REPLICA_STATE_HOST_PATH: replicaStateRoot,
    AIBRAIN_HTTP_PORT: "43100",
    AIBRAIN_UID: String(typeof process.getuid === "function" ? process.getuid() : 10001),
    AIBRAIN_GID: String(typeof process.getgid === "function" ? process.getgid() : 10001),
  };
  await writeFile(envFile, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  return { root, envFile, values, configRoot, hostRoot, sourceRoot };
}

async function run(envFile: string, installationId = "company-alpha") {
  return execFileAsync(process.execPath, [script, "--env-file", envFile, "--installation", installationId], {
    env: { ...process.env, AIBRAIN_PREFLIGHT_ALLOW_OFFLINE: "1", AIBRAIN_HOST_LOSS_ACCEPTANCE_ID: "synthetic-test-explicit-host-loss", AIBRAIN_EXPECTED_PUBLIC_ORIGIN: "https://g03.example-platform.invalid" },
  });
}

describe("Hetzner host preflight", () => {
  async function hostLocalFixture(installationId = "g03-production") {
    const input = await fixture(installationId);
    const decision = "AIBRAIN_G03_RECOVERY_DECISION=synthetic-test-explicit-host-loss\n";
    await writeFile(input.envFile, await readFile(input.envFile, "utf8") + decision);
    await writeFile(path.join(input.configRoot, "installation.json"), JSON.stringify({
      installationId, publicUrl: "https://g03.example-platform.invalid",
    }));
    await writeFile(path.join(input.configRoot, "alerts.env"),
      decision + "AIBRAIN_ALERT_SINK=file\nAIBRAIN_ALERT_EGRESS_HEALTH_TOKEN=" + "e".repeat(96) + "\n");
    await writeFile(path.join(input.configRoot, "replica.env"), decision);
    return input;
  }

  it("accepts the explicit G03 host-loss decision without inventing off-host evidence", async () => {
    const input = await hostLocalFixture();
    const result = await run(input.envFile, "g03-production");
    expect(result.stdout).toContain("PASS (g03-production)");
    expect(result.stderr).toContain("host loss is NOT covered");
  });

  it("never applies G03's recovery decision to another installation or an unacknowledged G03", async () => {
    const other = await hostLocalFixture("company-alpha");
    await expect(run(other.envFile)).rejects.toThrow();
    const unacknowledged = await hostLocalFixture();
    await writeFile(unacknowledged.envFile, (await readFile(unacknowledged.envFile, "utf8"))
      .replace("AIBRAIN_G03_RECOVERY_DECISION=synthetic-test-explicit-host-loss\n", ""));
    await expect(run(unacknowledged.envFile, "g03-production")).rejects.toThrow();
  });

  it("requires a new operator acceptance and an exact reviewed origin for host-only recovery", async () => {
    const input = await hostLocalFixture();
    const invoke = (approval: string, origin: string) => execFileAsync(process.execPath, [script, "--env-file", input.envFile, "--installation", "g03-production"], {
      env: { ...process.env, AIBRAIN_PREFLIGHT_ALLOW_OFFLINE: "1", AIBRAIN_HOST_LOSS_ACCEPTANCE_ID: approval, AIBRAIN_EXPECTED_PUBLIC_ORIGIN: origin },
    });
    await expect(invoke("", "https://g03.example-platform.invalid")).rejects.toThrow();
    await expect(invoke("synthetic-test-explicit-host-loss", "https://foreign.example.invalid")).rejects.toThrow();
    await expect(invoke("synthetic-test-explicit-host-loss", "http://g03.example-platform.invalid")).rejects.toThrow();
  });

  it("rejects mismatched G03 recovery policies and pretend replica destinations", async () => {
    const mismatch = await hostLocalFixture();
    await writeFile(path.join(mismatch.configRoot, "alerts.env"), "AIBRAIN_ALERT_SINK=file\n");
    await expect(run(mismatch.envFile, "g03-production")).rejects.toThrow();
    const pretend = await hostLocalFixture();
    await writeFile(path.join(pretend.configRoot, "replica.env"), "AIBRAIN_RESTIC_REPOSITORY=/same-host\n");
    await expect(run(pretend.envFile, "g03-production")).rejects.toThrow();
  });

  it("accepts an enabled company mailbox with its exact allowlist and encryption key without exposing the key", async () => {
    const input = await fixture();
    const key = Buffer.alloc(32, 7).toString("base64");
    await writeFile(path.join(input.configRoot, "installation.json"), JSON.stringify({ connectors: { companyMail: { enabled: true, host: "mail.example.test", emailDomain: "example.test" } } }));
    const egressPath = path.join(input.configRoot, "egress.env");
    await writeFile(egressPath, `${await readFile(egressPath, "utf8")}AIBRAIN_EGRESS_MAIL_HOSTS=mail.example.test\n`);
    const runtimePath = path.join(input.configRoot, "runtime.env");
    await writeFile(runtimePath, `${await readFile(runtimePath, "utf8")}AIBRAIN_COMPANY_MAIL_ENCRYPTION_KEY=${key}\n`);
    const result = await run(input.envFile);
    expect(result.stdout).toContain("AiBrain host preflight: PASS");
    expect(`${result.stdout}${result.stderr}`).not.toContain(key);
  });

  it.each([
    { host: "mail.example.test", allowlist: "", key: Buffer.alloc(32).toString("base64"), error: "absent from the IMAPS allowlist" },
    { host: "mail.example.test", allowlist: "other.example.test", key: Buffer.alloc(32).toString("base64"), error: "absent from the IMAPS allowlist" },
    { host: "mail.example.test", allowlist: "mail.example.test", key: "", error: "32-byte base64 encryption key" },
    { host: "mail.example.test", allowlist: "mail.example.test", key: Buffer.alloc(16).toString("base64"), error: "32-byte base64 encryption key" },
    { host: "mail.example.test", allowlist: "mail.example.test", key: `${Buffer.alloc(32).toString("base64")}===`, error: "32-byte base64 encryption key" },
    { host: "mail.internal", allowlist: "mail.internal", key: Buffer.alloc(32).toString("base64"), error: "exact normalized public DNS hostnames" },
  ])("rejects invalid company mailbox host or key policy: $error", async ({ host, allowlist, key, error }) => {
    const input = await fixture();
    await writeFile(path.join(input.configRoot, "installation.json"), JSON.stringify({ connectors: { companyMail: { enabled: true, host, emailDomain: "example.test" } } }));
    const egressPath = path.join(input.configRoot, "egress.env");
    await writeFile(egressPath, `${await readFile(egressPath, "utf8")}AIBRAIN_EGRESS_MAIL_HOSTS=${allowlist}\n`);
    const runtimePath = path.join(input.configRoot, "runtime.env");
    await writeFile(runtimePath, `${await readFile(runtimePath, "utf8")}AIBRAIN_COMPANY_MAIL_ENCRYPTION_KEY=${key}\n`);
    await expect(run(input.envFile)).rejects.toMatchObject({ stderr: expect.stringContaining(error) });
  });

  it("accepts an exclusively owned installation layout without reading secrets", async () => {
    const input = await fixture();
    const result = await run(input.envFile);
    expect(result.stdout).toContain("AiBrain host preflight: PASS (company-alpha)");
  });

  it("rejects mismatched ownership, overlapping paths, symlinks and BGreenly paths", async () => {
    const ownership = await fixture();
    await writeFile(path.join(ownership.hostRoot, ".aibrain-owner.json"), JSON.stringify({ schemaVersion: 1, product: "aibrain", installationId: "someone-else" }));
    await expect(run(ownership.envFile)).rejects.toThrow();

    const symlinked = await fixture();
    const link = path.join(symlinked.root, "source-link");
    await symlink(symlinked.sourceRoot, link);
    const envWithLink = (await import("node:fs/promises")).readFile(symlinked.envFile, "utf8").then((text) => text.replace(`AIBRAIN_SOURCE_HOST_PATH=${symlinked.sourceRoot}`, `AIBRAIN_SOURCE_HOST_PATH=${link}`));
    await writeFile(symlinked.envFile, await envWithLink);
    await expect(run(symlinked.envFile)).rejects.toThrow();

    const bgreenly = await fixture("bgreenly");
    await expect(run(bgreenly.envFile, "bgreenly")).rejects.toThrow();
  });

  it("rejects exposed secrets and hard-linked policy files", async () => {
    const exposed = await fixture();
    await chmod(path.join(exposed.configRoot, "runtime.env"), 0o644);
    await expect(run(exposed.envFile)).rejects.toThrow();

    const hardLinked = await fixture();
    await link(path.join(hardLinked.configRoot, "egress.env"), path.join(hardLinked.configRoot, "egress-copy.env"));
    await expect(run(hardLinked.envFile)).rejects.toThrow();

    const misplacedSecret = await fixture();
    await writeFile(misplacedSecret.envFile, `${await readFile(misplacedSecret.envFile, "utf8")}AIBRAIN_SESSION_SECRET=must-not-live-here\n`);
    await expect(run(misplacedSecret.envFile)).rejects.toThrow();
  });

  it("rejects worker egress missing a required OpenAI runtime or refresh host", async () => {
    const missingAuth = await fixture();
    const missingAuthPath = path.join(missingAuth.configRoot, "egress.env");
    await writeFile(
      missingAuthPath,
      (await readFile(missingAuthPath, "utf8")).replace(
        "api.openai.com,auth.openai.com,chatgpt.com",
        "api.openai.com,chatgpt.com",
      ),
      { mode: 0o600 },
    );
    await expect(run(missingAuth.envFile)).rejects.toMatchObject({
      stderr: expect.stringContaining("missing required OpenAI hosts: auth.openai.com"),
    });

    const missingApi = await fixture();
    const missingApiPath = path.join(missingApi.configRoot, "egress.env");
    await writeFile(
      missingApiPath,
      (await readFile(missingApiPath, "utf8")).replace(
        "api.openai.com,auth.openai.com,chatgpt.com",
        "auth.openai.com,chatgpt.com",
      ),
      { mode: 0o600 },
    );
    await expect(run(missingApi.envFile)).rejects.toMatchObject({
      stderr: expect.stringContaining("missing required OpenAI hosts: api.openai.com"),
    });
  });
});
