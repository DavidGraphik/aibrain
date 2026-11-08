import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { ResourceLockManager } from "@/storage";
import { buildWorkerLaunchContext, deriveWorkerRoots } from "./provisioner";
import { stopOwnedWorkerProcess } from "./owned-process";
import type { ChatgptAuthTokensRefreshResponse } from "../../../contracts/codex/0.162.1/types/v2/ChatgptAuthTokensRefreshResponse";

export type SharedAuthTokens = ChatgptAuthTokensRefreshResponse;
export type SharedAuthProvider = (previousAccountId?: string | null, rejectedAccessToken?: string) => Promise<SharedAuthTokens>;

function claims(token: unknown): Record<string, unknown> {
  if (typeof token !== "string" || token.length > 32_768) throw new Error("Shared authentication token is invalid.");
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch { throw new Error("Shared authentication token is invalid."); }
}

/** JWT fields are hints for expiry/account binding, never a local authorization
 * decision. Only the provider validates the token. No token enters a journal. */
export function sharedAuthSnapshot(value: unknown) {
  const auth = value as { tokens?: { access_token?: string; id_token?: string; account_id?: string } };
  const token = auth?.tokens?.access_token;
  const access = claims(token);
  const metadata = access["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const accountId = auth.tokens?.account_id ?? metadata?.chatgpt_account_id;
  if (typeof token !== "string" || !token || typeof accountId !== "string" || !accountId ||
      accountId.length > 256 || typeof access.exp !== "number" || !Number.isSafeInteger(access.exp)) {
    throw new Error("Shared authentication has no valid account or expiry.");
  }
  if (metadata?.chatgpt_account_id && metadata.chatgpt_account_id !== accountId) {
    throw new Error("Shared authentication account binding is inconsistent.");
  }
  const plan = metadata?.chatgpt_plan_type;
  return { expiresAt: access.exp * 1000, tokens: {
    accessToken: token, chatgptAccountId: accountId,
    chatgptPlanType: typeof plan === "string" ? plan : null,
  } satisfies SharedAuthTokens };
}

async function readSource(config: Readonly<InstallationConfig>, source: string) {
  const canonicalRoot = await realpath(config.paths.dataRoot);
  const canonicalSource = await realpath(source);
  const relative = path.relative(canonicalRoot, canonicalSource);
  const declaredRelative = path.relative(path.resolve(config.paths.dataRoot), path.resolve(source));
  if (canonicalSource !== path.join(canonicalRoot, declaredRelative) || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Shared authentication source escapes the installation.");
  }
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.geteuid?.() || stat.size < 2 || stat.size > 1024 * 1024) {
      throw new Error("Shared authentication source is unsafe.");
    }
    return sharedAuthSnapshot(JSON.parse((await handle.readFile()).toString("utf8")));
  } finally { await handle.close(); }
}

/** One managed App Server owns renewal, under a filesystem lease shared by the
 * web and automation processes. It executes only initialize and account/read.
 * Employee App Servers receive external access tokens and never refresh tokens. */
export function sharedAuthProvider(config: Readonly<InstallationConfig>, egress: Readonly<Record<string, string>>,
  options: { source?: string; now?: () => number; refresh?: () => Promise<void> } = {}): SharedAuthProvider | undefined {
  if (!options.source && process.env.AIBRAIN_CODEX_AUTH_SCOPE !== "shared-qa") return undefined;
  const source = options.source ?? process.env.AIBRAIN_SHARED_CODEX_AUTH_SOURCE;
  if (!source || !path.isAbsolute(source) || path.basename(source) !== "auth.json") {
    throw new Error("Shared authentication source is unavailable.");
  }
  const locks = new ResourceLockManager({ rootDirectory: path.join(config.paths.dataRoot, "locks", "shared-codex-auth") });
  const now = options.now ?? Date.now;
  const refresh = options.refresh ?? (() => refreshManagedSource(config, source, egress));
  return async (previousAccountId, rejectedAccessToken) => locks.withLock(`shared-auth:${config.installationId}`, async lease => {
    const before = await readSource(config, source);
    if (previousAccountId && before.tokens.chatgptAccountId !== previousAccountId) {
      throw new Error("Shared authentication account changed; reconnect explicitly.");
    }
    if (before.expiresAt > now() + 5 * 60_000 && before.tokens.accessToken !== rejectedAccessToken) return before.tokens;
    await lease.assertHeld();
    await refresh();
    await lease.assertHeld();
    const after = await readSource(config, source);
    if (after.tokens.chatgptAccountId !== before.tokens.chatgptAccountId || after.expiresAt <= now() + 60_000 ||
        after.tokens.accessToken === rejectedAccessToken) {
      throw new Error("Shared authentication renewal was not verified.");
    }
    return after.tokens;
  }, { timeoutMs: 8_000 });
}

async function refreshManagedSource(config: Readonly<InstallationConfig>, source: string, egress: Readonly<Record<string, string>>) {
  const userId = path.relative(config.paths.usersRoot, source).split(path.sep)[0];
  const roots = deriveWorkerRoots(config, userId);
  if (path.resolve(source) !== path.join(roots.codexHome, "auth.json")) {
    throw new Error("Managed authentication source requires its provisioned owner.");
  }
  const context = buildWorkerLaunchContext(config, {
    schemaVersion: 1, installationId: config.installationId, userId,
    workerId: `worker-${userId}`, roots, provisionedAt: new Date().toISOString(),
  });
  const child = spawn(process.env.CODEX_BIN?.trim() || "codex", ["app-server", "--stdio"], {
    cwd: context.workspace, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    env: { NODE_ENV: process.env.NODE_ENV ?? "production", PATH: process.env.PATH, LANG: process.env.LANG, TZ: process.env.TZ,
      SSL_CERT_FILE: process.env.SSL_CERT_FILE, SSL_CERT_DIR: process.env.SSL_CERT_DIR,
      ...egress, ...context.environment },
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const fail = () => { for (const waiter of pending.values()) waiter.reject(new Error("Shared authentication renewal requires operator login.")); };
  child.stderr.resume();
  child.on("error", fail);
  child.on("exit", fail);
  lines.on("line", line => {
    if (Buffer.byteLength(line) > 1024 * 1024) { fail(); return; }
    try {
      const rpc = JSON.parse(line);
      const waiter = pending.get(rpc.id);
      if (waiter) { pending.delete(rpc.id); if (rpc.error) waiter.reject(new Error("Shared authentication renewal requires operator login.")); else waiter.resolve(); }
    } catch { fail(); }
  });
  const request = (id: string, method: string, params: unknown, timeoutMs: number) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Shared authentication renewal timed out.")); }, timeoutMs);
    pending.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => { if (error) fail(); });
  });
  try {
    await request("auth-owner-init", "initialize", { clientInfo: { name: "aibrain_auth_owner", version: "1" }, capabilities: { experimentalApi: true } }, 3_000);
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    await request("auth-owner-refresh", "account/read", { refreshToken: true }, 4_000);
  } finally {
    lines.close();
    fail();
    await stopOwnedWorkerProcess(child, process.platform !== "win32", 100, 1_000);
  }
}
