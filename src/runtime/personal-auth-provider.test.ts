import { createServer, type ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personalAuthSocketPath, userAccessAuthProvider } from "./personal-auth-provider";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const identity = { installationId: "qa-personal", userId: "11111111-1111-4111-8111-111111111111" };
const TOKEN = "synthetic-access-token-for-personal-provider-test";
const snapshot = () => ({ ...identity, accessToken: TOKEN, chatgptAccountId: "account-qa", chatgptPlanType: "business" });

describe("personal access-token host provider", () => {
  let root: string;
  let socket: string;
  let environment: Record<string, string>;
  let respond: (response: ServerResponse) => void;
  let metadata: (file: string, value: Awaited<ReturnType<typeof fs.lstat>>) => Awaited<ReturnType<typeof fs.lstat>>;
  let requests: Array<{ method: string | undefined; path: string | undefined; body: unknown }>;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    // A short real Unix path is necessary on macOS. Only root ownership is
    // simulated: the HTTP exchange, permissions, bounds and cleanup are real.
    root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "pa-"));
    environment = { AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT: root };
    socket = personalAuthSocketPath(identity, environment)!;
    await fs.mkdir(path.dirname(socket), { mode: 0o700 });
    requests = [];
    respond = response => response.end(JSON.stringify(snapshot()));
    metadata = (_file, value) => value;
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.lstat).mockImplementation((async (file: string) => {
      const value = await actual.lstat(file);
      const owned = file === root || file.startsWith(`${root}${path.sep}`)
        ? Object.create(value, { uid: { value: 0 } }) as typeof value : value;
      return metadata(file, owned);
    }) as typeof fs.lstat);
    server = createServer((request, response) => {
      let data = "";
      request.on("data", chunk => { data += chunk; });
      request.on("end", () => {
        requests.push({ method: request.method, path: request.url, body: JSON.parse(data) });
        respond(response);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    await fs.chown(socket, process.geteuid!(), process.getegid!());
    await fs.chmod(socket, 0o660);
  });

  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("is optional and derives the socket only from server configuration and canonical identity", () => {
    expect(userAccessAuthProvider(identity, { environment: {} })).toBeUndefined();
    expect(socket).toBe(path.join(root, identity.installationId, `${identity.userId}.sock`));
    for (const changed of [
      { ...identity, userId: "../another-user" },
      { ...identity, userId: identity.userId.toUpperCase().replace("1111", "FFFF") },
      { ...identity, installationId: "../other-tenant" },
    ]) expect(() => personalAuthSocketPath(changed, environment)).toThrow("scope");
    for (const value of ["relative", `${root}/../different`, "/", `/${"x".repeat(110)}`]) {
      expect(() => personalAuthSocketPath(identity, { AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT: value })).toThrow();
    }
  });

  it.each([
    { AIBRAIN_CODEX_AUTH_SCOPE: "shared-qa" },
    { AIBRAIN_CODEX_AUTH_SCOPE: "installation-owner" },
    { AIBRAIN_SHARED_CODEX_AUTH_SOURCE: "/private/auth.json" },
    { AIBRAIN_CODEX_OWNER_AUTH_SOCKET: "/run/owner.sock" },
    { AIBRAIN_INSTALLATION_OWNER_AUTH_ACK: identity.installationId },
  ])("rejects mixed shared/owner configuration %j", mixed => {
    expect(() => userAccessAuthProvider(identity, { environment: { ...environment, ...mixed } })).toThrow("shared");
  });

  it("reads a bound snapshot, sends no credential to the broker, and remembers the account", async () => {
    const provider = userAccessAuthProvider(identity, { environment })!;
    expect(await provider()).toEqual({ accessToken: TOKEN, chatgptAccountId: "account-qa", chatgptPlanType: "business" });
    respond = response => response.end(JSON.stringify({ ...snapshot(), chatgptPlanType: null }));
    expect((await provider()).chatgptPlanType).toBeNull();
    expect(requests).toEqual([
      { method: "POST", path: "/access", body: { ...identity, previousAccountId: null } },
      { method: "POST", path: "/access", body: { ...identity, previousAccountId: "account-qa" } },
    ]);
    expect(JSON.stringify(requests)).not.toContain(TOKEN);
    await expect(provider("different-account")).rejects.toThrow("Personal authentication is unavailable");
    expect(requests).toHaveLength(2);
  });

  it("rejects an account change and an unchanged rejected token without refreshing it", async () => {
    const provider = userAccessAuthProvider(identity, { environment })!;
    await provider();
    respond = response => response.end(JSON.stringify({ ...snapshot(), chatgptAccountId: "different-account" }));
    await expect(provider()).rejects.toThrow("Personal authentication is unavailable");
    respond = response => response.end(JSON.stringify(snapshot()));
    await expect(provider("account-qa", TOKEN)).rejects.toThrow("Personal authentication is unavailable");
    respond = response => response.end(JSON.stringify({ ...snapshot(), accessToken: `${TOKEN}-renewed-by-host` }));
    expect((await provider("account-qa", TOKEN)).accessToken).toBe(`${TOKEN}-renewed-by-host`);
    expect(requests.every(item => item.path === "/access")).toBe(true);
  });

  it.each([
    { installationId: "other-tenant" }, { userId: "22222222-2222-4222-8222-222222222222" },
    { refreshToken: "must-never-be-accepted" }, { idToken: "must-never-be-accepted" },
    { accessToken: "short" }, { accessToken: `${TOKEN}\n` }, { accessToken: 123 },
    { chatgptAccountId: "wrong account\n" }, { chatgptPlanType: { value: "business" } },
  ])("rejects foreign binding, extra keys and invalid token/account shapes %j", changed => {
    respond = response => response.end(JSON.stringify({ ...snapshot(), ...changed }));
    return expect(userAccessAuthProvider(identity, { environment })!()).rejects.toThrow("Personal authentication is unavailable");
  });

  it("requires the complete exact response contract and hides invalid response content", async () => {
    respond = response => response.end(JSON.stringify({ ...identity, accessToken: TOKEN, chatgptAccountId: "account-qa" }));
    await expect(userAccessAuthProvider(identity, { environment })!()).rejects.toThrow("Personal authentication is unavailable");
    respond = response => response.end(`${TOKEN} invalid-json`);
    try { await userAccessAuthProvider(identity, { environment })!(); throw new Error("Expected rejection"); }
    catch (error) { expect((error as Error).message).not.toContain(TOKEN); }
  });

  it.each(["socket-owner", "socket-mode", "socket-group", "socket-symlink", "directory-owner", "directory-writable"])("rejects unsafe %s before requesting credentials", async defect => {
    metadata = (file, value) => {
      if (file === socket) {
        if (defect === "socket-owner") return Object.create(value, { uid: { value: 12345 } });
        if (defect === "socket-mode") return Object.create(value, { mode: { value: Number(value.mode) | 0o002 } });
        if (defect === "socket-group") return Object.create(value, { gid: { value: (process.getegid?.() ?? 0) + 1 } });
        if (defect === "socket-symlink") return Object.create(value, { isSymbolicLink: { value: () => true } });
      }
      if (file === root) {
        if (defect === "directory-owner") return Object.create(value, { uid: { value: 12345 } });
        if (defect === "directory-writable") return Object.create(value, { mode: { value: Number(value.mode) | 0o020 } });
      }
      return value;
    };
    await expect(userAccessAuthProvider(identity, { environment })!()).rejects.toThrow("Personal authentication is unavailable");
    expect(requests).toHaveLength(0);
  });

  it("rejects replacement of the trusted socket during a request", async () => {
    let socketReads = 0;
    metadata = (file, value) => file === socket && ++socketReads > 1
      ? Object.create(value, { ino: { value: Number(value.ino) + 1 } }) : value;
    await expect(userAccessAuthProvider(identity, { environment })!()).rejects.toThrow("Personal authentication is unavailable");
    expect(requests).toHaveLength(1);
  });

  it("rejects a symlinked broker root before contacting the socket", async () => {
    const alias = `${root}-linked`;
    await fs.symlink(root, alias);
    try {
      await expect(userAccessAuthProvider(identity, { environment: { AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT: alias } })!())
        .rejects.toThrow("Personal authentication is unavailable");
      expect(requests).toHaveLength(0);
    } finally { await fs.unlink(alias); }
  });

  it.each(["status", "oversize", "timeout"])("bounds and fails closed on broker %s", async failure => {
    respond = response => {
      if (failure === "status") { response.statusCode = 403; response.end(TOKEN); }
      else if (failure === "oversize") response.end(JSON.stringify({ ...snapshot(), accessToken: "x".repeat(33_000) }));
    };
    await expect(userAccessAuthProvider(identity, { environment, timeoutMs: 50 })!()).rejects.toThrow("Personal authentication is unavailable");
  });
});
