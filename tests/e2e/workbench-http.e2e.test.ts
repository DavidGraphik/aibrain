import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertUiContract } from "../helpers/ui-contract";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
type NextProcess = ChildProcessByStdio<null, Readable, Readable>;

const processes = new Set<NextProcess>();
let root = "";
let applicationRoot = "";
let configPath = "";
let port = 0;
let baseUrl = "";
let server: NextProcess | null = null;
let cookie = "";
let projectId = "";
let threadId = "";

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("E2E port allocation failed.");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

function cookieFrom(response: Response) {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("E2E login did not set a session cookie.");
  return header.split(";", 1)[0];
}

async function waitForHttp(child: NextProcess, timeoutMs = 45_000) {
  const startedAt = Date.now();
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-8_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Next E2E server exited early.\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health/live`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Compilation and listener startup are still in progress.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next E2E server did not become ready.\n${output}`);
}

async function startServer() {
  const child = spawn(process.execPath, [
    path.join(repositoryRoot, "node_modules/next/dist/bin/next"),
    "dev",
    "--webpack",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: applicationRoot,
    env: {
      ...process.env,
      AIBRAIN_AUTH_MODE: "demo",
      AIBRAIN_INSTALLATION_CONFIG: configPath,
      AIBRAIN_SESSION_SECRET: "e2e-session-secret-0123456789abcdef0123456789abcdef",
      CHAT_RUNTIME: "demo",
      AIBRAIN_DEMO_DATA_DIR: path.join(root, "demo-data"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.add(child);
  child.once("exit", () => processes.delete(child));
  await waitForHttp(child);
  return child;
}

async function stopServer(child: NextProcess | null) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await exited;
}

async function json(pathname: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "aibrain-http-e2e-"));
  applicationRoot = path.join(root, "application");
  await mkdir(applicationRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    "src",
    "contracts",
    "public",
    "config",
    "next.config.ts",
    "next-env.d.ts",
    "package.json",
    "postcss.config.mjs",
    "tsconfig.json",
    "tsconfig.build.json",
  ].map((entry) => cp(path.join(repositoryRoot, entry), path.join(applicationRoot, entry), { recursive: true })));
  await symlink(path.join(repositoryRoot, "node_modules"), path.join(applicationRoot, "node_modules"), "dir");
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = path.join(root, "data");
  const sourceRoot = path.join(root, "source-ro");
  const publishRoot = path.join(root, "publish-rw");
  await Promise.all([
    mkdir(path.join(dataRoot, "company"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(dataRoot, "users"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(dataRoot, "backups"), { recursive: true, mode: 0o700 }),
    mkdir(sourceRoot, { recursive: true, mode: 0o700 }),
    mkdir(publishRoot, { recursive: true, mode: 0o700 }),
  ]);
  configPath = path.join(root, "installation.json");
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    installationId: "http-e2e-lab",
    companyName: "HTTP E2E Laboratory",
    companySlug: "http-e2e-laboratory",
    publicUrl: baseUrl,
    branding: {
      productName: "HTTP E2E Brain",
      logoPath: "/branding/example-lab/logo.svg",
      faviconPath: "/branding/example-lab/favicon.svg",
      accentColor: "#0f766e",
    },
    paths: {
      dataRoot,
      companyContextRoot: path.join(dataRoot, "company"),
      usersRoot: path.join(dataRoot, "users"),
      sourceReadRoot: sourceRoot,
      publishWriteRoot: publishRoot,
      backupsRoot: path.join(dataRoot, "backups"),
    },
  }, null, 2)}\n`, { mode: 0o600 });
  server = await startServer();
});

afterAll(async () => {
  await Promise.all([...processes].map((child) => stopServer(child)));
  if (root) await rm(root, { recursive: true, force: true });
});

describe("real Next HTTP workbench lifecycle", () => {
  it("renders installation branding and rejects a cross-origin login", async () => {
    const page = await fetch(`${baseUrl}/login`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("HTTP E2E Brain");

    const rejected = await json("/api/auth/login", {
      method: "POST",
      headers: { Origin: "https://attacker.invalid" },
      body: JSON.stringify({ userId: "example-user" }),
    });
    expect(rejected.status).toBe(403);
  });

  it("logs in, persists a project and thread, and enforces strict lifecycle", async () => {
    const login = await json("/api/auth/login", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify({ userId: "example-user" }),
    });
    expect(login.status).toBe(200);
    cookie = cookieFrom(login);

    const createdProject = await json("/api/projects", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify({ name: "E2E Operations" }),
    });
    expect(createdProject.status).toBe(201);
    projectId = (await createdProject.json() as { project: { id: string } }).project.id;

    const createdThread = await json(`/api/projects/${projectId}/threads`, {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify({ title: "Restart-safe thread" }),
    });
    expect(createdThread.status).toBe(201);
    threadId = (await createdThread.json() as { thread: { id: string } }).thread.id;

    const archived = await json(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { Origin: baseUrl },
      body: JSON.stringify({ pinned: true, status: "archived" }),
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({
      thread: { id: threadId, projectId, pinned: true, status: "archived" },
    });
  });

  it("survives a real server restart and revokes the cookie on logout", async () => {
    await stopServer(server);
    server = await startServer();

    const snapshot = await json("/api/workbench");
    expect(snapshot.status).toBe(200);
    const body = await snapshot.json() as {
      workbench: { projects: Array<{ id: string }>; threads: Array<{ id: string; status: string }> };
    };
    assertUiContract("WorkbenchResponse", body);
    expect(body.workbench.projects).toContainEqual(expect.objectContaining({ id: projectId }));
    expect(body.workbench.threads).toContainEqual(expect.objectContaining({ id: threadId, status: "archived" }));

    const runtime = await json(`/api/runtime/status?projectId=${projectId}`);
    const runtimeText = await runtime.text();
    expect(runtime.status, runtimeText.slice(0, 2_000)).toBe(200);
    const runtimeBody = JSON.parse(runtimeText);
    assertUiContract("RuntimeStatus", runtimeBody);

    const logout = await json("/api/auth/logout", {
      method: "POST",
      headers: { Origin: baseUrl },
    });
    expect(logout.status).toBe(200);
    cookie = cookieFrom(logout);
    const session = await json("/api/auth/session");
    expect(session.status).toBe(401);
  });
});
