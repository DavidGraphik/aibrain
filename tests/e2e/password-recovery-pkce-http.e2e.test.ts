import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real built Next HTTP routes + encrypted durable files + protocol-fixture
// provider. Never contacts Supabase, SMTP, a customer account or a worker.
const users = Array.from({ length: 8 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  email: `employee${i}@example.test`,
}));
type Pending = { email: string; challenge: string; redirect: string };
const emails = new Map<string, { hash: string; pending: Pending }>();
const hashes = new Map<string, Pending>();
const codes = new Map<string, Pending>();
const expired = new Set<string>();
const access = new Map<string, typeof users[number]>();
let root = "", base = "", providerUrl = "", configFile = "";
let provider: Server, app: ChildProcess | undefined;
let appLogs = "", exchanges = 0, updates = 0, revocations = 0, unavailable = false;
const RECOVERY = "__Host-aibrain-password-recovery";
const SESSION = "__Host-aibrain-session";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}

function cookie(response: Response, name: string) {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!header) throw new Error(`Missing ${name} cookie`);
  return { header, value: header.split(";", 1)[0] };
}

async function startApp(port: number) {
  appLogs = "";
  app = spawn(process.execPath, [".next/standalone/server.js"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production", AIBRAIN_AUTH_MODE: "supabase",
      AIBRAIN_INSTALLATION_CONFIG: configFile, NEXT_PUBLIC_SUPABASE_URL: providerUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key",
      AIBRAIN_AUTH_CHALLENGE_SECRET: "synthetic-recovery-http-secret-at-least-32-bytes",
      AIBRAIN_SESSION_SECRET: "synthetic-local-http-secret-at-least-32-bytes",
    },
  });
  app.stdout?.on("data", (data) => { appLogs = (appLogs + data).slice(-6000); });
  app.stderr?.on("data", (data) => { appLogs = (appLogs + data).slice(-6000); });
  for (let i = 0; i < 200; i++) {
    if (app.exitCode !== null) throw new Error(`Next fixture stopped: ${appLogs}`);
    try { if ((await fetch(`${base}/api/health/live`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Next fixture not ready: ${appLogs}`);
}
async function stopApp() {
  if (!app || app.exitCode !== null) return;
  const stopped = new Promise<void>((resolve) => app!.once("exit", () => resolve()));
  app.kill("SIGTERM"); await stopped;
}

async function post(url: string, body: object, browserCookie = "", origin = base) {
  return fetch(`${base}${url}`, { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json", Cookie: browserCookie, "x-real-ip": "192.0.2.44",
  }, body: JSON.stringify(body) });
}
async function begin(email: string) {
  const response = await post("/api/auth/password/reset/request", { email });
  expect(response.status, appLogs).toBe(202); expect(await response.json()).toEqual({ accepted: true });
  const browser = cookie(response, RECOVERY);
  expect(browser.header).toMatch(/HttpOnly/i); expect(browser.header).toMatch(/Secure/i);
  expect(browser.header).toMatch(/SameSite=Lax/i); expect(browser.header).toMatch(/Path=\//i);
  return browser.value;
}
async function followDefaultEmail(email: string) {
  const message = emails.get(email); if (!message) throw new Error("Fixture email absent");
  const response = await fetch(`${providerUrl}/auth/v1/verify?token=${message.hash}&type=recovery`, { redirect: "manual" });
  expect(response.status).toBe(302); const callback = new URL(response.headers.get("location")!);
  expect(callback.origin).toBe(base); expect(callback.hash).toBe("");
  return callback;
}
function completion(code: string) { return { code, password: "Recovered-synthetic-pass-123", confirmation: "Recovered-synthetic-pass-123" }; }

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pkce-http-fixture-"));
  const appPort = await freePort(); base = `http://127.0.0.1:${appPort}`;
  configFile = path.join(root, "installation.json");
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, installationId: "pkce-http-fixture",
    companyName: "Synthetic Recovery", companySlug: "synthetic-recovery", publicUrl: base,
    branding: { productName: "Synthetic Recovery", logoPath: "/branding/example-lab/logo.svg", faviconPath: "/favicon.ico", accentColor: "#315ee7" },
    paths: { dataRoot: path.join(root, "data"), usersRoot: path.join(root, "data", "users"), companyContextRoot: path.join(root, "data", "company"),
      sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "published"), backupsRoot: path.join(root, "data", "backups") },
  }));
  for (const user of users) {
    const directory = path.join(root, "data", "users", user.id); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "user.json"), JSON.stringify({ schemaVersion: 1, userId: user.id, email: user.email,
      displayName: "Synthetic Employee", enabled: true, workerId: `synthetic-${user.id}` }));
  }
  provider = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture.invalid");
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const json = (status: number, value: object) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.method === "POST" && url.pathname === "/auth/v1/recover") {
      if (!users.some((user) => user.email === body.email)) return json(400, { code: "email_not_found", message: "not found" });
      if (body.code_challenge_method !== "s256" || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)) return json(400, { message: "PKCE challenge required" });
      const hash = randomBytes(32).toString("hex");
      const pending = { email: body.email, challenge: body.code_challenge, redirect: url.searchParams.get("redirect_to")! };
      hashes.set(hash, pending); emails.set(body.email, { hash, pending }); return json(200, {});
    }
    if (request.method === "GET" && url.pathname === "/auth/v1/verify") {
      const pending = hashes.get(url.searchParams.get("token")!);
      if (!pending || url.searchParams.get("type") !== "recovery") return json(403, { code: "otp_expired" });
      hashes.delete(url.searchParams.get("token")!);
      const code = randomBytes(24).toString("hex"); codes.set(code, pending);
      const callback = new URL(pending.redirect); callback.searchParams.set("code", code);
      response.writeHead(302, { Location: callback.href }); response.end(); return;
    }
    if (request.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      exchanges++; if (unavailable) return json(503, { message: "temporary outage" });
      const pending = codes.get(body.auth_code);
      if (!pending || expired.has(body.auth_code) || createHash("sha256").update(body.code_verifier ?? "").digest("base64url") !== pending.challenge) return json(403, { code: "otp_expired" });
      codes.delete(body.auth_code);
      const user = users.find((user) => user.email === pending.email)!;
      const token = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.synthetic-signature`;
      access.set(token, user);
      return json(200, { access_token: token, refresh_token: "synthetic-refresh-token", expires_in: 3600, token_type: "bearer", user: { id: user.id, email: user.email } });
    }
    const user = access.get((request.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (url.pathname === "/auth/v1/user" && user) {
      if (request.method === "PUT") { updates++; if (!body.password) return json(400, {}); }
      return json(200, { id: user.id, email: user.email });
    }
    if (request.method === "POST" && url.pathname === "/auth/v1/logout" && user) { revocations++; return json(200, {}); }
    json(404, { message: "not found" });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider port");
  providerUrl = `http://127.0.0.1:${address.port}`;
  await startApp(appPort);
}, 30_000);
afterAll(async () => { await stopApp(); if (provider) await new Promise<void>((resolve) => provider.close(() => resolve())); if (root) await rm(root, { recursive: true, force: true }); });

describe("default email -> same-browser PKCE -> local opaque session over real HTTP", () => {
  it("survives restart, defers exchange until password POST and permits exactly one concurrent completion", async () => {
    const browser = await begin(users[0].email);
    await stopApp(); await startApp(Number(new URL(base).port));
    const callback = await followDefaultEmail(users[0].email); const code = callback.searchParams.get("code")!;
    const before = exchanges;
    const page = await fetch(callback.href, { headers: { Cookie: browser } });
    expect(page.status).toBe(200); expect((await page.text()).match(/type="password"/g)).toHaveLength(2);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer"); expect(exchanges).toBe(before);
    const responses = await Promise.all([post("/api/auth/password/recovery", completion(code), browser), post("/api/auth/password/recovery", completion(code), browser)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 410]);
    expect(exchanges).toBe(before + 1); expect(updates).toBe(1); expect(revocations).toBe(1);
    const success = responses.find((response) => response.status === 200)!;
    expect(await success.json()).toEqual({ authenticated: true });
    expect(cookie(success, SESSION).value).not.toContain("synthetic-refresh-token");
    expect(cookie(success, RECOVERY).header).toMatch(/Max-Age=0/i);
  });

  it("rejects a foreign origin or another browser without exchanging or consuming the legitimate request", async () => {
    const browser = await begin(users[1].email); const callback = await followDefaultEmail(users[1].email);
    const body = completion(callback.searchParams.get("code")!); const before = exchanges;
    expect((await post("/api/auth/password/recovery", body, browser, "https://foreign.example.test")).status).toBe(403);
    expect((await post("/api/auth/password/recovery", body)).status).toBe(410);
    expect(exchanges).toBe(before);
    expect((await post("/api/auth/password/recovery", body, browser)).status).toBe(200);
  });

  it("rejects an expired provider code before password mutation", async () => {
    const browser = await begin(users[2].email); const callback = await followDefaultEmail(users[2].email);
    const code = callback.searchParams.get("code")!; expired.add(code); const before = updates;
    expect((await post("/api/auth/password/recovery", completion(code), browser)).status).toBe(410);
    expect(updates).toBe(before);
  });

  it("keeps invalid password retryable before proof consumption", async () => {
    const browser = await begin(users[3].email); const callback = await followDefaultEmail(users[3].email);
    const code = callback.searchParams.get("code")!; const before = exchanges;
    expect((await post("/api/auth/password/recovery", { code, password: "short", confirmation: "short" }, browser)).status).toBe(400);
    expect(exchanges).toBe(before);
    expect((await post("/api/auth/password/recovery", completion(code), browser)).status).toBe(200);
  });

  it("does not reveal unknown email existence through response body or missing binding cookie", async () => {
    const response = await post("/api/auth/password/reset/request", { email: "unknown@example.test" });
    expect(response.status, appLogs).toBe(202); expect(await response.json()).toEqual({ accepted: true });
    expect(cookie(response, RECOVERY).value.split("=", 2)[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("fails closed on provider outage and cannot replay claimed state", async () => {
    const browser = await begin(users[4].email); const callback = await followDefaultEmail(users[4].email);
    const body = completion(callback.searchParams.get("code")!); unavailable = true;
    expect((await post("/api/auth/password/recovery", body, browser)).status).toBe(503);
    unavailable = false; const before = exchanges;
    expect((await post("/api/auth/password/recovery", body, browser)).status).toBe(410);
    expect(exchanges).toBe(before);
  });
});
