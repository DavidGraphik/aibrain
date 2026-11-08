import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseInstallationConfig, type InstallationConfig } from "@/config/installation-schema";
import { FileLibraryResourceLocationIndex } from "@/library/resource-location-index";
import { UserProvisioner } from "@/users/provisioner";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const OWNER_ID = "0198b9f0-6631-7000-8000-000000000020";
const OTHER_USER_ID = "0198b9f0-6631-7000-8000-000000000021";
const OWNER_EMAIL = "image.owner@example.test";
const OTHER_EMAIL = "image.other@example.test";
const PASSWORD = "Temporary-pass-123";
const ARTIFACT_ID = "0198b9f0-6631-7000-8000-000000000022";
const MESSAGE_ID = "0198b9f0-6631-7000-8000-000000000023";
const FILE_NAME = "imagen-http-real.png";
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
type NextProcess = ChildProcessByStdio<null, Readable, Readable>;

let temporaryRoot = "";
let applicationRoot = "";
let configPath = "";
let installation: InstallationConfig;
let appPort = 0;
let baseUrl = "";
let providerUrl = "";
let provider: Server | null = null;
let next: NextProcess | null = null;

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function realPng() {
  const width = 96;
  const height = 96;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    pixels[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const seed = (x * 73 + y * 151 + x * y * 19) >>> 0;
      pixels[offset] = seed & 0xff;
      pixels[offset + 1] = (seed >>> 3) & 0xff;
      pixels[offset + 2] = (seed >>> 7) & 0xff;
      pixels[offset + 3] = 0xff;
      offset += 4;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

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

async function startProvider() {
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/auth/v1/token" || url.searchParams.get("grant_type") !== "password") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { email?: string; password?: string };
    const userId = body.email === OWNER_EMAIL
      ? OWNER_ID
      : body.email === OTHER_EMAIL
        ? OTHER_USER_ID
        : null;
    if (!userId || body.password !== PASSWORD) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_grant", error_description: "invalid credentials" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({
      access_token: `synthetic-access-token-${userId}`,
      token_type: "bearer",
      expires_in: 3_600,
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      refresh_token: `synthetic-refresh-token-${userId}`,
      user: {
        id: userId,
        email: body.email,
        aud: "authenticated",
        role: "authenticated",
        created_at: "2026-09-04T00:00:00.000Z",
      },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Identity provider did not bind.");
  providerUrl = `http://127.0.0.1:${address.port}`;
  provider = server;
}

async function waitForNext(child: NextProcess, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-12_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next server exited early.\n${output}`);
    try {
      const health = await fetch(`${baseUrl}/api/health/live`, { signal: AbortSignal.timeout(1_000) });
      const session = health.ok
        ? await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(2_000) })
        : null;
      if (health.ok && session?.status === 401) return;
    } catch {
      // Next is still starting or compiling the copied application.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
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
      AIBRAIN_INSTALLATION_CONFIG: configPath,
      AIBRAIN_SESSION_SECRET: "image-http-e2e-secret-0123456789abcdef0123456789abcdef",
      NEXT_PUBLIC_SUPABASE_URL: providerUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key",
      CHAT_RUNTIME: "demo",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForNext(child);
  return child;
}

async function stopNext(child: NextProcess | null) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await exited;
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Local session cookie was not issued.");
  return setCookie.split(";", 1)[0];
}

function authenticated(cookie: string, pathname: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Cookie: cookie,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "aibrain-generated-image-http-"));
  applicationRoot = path.join(temporaryRoot, "application");
  await mkdir(applicationRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    "src", "contracts", "public", "config", "infra/shared", "next.config.ts", "next-env.d.ts", "package.json",
    "postcss.config.mjs", "tsconfig.json", "tsconfig.build.json",
  ].map((entry) => cp(path.join(repositoryRoot, entry), path.join(applicationRoot, entry), { recursive: true })));
  await symlink(path.join(repositoryRoot, "node_modules"), path.join(applicationRoot, "node_modules"), "dir");
  await startProvider();
  appPort = await availablePort();
  baseUrl = `http://127.0.0.1:${appPort}`;

  const dataRoot = path.join(temporaryRoot, "data");
  const usersRoot = path.join(dataRoot, "users");
  const sourceReadRoot = path.join(temporaryRoot, "source-ro");
  const publishWriteRoot = path.join(temporaryRoot, "publish-rw");
  await Promise.all([
    mkdir(dataRoot, { recursive: true, mode: 0o700 }),
    mkdir(sourceReadRoot, { recursive: true, mode: 0o700 }),
    mkdir(publishWriteRoot, { recursive: true, mode: 0o700 }),
  ]);
  configPath = path.join(temporaryRoot, "installation.json");
  installation = parseInstallationConfig({
    schemaVersion: 1,
    installationId: "generated-image-http-e2e",
    companyName: "Generated Image HTTP Laboratory",
    companySlug: "generated-image-http-laboratory",
    publicUrl: baseUrl,
    branding: {
      productName: "Generated Image HTTP Brain",
      logoPath: "/branding/example-lab/logo.svg",
      faviconPath: "/branding/example-lab/favicon.svg",
      accentColor: "#0f766e",
    },
    paths: {
      dataRoot,
      companyContextRoot: path.join(dataRoot, "company"),
      usersRoot,
      sourceReadRoot,
      publishWriteRoot,
      backupsRoot: path.join(dataRoot, "backups"),
    },
  });
  await writeFile(configPath, `${JSON.stringify(installation, null, 2)}\n`, { mode: 0o600 });
  const provisioner = new UserProvisioner(installation);
  await provisioner.provision({
    userId: OWNER_ID,
    email: OWNER_EMAIL,
    displayName: "Image Owner",
    requireInitialPasswordChange: false,
  });
  await provisioner.provision({
    userId: OTHER_USER_ID,
    email: OTHER_EMAIL,
    displayName: "Unrelated User",
    requireInitialPasswordChange: false,
  });
  next = await startNext();
});

afterAll(async () => {
  await stopNext(next);
  if (provider) await new Promise<void>((resolve) => provider?.close(() => resolve()));
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe("generated image over real authenticated Next HTTP", () => {
  it("serves only real PNG bytes to the owner and keeps internal paths private", async () => {
    const ownerCookie = await login(OWNER_EMAIL);
    const projectResponse = await authenticated(ownerCookie, "/api/projects", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify({ name: "HTTP image delivery" }),
    });
    expect(projectResponse.status, await projectResponse.clone().text()).toBe(201);
    const projectId = (await projectResponse.json() as { project: { id: string } }).project.id;
    const threadResponse = await authenticated(ownerCookie, `/api/projects/${projectId}/threads`, {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify({ title: "Generated PNG" }),
    });
    expect(threadResponse.status, await threadResponse.clone().text()).toBe(201);
    const threadId = (await threadResponse.json() as { thread: { id: string } }).thread.id;

    const png = realPng();
    expect(png.byteLength).toBeGreaterThan(1_024);
    expect(png.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
    const relativePath = `generated-image-artifacts/${ARTIFACT_ID}.png`;
    const artifactRoot = path.join(installation.paths.dataRoot, "generated-image-artifacts");
    await mkdir(artifactRoot, { mode: 0o700 });
    await writeFile(path.join(artifactRoot, `${ARTIFACT_ID}.png`), png, { mode: 0o600 });
    await new FileLibraryResourceLocationIndex({
      dataRoot: installation.paths.dataRoot,
      installationId: installation.installationId,
    }).register({
      kind: "generated-image",
      resourceId: ARTIFACT_ID,
      projectId,
      threadId,
      messageId: MESSAGE_ID,
      storageOwnerId: OWNER_ID,
      relativePath,
      fileName: FILE_NAME,
      mediaType: "image/png",
      size: png.byteLength,
      sha256: createHash("sha256").update(png).digest("hex"),
    });

    const artifactPath = `/api/projects/${projectId}/artifacts/${ARTIFACT_ID}`;
    const anonymous = await fetch(`${baseUrl}${artifactPath}`);
    expect(anonymous.status).toBe(401);

    const unrelatedCookie = await login(OTHER_EMAIL);
    const unrelated = await authenticated(unrelatedCookie, artifactPath);
    expect(unrelated.status).toBe(404);

    const inline = await authenticated(ownerCookie, artifactPath);
    expect(inline.status, await inline.clone().text()).toBe(200);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(inline.headers.get("content-length")).toBe(String(png.byteLength));
    expect(inline.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(inline.headers.get("content-disposition")).toBe(
      `inline; filename="${FILE_NAME}"; filename*=UTF-8''${FILE_NAME}`,
    );
    const inlineBytes = Buffer.from(await inline.arrayBuffer());
    expect(inlineBytes.byteLength).toBeGreaterThan(1_024);
    expect(inlineBytes.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
    expect(inlineBytes).toEqual(png);

    const download = await authenticated(ownerCookie, `${artifactPath}?download=1`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("content-length")).toBe(String(png.byteLength));
    const disposition = download.headers.get("content-disposition") ?? "";
    expect(disposition).toBe(`attachment; filename="${FILE_NAME}"; filename*=UTF-8''${FILE_NAME}`);
    expect(disposition).toMatch(/filename="[^".]+(?:[-_.][^".]*)*\.png"/u);
    expect(disposition).not.toContain(".png.json");
    const downloadBytes = Buffer.from(await download.arrayBuffer());
    expect(downloadBytes.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
    expect(downloadBytes).toEqual(png);

    const internalPath = await authenticated(
      ownerCookie,
      `/api/projects/${projectId}/files?path=${encodeURIComponent(`.aibrain/artifacts/${ARTIFACT_ID}.png`)}&raw=1`,
    );
    expect(internalPath.status).toBe(404);
  });
});
