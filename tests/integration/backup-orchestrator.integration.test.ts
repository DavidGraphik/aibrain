import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/orchestrate-backup.mjs");
const backupId = "20260827T090000Z-11111111-2222-4333-8444-555555555555";
const fingerprint = "a".repeat(64);
const secret = "maintenance-secret-with-more-than-32-bytes";
const roots: string[] = [];
const servers: Server[] = [];

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "aibrain-backup-orchestrator-")));
  roots.push(root);
  const envFile = path.join(root, "compose.env");
  const composeFile = path.join(root, "compose.yaml");
  const runtimeEnv = path.join(root, "runtime.env");
  const stateFile = path.join(root, "backup-operation.json");
  const dockerBin = path.join(root, "docker-fake.mjs");
  const dockerLog = path.join(root, "docker.log");
  const runtimeState = path.join(root, "runtime-state.json");
  await writeFile(envFile, "AIBRAIN_INSTALLATION_ID=company-qa\nAIBRAIN_COMPOSE_PROJECT_NAME=aibrain-company-qa\n");
  await writeFile(composeFile, "services:\n  app: {}\n  alert-dispatcher: {}\n");
  await writeFile(runtimeEnv, `AIBRAIN_MAINTENANCE_SECRET=${secret}\n`, { mode: 0o600 });
  await writeFile(runtimeState, JSON.stringify({ running: true }));
  await writeFile(dockerBin, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const serialized = JSON.stringify(args);
const state = JSON.parse(readFileSync(process.env.FAKE_RUNTIME_STATE, "utf8"));
if (args[0] === "compose" && args.includes("stop")) {
  state.running = false;
  writeFileSync(process.env.FAKE_RUNTIME_STATE, JSON.stringify(state));
} else if (args[0] === "compose" && args.includes("run") && args.includes("create")) {
  if (process.env.FAKE_FAIL_CREATE === "1") process.exit(2);
  if (process.env.FAKE_BAD_PREFLIGHT === "1") process.stdout.write(JSON.stringify({ privateFilesystemAcceptance: true, syntheticFixturesOnly: false }) + "\\n");
  if (process.env.FAKE_FILESYSTEM_PREFLIGHT === "1") process.stdout.write(JSON.stringify({ privateFilesystemAcceptance: true, syntheticFixturesOnly: true, privateReadsDenied: true, symlinkAliasDenied: true, helperReadsAllowed: true, exactWorkspaceWriteAllowed: true }) + "\\n");
  if (process.env.FAKE_PREFLIGHT === "1") process.stdout.write("Codex App Server container acceptance passed.\\n");
  process.stdout.write(JSON.stringify({ operation: "create", backupId: process.env.FAKE_BACKUP_ID, sourceFingerprint: process.env.FAKE_FINGERPRINT }));
} else if (args[0] === "compose" && args.includes("run") && args.includes("verify")) {
  if (process.env.FAKE_KILL_ON_VERIFY === "1") process.kill(process.ppid, "SIGKILL");
  if (process.env.FAKE_FILESYSTEM_PREFLIGHT === "1") process.stdout.write(JSON.stringify({ privateFilesystemAcceptance: true, syntheticFixturesOnly: true, privateReadsDenied: true, symlinkAliasDenied: true, helperReadsAllowed: true, exactWorkspaceWriteAllowed: true }) + "\\n");
  if (process.env.FAKE_PREFLIGHT === "1") process.stdout.write("Codex App Server container acceptance passed.\\n");
  process.stdout.write(JSON.stringify({ operation: "verify", backupId: process.env.FAKE_BACKUP_ID, sourceFingerprint: process.env.FAKE_FINGERPRINT, verified: true }));
} else if (args[0] === "compose" && args.includes("up")) {
  state.running = true;
  writeFileSync(process.env.FAKE_RUNTIME_STATE, JSON.stringify(state));
} else if (args[0] === "compose" && args.includes("ps")) {
  process.stdout.write("a".repeat(64));
} else if (args[0] === "inspect" && serialized.includes("Health.Status")) {
  process.stdout.write(state.running ? "healthy" : "unhealthy");
} else {
  process.exit(3);
}
`);
  await chmod(dockerBin, 0o755);

  const actions: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      expect(request.headers.authorization).toBe(`Bearer ${secret}`);
      expect(request.headers.origin).toBe("https://brain.example.test");
      const action = JSON.parse(body).action as string;
      actions.push(action);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ phase: action === "drain" ? "maintenance" : "accepting", activeActivities: 0 }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const args = [
    script,
    "backup",
    "--installation-id", "company-qa",
    "--env-file", envFile,
    "--compose-file", composeFile,
    "--runtime-env", runtimeEnv,
    "--state-file", stateFile,
    "--maintenance-url", `http://127.0.0.1:${address.port}/api/operations/maintenance`,
    "--origin", "https://brain.example.test",
    "--docker-bin", dockerBin,
    "--drain-timeout-ms", "5000",
    "--docker-timeout-ms", "5000",
    "--health-timeout-ms", "5000",
  ];
  const env = {
    ...process.env,
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_RUNTIME_STATE: runtimeState,
    FAKE_BACKUP_ID: backupId,
    FAKE_FINGERPRINT: fingerprint,
  };
  return { root, args, env, actions, stateFile, dockerLog, runtimeState, runtimeEnv };
}

async function receipts(root: string) {
  return (await readdir(root)).filter((name) => name.includes("backup-operation.json.receipt-"));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable host backup orchestrator", () => {
  it("rejects incomplete or failed filesystem success reports and restores admission", async () => {
    const input = await fixture();
    await expect(execFileAsync(process.execPath, input.args, { env: { ...input.env,
      FAKE_PREFLIGHT: "1", FAKE_BAD_PREFLIGHT: "1" } }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("BACKUP_OPERATION_RECOVERED") });
    expect(input.actions).toEqual(["drain", "resume"]);
    expect(JSON.parse(await readFile(input.runtimeState, "utf8"))).toEqual({ running: true });
  });
  it("accepts both exact production isolation success reports without skipping checks", async () => {
    const input = await fixture();
    const result = await execFileAsync(process.execPath, input.args, { env: { ...input.env,
      FAKE_PREFLIGHT: "1", FAKE_FILESYSTEM_PREFLIGHT: "1" } });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "verified", backupId, sourceFingerprint: fingerprint });
    expect(input.actions).toEqual(["drain", "resume"]);
  });
  it("accepts the real entrypoint success banner before the strict backup result", async () => {
    const input = await fixture();
    const result = await execFileAsync(process.execPath, input.args, { env: { ...input.env, FAKE_PREFLIGHT: "1" } });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "verified", backupId, sourceFingerprint: fingerprint });
    expect(input.actions).toEqual(["drain", "resume"]);
  });

  it("drains, stops, creates, verifies and recovers service before committing a receipt", async () => {
    const input = await fixture();
    const result = await execFileAsync(process.execPath, input.args, { env: input.env });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "verified", backupId, sourceFingerprint: fingerprint });
    expect(input.actions).toEqual(["drain", "resume"]);
    expect(JSON.parse(await readFile(input.runtimeState, "utf8"))).toEqual({ running: true });
    await expect(stat(input.stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await receipts(input.root)).toHaveLength(1);
    const commands = (await readFile(input.dockerLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.findIndex((args) => args.includes("stop"))).toBeLessThan(commands.findIndex((args) => args.includes("create")));
    expect(commands.findIndex((args) => args.includes("create"))).toBeLessThan(commands.findIndex((args) => args.includes("verify")));
  });

  it("accepts a normal-sized Docker executable while retaining private configuration checks", async () => {
    const input = await fixture();
    const executable = input.args[input.args.indexOf("--docker-bin") + 1];
    await writeFile(executable, (await readFile(executable, "utf8")) + "\n/*" + "x".repeat(2 * 1024 * 1024) + "*/\n");
    const result = await execFileAsync(process.execPath, input.args, { env: input.env });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "verified", backupId });
    expect(input.actions).toEqual(["drain", "resume"]);
  });

  it("restores app and admission after a backup command failure without claiming success", async () => {
    const input = await fixture();
    await expect(execFileAsync(process.execPath, input.args, {
      env: { ...input.env, FAKE_FAIL_CREATE: "1" },
    })).rejects.toMatchObject({ stderr: expect.stringContaining("BACKUP_OPERATION_RECOVERED") });
    expect(input.actions).toEqual(["drain", "resume"]);
    expect(JSON.parse(await readFile(input.runtimeState, "utf8"))).toEqual({ running: true });
    await expect(stat(input.stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    const receiptName = (await receipts(input.root))[0]!;
    expect(JSON.parse(await readFile(path.join(input.root, receiptName), "utf8"))).toMatchObject({ status: "aborted", backupId: null });
  });

  it("recovers a verified snapshot and service after SIGKILL during verification", async () => {
    const input = await fixture();
    await expect(execFileAsync(process.execPath, input.args, {
      env: { ...input.env, FAKE_KILL_ON_VERIFY: "1" },
    })).rejects.toMatchObject({ code: expect.any(Number) });
    expect(JSON.parse(await readFile(input.stateFile, "utf8"))).toMatchObject({ phase: "snapshot-created", backupId });
    expect(JSON.parse(await readFile(input.runtimeState, "utf8"))).toEqual({ running: false });

    const recoverArgs = [...input.args];
    recoverArgs[1] = "recover";
    const recovered = await execFileAsync(process.execPath, recoverArgs, { env: input.env });
    expect(JSON.parse(recovered.stdout)).toMatchObject({ status: "verified", backupId });
    expect(input.actions).toEqual(["drain", "resume"]);
    expect(JSON.parse(await readFile(input.runtimeState, "utf8"))).toEqual({ running: true });
    await expect(stat(input.stateFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a public runtime secret file before maintenance or Docker", async () => {
    const input = await fixture();
    await chmod(input.runtimeEnv, 0o644);
    await expect(execFileAsync(process.execPath, input.args, { env: input.env }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("BACKUP_OPERATION_PATH_INVALID") });
    expect(input.actions).toEqual([]);
    await expect(readFile(input.dockerLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
