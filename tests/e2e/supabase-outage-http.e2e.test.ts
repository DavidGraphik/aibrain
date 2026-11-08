import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import { UserProvisioner } from "@/users/provisioner";
import { assertUiContract } from "../helpers/ui-contract";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const USER_ID = "0198b9f0-6631-7000-8000-000000000010";
const EMAIL = "offline.employee@example.test";
const USER_MESSAGE_ID = "0198b9f0-6631-7000-8000-000000000011";
const ASSISTANT_MESSAGE_ID = "0198b9f0-6631-7000-8000-000000000012";
const WORKER_REPLY = "Resposta real del worker privat";
type NextProcess = ChildProcessByStdio<null, Readable, Readable>;

let root = "";
let applicationRoot = "";
let configPath = "";
let appPort = 0;
let baseUrl = "";
let provider: Server | null = null;
let providerUrl = "";
let next: NextProcess | null = null;
let cookie = "";
let fakeAppServer = "";
let fakeAppServerLog = "";
const providerRequests: string[] = [];

async function availablePort() {
  const listener = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Port allocation failed.");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

function sessionCookie(response: Response) {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("Local session cookie was not issued.");
  return header.split(";", 1)[0];
}

async function startProvider() {
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    providerRequests.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method !== "POST" || url.pathname !== "/auth/v1/token" || url.searchParams.get("grant_type") !== "password") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { email?: string; password?: string };
    if (body.email !== EMAIL || body.password !== "Temporary-pass-123") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_grant", error_description: "invalid credentials" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({
      access_token: "synthetic-access-token",
      token_type: "bearer",
      expires_in: 3_600,
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      refresh_token: "synthetic-refresh-token",
      user: {
        id: USER_ID,
        email: EMAIL,
        aud: "authenticated",
        role: "authenticated",
        created_at: "2026-08-27T00:00:00.000Z",
      },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake identity provider did not bind.");
  providerUrl = `http://127.0.0.1:${address.port}`;
  provider = server;
}

async function stopProvider() {
  const current = provider;
  provider = null;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

async function waitForNext(child: NextProcess, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-8_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next server exited early.\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health/live`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The development server is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next server did not become ready.\n${output}`);
}

async function startNext() {
  const child = spawn(process.execPath, [
    path.join(repositoryRoot, "node_modules/next/dist/bin/next"),
    "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(appPort),
  ], {
    cwd: applicationRoot,
    env: {
      ...process.env,
      AIBRAIN_AUTH_MODE: "supabase",
      // Positive HTTP flows use a QA floor; production headroom has separate negative tests.
      AIBRAIN_MINIMUM_FREE_RATIO: "0",
      AIBRAIN_ADMIN_USER_IDS: USER_ID,
      AIBRAIN_INSTALLATION_CONFIG: configPath,
      AIBRAIN_SESSION_SECRET: "offline-e2e-secret-0123456789abcdef0123456789abcdef",
      NEXT_PUBLIC_SUPABASE_URL: providerUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key",
      CHAT_RUNTIME: "codex",
      CODEX_BIN: fakeAppServer,
      CODEX_APPROVAL_POLICY: "never",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForNext(child);
  return child;
}

async function appServerRequests() {
  const contents = await readFile(fakeAppServerLog, "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
  });
}

async function stopNext(child: NextProcess | null) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await exited;
}

function http(pathname: string, init: RequestInit = {}) {
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
  root = await mkdtemp(path.join(tmpdir(), "aibrain-supabase-offline-e2e-"));
  applicationRoot = path.join(root, "application");
  await mkdir(applicationRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    "src", "contracts", "public", "config", "infra/shared", "skills", "next.config.ts", "next-env.d.ts", "package.json",
    "postcss.config.mjs", "tsconfig.json", "tsconfig.build.json",
  ].map((entry) => cp(path.join(repositoryRoot, entry), path.join(applicationRoot, entry), { recursive: true })));
  await symlink(path.join(repositoryRoot, "node_modules"), path.join(applicationRoot, "node_modules"), "dir");
  await startProvider();
  appPort = await availablePort();
  baseUrl = `http://127.0.0.1:${appPort}`;
  const dataRoot = path.join(root, "data");
  const usersRoot = path.join(dataRoot, "users");
  const sourceRoot = path.join(root, "source-ro");
  const publishRoot = path.join(root, "publish-rw");
  await Promise.all([
    mkdir(dataRoot, { recursive: true, mode: 0o700 }),
    mkdir(sourceRoot, { recursive: true, mode: 0o700 }),
    mkdir(publishRoot, { recursive: true, mode: 0o700 }),
  ]);
  configPath = path.join(root, "installation.json");
  const installation = parseInstallationConfig({
    schemaVersion: 1,
    installationId: "supabase-offline-e2e",
    companyName: "Offline Identity Laboratory",
    companySlug: "offline-identity-laboratory",
    publicUrl: baseUrl,
    branding: {
      productName: "Offline Identity Brain",
      logoPath: "/branding/example-lab/logo.svg",
      faviconPath: "/branding/example-lab/favicon.svg",
      accentColor: "#0f766e",
    },
    paths: {
      dataRoot,
      companyContextRoot: path.join(dataRoot, "company"),
      usersRoot,
      sourceReadRoot: sourceRoot,
      publishWriteRoot: publishRoot,
      backupsRoot: path.join(dataRoot, "backups"),
    },
  });
  await writeFile(configPath, `${JSON.stringify(installation, null, 2)}\n`, { mode: 0o600 });
  await new UserProvisioner(installation).provision({
    userId: USER_ID,
    email: EMAIL,
    displayName: "Offline Employee",
    requireInitialPasswordChange: false,
  });
  fakeAppServerLog = path.join(root, "fake-app-server.jsonl");
  fakeAppServer = path.join(root, "fake-codex-app-server.mjs");
  await writeFile(fakeAppServer, [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    `const logPath = ${JSON.stringify(fakeAppServerLog)};`,
    "let turnSequence = 0;",
    "const lines = createInterface({ input: process.stdin });",
    "const send = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);",
    "lines.on(\"line\", (line) => {",
    "  const rpc = JSON.parse(line);",
    "  appendFileSync(logPath, `${JSON.stringify(rpc)}\\n`);",
    "  if (!rpc.method || rpc.id === undefined) return;",
    "  if (rpc.method === \"initialize\") return send({ id: rpc.id, result: { userAgent: \"codex-http-e2e\" } });",
    "  if (rpc.method === \"account/read\") return send({ id: rpc.id, result: { account: { type: \"chatgpt\", planType: \"team\" } } });",
    "  if (rpc.method === \"model/list\") return send({ id: rpc.id, result: { data: [{ model: \"gpt-test\", displayName: \"GPT Test\", isDefault: true, inputModalities: [\"text\", \"image\"], supportedReasoningEfforts: [] }] } });",
    "  if (rpc.method === \"skills/list\") return send({ id: rpc.id, result: { data: [] } });",
    "  if (rpc.method === \"modelProvider/capabilities/read\") return send({ id: rpc.id, result: { webSearch: false, imageGeneration: false } });",
    "  if (rpc.method === \"account/rateLimits/read\") return send({ id: rpc.id, result: { rateLimits: { primary: { usedPercent: 0 } } } });",
    "  if (rpc.method === \"account/usage/read\") return send({ id: rpc.id, result: { summary: { lifetimeTokens: 0 } } });",
    "  if (rpc.method === \"thread/start\") return send({ id: rpc.id, result: { thread: { id: \"runtime-http-thread\" } } });",
    "  if (rpc.method === \"turn/start\") {",
    "    turnSequence += 1;",
    "    const threadId = rpc.params.threadId;",
    "    const turnId = `runtime-http-turn-${turnSequence}`;",
    "    send({ id: rpc.id, result: { turn: { id: turnId } } });",
    "    setTimeout(() => {",
    `      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "agent-http", delta: ${JSON.stringify(WORKER_REPLY)} } });`,
    "      send({ method: \"turn/completed\", params: { threadId, turn: { id: turnId, items: [], itemsView: \"full\", status: \"completed\", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });",
    "    }, 20);",
    "    return;",
    "  }",
    "  send({ id: rpc.id, result: {} });",
    "});",
  ].join("\n"), { mode: 0o700 });
  next = await startNext();
});

afterAll(async () => {
  await stopNext(next);
  await stopProvider();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("real worker HTTP session during Supabase outage", () => {
  it("streams through the private worker and replays durably after provider loss and restart", async () => {
    const login = await http("/api/auth/login", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify({ email: EMAIL, password: "Temporary-pass-123" }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ authenticated: true });
    cookie = sessionCookie(login);
    expect(providerRequests).toEqual(["POST /auth/v1/token?grant_type=password"]);

    await stopProvider();
    const session = await http("/api/auth/session");
    expect(session.status).toBe(200);
    const sessionBody = await session.json();
    assertUiContract("AuthSessionResponse", sessionBody);
    expect(sessionBody).toMatchObject({
      session: { provider: "local", user: { id: USER_ID, email: EMAIL } },
    });

    const projectResponse = await http("/api/projects", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify({ name: "Provider-independent project" }),
    });
    expect(projectResponse.status).toBe(201);
    const projectId = (await projectResponse.json() as { project: { id: string } }).project.id;
    const threadResponse = await http(`/api/projects/${projectId}/threads`, {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify({ title: "Offline workbench thread" }),
    });
    expect(threadResponse.status).toBe(201);
    const threadId = (await threadResponse.json() as { thread: { id: string } }).thread.id;
    const chatBody = {
      projectId,
      threadId,
      userMessageId: USER_MESSAGE_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
      message: "Respon des del worker privat",
      preferences: { tone: "direct", language: "es", showActivity: true },
      options: {
        mode: "agent",
        experience: "smart",
        model: null,
        effort: null,
        webSearch: false,
        imageGeneration: false,
        skill: null,
        attachments: [],
        documentUploadIds: [],
      },
    };
    const chat = await http("/api/chat", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify(chatBody),
    });
    expect(chat.status).toBe(200);
    expect(chat.headers.get("content-type")).toContain("application/x-ndjson");
    expect(chat.headers.get("x-aibrain-idempotent-replay")).toBeNull();
    const events = (await chat.text()).trim().split("\n").map((line) => JSON.parse(line) as {
      type: string;
      value?: string;
      item?: { label?: string };
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "activity",
        item: expect.objectContaining({ id: "runtime-connect", status: "complete" }),
      }),
      expect.objectContaining({ type: "done", durationMs: expect.any(Number) }),
    ]));
    expect(events.some((event) => event.type === "delta")).toBe(true);
    expect(events.reduce((content, event) => {
      if (event.type === "content") return event.value ?? content;
      if (event.type === "delta") return content + (event.value ?? "");
      return content;
    }, "")).toBe(WORKER_REPLY);

    const persisted = await http(`/api/threads/${threadId}`);
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toMatchObject({
      thread: {
        id: threadId,
        messages: [
          expect.objectContaining({ id: USER_MESSAGE_ID, role: "user", status: "complete" }),
          expect.objectContaining({ id: ASSISTANT_MESSAGE_ID, role: "assistant", status: "complete", content: WORKER_REPLY }),
        ],
      },
    });
    const requestsBeforeRestart = await appServerRequests();
    expect(requestsBeforeRestart.map((request) => request.method)).toEqual(expect.arrayContaining([
      "initialize", "account/read", "thread/start", "turn/start",
    ]));
    const turnStart = requestsBeforeRestart.find((request) => request.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: "runtime-http-thread",
      clientUserMessageId: USER_MESSAGE_ID,
      input: [expect.objectContaining({ type: "text", text: "Respon des del worker privat" })],
    });

    await stopNext(next);
    next = await startNext();
    const workbench = await http("/api/workbench");
    expect(workbench.status).toBe(200);
    const workbenchBody = await workbench.json();
    assertUiContract("WorkbenchResponse", workbenchBody);
    expect(workbenchBody.workbench.projects).toContainEqual(expect.objectContaining({ id: projectId }));
    expect(workbenchBody.workbench.threads).toContainEqual(expect.objectContaining({ projectId }));
    expect(providerRequests).toHaveLength(1);

    const replay = await http("/api/chat", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify(chatBody),
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-aibrain-idempotent-replay")).toBe("true");
    expect((await replay.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        type: "snapshot",
        message: expect.objectContaining({
          id: ASSISTANT_MESSAGE_ID,
          content: WORKER_REPLY,
          status: "complete",
        }),
      }),
    ]);
    const requestsAfterRestart = await appServerRequests();
    expect(requestsAfterRestart.filter((request) => request.method === "turn/start")).toHaveLength(1);

    const logout = await http("/api/auth/logout", {
      method: "POST",
      headers: { Origin: baseUrl },
    });
    expect(logout.status).toBe(200);
    cookie = sessionCookie(logout);
    expect((await http("/api/auth/session")).status).toBe(401);

    const unavailableLogin = await http("/api/auth/login", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify({ email: EMAIL, password: "Temporary-pass-123" }),
    });
    expect(unavailableLogin.status).toBe(503);
  });
});
