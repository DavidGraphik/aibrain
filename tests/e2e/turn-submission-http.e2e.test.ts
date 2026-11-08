import { randomUUID } from "node:crypto";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import { UserProvisioner } from "@/users/provisioner";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const USER_ID = "0198b9f0-6631-7000-8000-000000000010";
const EMAIL = "offline.employee@example.test";
const WORKER_REPLY = "Factura fictícia recuperada sense duplicar el torn";
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
let originalWorkbook: Buffer;
let editedWorkbook: Buffer;
let stateFile = "";
let fakePreviewTool = "";
let serverOutput = "";

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
      // Preview rendering is an independent external-tool boundary. This test
      // exercises authenticated admission, byte retention and real transport,
      // not LibreOffice's rendering or XLS conversion fidelity.
      AIBRAIN_SOFFICE_BIN: fakePreviewTool,
      AIBRAIN_PDFINFO_BIN: fakePreviewTool,
      AIBRAIN_PDFTOPPM_BIN: fakePreviewTool,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (data: Buffer) => { serverOutput = (serverOutput + data.toString()).slice(-12_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
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
  root = await mkdtemp(path.join(tmpdir(), "aibrain-xlsx-recovery-http-e2e-"));
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
  originalWorkbook = (await generateLocalDocument({ format: "xlsx", title: "Fictional invoice", content: "Synthetic", rows: [["Total"], [48.28]] })).data;
  editedWorkbook = (await generateLocalDocument({ format: "xlsx", title: "Edited fictional invoice", content: "Synthetic", rows: [["Total"], [49.28]] })).data;
  const editedPath = path.join(root, "edited-fixture.xlsx");
  await writeFile(editedPath, editedWorkbook, { mode: 0o600 });
  fakePreviewTool = path.join(root, "synthetic-preview.mjs");
  await writeFile(fakePreviewTool, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--convert-to")) writeFileSync(path.join(process.cwd(), "input.pdf"), "%PDF-1.7\\nSynthetic preview only", {mode: 0o600});
else if (args.includes("-png")) writeFileSync(args.at(-1) + ".png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S0AAAAASUVORK5CYII=", "base64"), {mode: 0o600});
else process.stdout.write("Pages: 1\\nEncrypted: no\\n");
`, { mode: 0o700 });
  stateFile = path.join(root, "fake-remote-turns.json");
  await writeFile(stateFile, "{}", { mode: 0o600 });
  fakeAppServerLog = path.join(root, "fake-app-server.jsonl");
  fakeAppServer = path.join(root, "fake-codex-app-server.mjs");
  await writeFile(fakeAppServer, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
const log = ${JSON.stringify(fakeAppServerLog)};
const stateFile = ${JSON.stringify(stateFile)};
const edited = readFileSync(${JSON.stringify(editedPath)});
const reply = ${JSON.stringify(WORKER_REPLY)};
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const load = () => JSON.parse(readFileSync(stateFile, "utf8"));
const save = value => writeFileSync(stateFile, JSON.stringify(value));
const turn = record => ({id: record.turnId, status: record.status, error: null,
  items: [{type: "userMessage", id: "user", clientId: record.clientId, content: []},
    ...(record.status === "completed" ? [{type: "agentMessage", id: "answer", text: reply, phase: "final_answer"}] : [])]});
createInterface({input: process.stdin}).on("line", line => {
  const rpc = JSON.parse(line);
  appendFileSync(log, JSON.stringify(rpc) + "\\n");
  if (rpc.id === undefined) return;
  const result = value => send({id: rpc.id, result: value});
  if (rpc.method === "initialize") return result({userAgent: "synthetic-recovery-worker"});
  if (rpc.method === "account/read") return result({account: {type: "chatgpt", planType: "team"}});
  if (rpc.method === "model/list" || rpc.method === "skills/list") return result({data: []});
  if (rpc.method === "modelProvider/capabilities/read") return result({webSearch: false, imageGeneration: false});
  if (rpc.method === "thread/start") return result({thread: {id: "runtime-" + rpc.id}});
  if (rpc.method === "turn/start") {
    const records = load(), tid = rpc.params.threadId;
    if (records[tid]) throw new Error("DUPLICATE MODEL TURN");
    const manifest = rpc.params.input.find(i => i.type === "text" && i.text.startsWith("Authorized Excel attachments"));
    const files = JSON.parse(manifest.text.split("\\n").at(-1)).map(f => path.join(rpc.params.cwd, f.relativePath));
    for (const file of files) writeFileSync(file, edited, {mode: 0o600});
    records[tid] = {turnId: "turn-" + rpc.params.clientUserMessageId, clientId: rpc.params.clientUserMessageId, files, status: "inProgress"};
    save(records);
    result({turn: {id: records[tid].turnId}});
    // A real child exit after acceptance, with no model or network call.
    setTimeout(() => {
      appendFileSync(log, JSON.stringify({method: "fixture/child-exited", params: {clientUserMessageId: rpc.params.clientUserMessageId}}) + "\\n");
      process.exit(1);
    }, 40);
    return;
  }
  if (rpc.method === "thread/read" || rpc.method === "thread/resume") {
    const records = load(), tid = rpc.params.threadId, record = records[tid];
    if (!record) return result({thread: {id: tid, turns: []}});
    if (record.status === "inProgress") {
      for (const file of record.files) if (!readFileSync(file).equals(edited)) throw new Error("EDITED INPUT LOST");
      result({thread: {id: tid, turns: [turn(record)]}});
      setTimeout(() => {
        record.status = "completed"; records[tid] = record; save(records);
        send({method: "item/agentMessage/delta", params: {threadId: tid, turnId: record.turnId, itemId: "answer", delta: reply}});
        send({method: "turn/completed", params: {threadId: tid, turn: {...turn(record), itemsView: "full", startedAt: 1, completedAt: 2, durationMs: 1}}});
      }, 500);
      return;
    }
    return result({thread: {id: tid, turns: [turn(record)]}});
  }
  if (rpc.method === "thread/turns/list") return result({data: [], nextCursor: null});
  return result({});
});
`, { mode: 0o700 });
  next = await startNext();
  const login = await http("/api/auth/login", { method: "POST", headers: { Origin: baseUrl },
    body: JSON.stringify({ email: EMAIL, password: "Temporary-pass-123" }) });
  expect(login.status).toBe(200);
  cookie = sessionCookie(login);
  await stopProvider();
});

afterAll(async () => {
  await stopNext(next);
  await stopProvider();
  if (root) await rm(root, { recursive: true, force: true });
});

afterEach(({ task }) => {
  if (task.result?.state === "fail") console.error(serverOutput);
});

describe("authenticated XLSX recovery through real HTTP and worker transport", () => {
  it.each([1, 20])("preserves %i edited workbooks through child and backend restart without a second turn/start", async count => {
    const projectResponse = await http("/api/projects", { method: "POST", headers: { Origin: baseUrl },
      body: JSON.stringify({ name: `Fictional recovery ${count}` }) });
    expect(projectResponse.status).toBe(201);
    const projectId = (await projectResponse.json()).project.id;
    const threadResponse = await http(`/api/projects/${projectId}/threads`, { method: "POST", headers: { Origin: baseUrl },
      body: JSON.stringify({ title: `Synthetic invoices ${count}` }) });
    expect(threadResponse.status).toBe(201);
    const threadId = (await threadResponse.json()).thread.id;
    const uploads: Array<{ uploadId: string; relativePath: string }> = [];
    for (let index = 0; index < count; index++) {
      const form = new FormData();
      form.set("uploadId", randomUUID());
      form.set("file", new Blob([new Uint8Array(originalWorkbook)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `invoice-${index + 1}.xlsx`);
      const response = await fetch(`${baseUrl}/api/threads/${threadId}/documents`, {
        method: "POST", headers: { Cookie: cookie, Origin: baseUrl }, body: form,
      });
      const payload = await response.json();
      expect(response.status, JSON.stringify(payload) + serverOutput).toBe(201);
      uploads.push(payload.document);
    }
    const userMessageId = randomUUID(), assistantMessageId = randomUUID();
    const chatBody = { projectId, threadId, userMessageId, assistantMessageId,
      message: "Processa les factures fictícies adjuntes", preferences: { tone: "direct", language: "es", showActivity: true },
      options: { mode: "agent", experience: "smart", model: null, effort: null, webSearch: false, imageGeneration: false, skill: null,
        attachments: [], documentUploadIds: uploads.map(doc => doc.uploadId) } };
    const chat = () => http("/api/chat", { method: "POST", headers: { Origin: baseUrl }, body: JSON.stringify(chatBody) });
    const first = await chat();
    expect(first.status).toBe(200);
    // The backend may keep the interrupted stream open while reconnecting.
    // Crash it after actual worker exit instead of waiting for its idle timer.
    const firstText = first.text().catch(() => "");
    await expect.poll(async () => (await appServerRequests()).some(call =>
      call.method === "fixture/child-exited" && call.params?.clientUserMessageId === userMessageId),
    { timeout: 15_000 }).toBe(true);
    const remote = Object.values(JSON.parse(await readFile(stateFile, "utf8"))) as Array<{clientId: string; files: string[]; status: string}>;
    const record = remote.find(value => value.clientId === userMessageId)!;
    expect(record.files).toHaveLength(count);
    for (const file of record.files) expect(await readFile(file)).toEqual(editedWorkbook);
    const receiptPath = path.join(root, "data", "users", USER_ID, "state", "turn-submissions", threadId, `${assistantMessageId}.json`);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ phase: "dispatched" });
    await stopNext(next);
    expect((await firstText).includes('"type":"done"')).toBe(false);
    // Honor the real dead-process lease grace period; no product timers are
    // shortened and no durable record is rewritten by the recovery test.
    await new Promise(resolve => setTimeout(resolve, 31_000));
    next = await startNext();
    const recovered = await chat();
    expect(recovered.status).toBe(200);
    const events = (await recovered.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events.filter(event => event.type === "done")).toHaveLength(1);
    const persisted = await http(`/api/threads/${threadId}`);
    expect(await persisted.json()).toMatchObject({thread: {messages: [
      expect.objectContaining({id: userMessageId, role: "user"}),
      expect.objectContaining({id: assistantMessageId, status: "complete", content: WORKER_REPLY}),
    ]}});
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({phase: "terminal", terminal: "completed", turnRequest: null, inputs: null});
    for (const file of record.files) await expect(access(file)).rejects.toMatchObject({code: "ENOENT"});
    for (const doc of uploads) expect(await readFile(path.join(root, "data", "users", USER_ID, "staging", doc.relativePath))).toEqual(originalWorkbook);
    const replay = await chat();
    expect(replay.headers.get("x-aibrain-idempotent-replay")).toBe("true");
    await replay.text();
    const calls = await appServerRequests();
    expect(calls.filter(call => call.method === "turn/start" && call.params?.clientUserMessageId === userMessageId)).toHaveLength(1);
    expect(providerRequests).toEqual(["POST /auth/v1/token?grant_type=password"]);
  }, 120_000);
});
