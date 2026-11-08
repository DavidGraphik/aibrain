import { execFile as execFileCallback } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const executable = path.join(repositoryRoot, "node_modules", ".bin", "tsx");
const script = path.join(repositoryRoot, "scripts", "run-operational-alerts.ts");
const roots: string[] = [];
let server: Server | null = null;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-alerts-cli-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const backupsRoot = path.join(dataRoot, "backups");
  const companyContextRoot = path.join(dataRoot, "company");
  const usersRoot = path.join(dataRoot, "users");
  const sourceReadRoot = path.join(root, "source-ro");
  const publishWriteRoot = path.join(root, "publish-rw");
  await Promise.all([
    mkdir(path.join(backupsRoot, "verification"), { recursive: true, mode: 0o700 }),
    mkdir(companyContextRoot, { recursive: true, mode: 0o700 }),
    mkdir(usersRoot, { recursive: true, mode: 0o700 }),
    mkdir(sourceReadRoot, { recursive: true, mode: 0o700 }),
    mkdir(publishWriteRoot, { recursive: true, mode: 0o700 }),
  ]);
  const now = new Date().toISOString();
  await writeFile(path.join(backupsRoot, "verification", "latest.json"), `${JSON.stringify({
    schemaVersion: 1,
    installationId: "alerts-cli-qa",
    backupId: "20260827T120000Z-11111111-1111-4111-8111-111111111111",
    sourceFingerprint: "a".repeat(64),
    backupCreatedAt: now,
    verifiedAt: now,
  })}\n`, { mode: 0o600 });
  const configPath = path.join(root, "installation.json");
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    installationId: "alerts-cli-qa",
    companyName: "Alerts CLI QA",
    companySlug: "alerts-cli-qa",
    publicUrl: "https://alerts-cli.example.test",
    branding: {
      productName: "Alerts CLI Brain",
      logoPath: "/branding/alerts-cli/logo.svg",
      faviconPath: "/branding/alerts-cli/favicon.svg",
      accentColor: "#123abc",
    },
    paths: { dataRoot, companyContextRoot, usersRoot, sourceReadRoot, publishWriteRoot, backupsRoot },
  })}\n`, { mode: 0o600 });
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ready":true}');
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate alert test port.");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    AIBRAIN_INSTALLATION_CONFIG: configPath,
    AIBRAIN_ALERT_READINESS_URL: `http://127.0.0.1:${address.port}/api/health/ready`,
  };
  return {
    root,
    dataRoot,
    environment,
  };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("operational alerts CLI", () => {
  it("collects, reconciles and durably delivers without duplicate transitions", async () => {
    const test = await fixture();
    const arguments_ = [
      script,
      "--restart-count-15m",
      "3",
      "--preflight-failure-count-15m",
      "1",
    ];
    const first = await execFile(executable, arguments_, { cwd: repositoryRoot, env: test.environment });
    const result = JSON.parse(first.stdout) as {
      status: string;
      codes: string[];
      queued: number;
      delivered: number;
      delivery: { pending: number; exhausted: number };
    };
    expect(result.status).toBe("critical");
    expect(result.queued).toBeGreaterThanOrEqual(2);
    expect(result.delivered).toBe(result.queued);
    expect(result.delivery).toMatchObject({ pending: 0, exhausted: 0 });
    expect(result.codes).toEqual(expect.arrayContaining(["RESTART_LOOP", "PREFLIGHT_FAILURE"]));

    const replay = await execFile(executable, arguments_, { cwd: repositoryRoot, env: test.environment });
    expect(JSON.parse(replay.stdout)).toMatchObject({ status: "critical", queued: 0, delivered: 0 });
    const sinkRoot = path.join(test.dataRoot, "operations", "alerts", "local-sink");
    const delivered = await Promise.all((await readdir(sinkRoot)).map((name) => readFile(path.join(sinkRoot, name), "utf8")));
    expect(delivered).toHaveLength(result.delivered);
    expect(delivered.join("\n")).not.toMatch(/email|token|secret|userId|path/iu);
  });

  it("rejects missing host counters instead of assuming zero", async () => {
    const test = await fixture();
    await expect(execFile(executable, [script], {
      cwd: repositoryRoot,
      env: test.environment,
    })).rejects.toMatchObject({ stderr: expect.stringContaining("--restart-count-15m") });
  });
});
