import { lstat, realpath } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { CATALOG_UUID } from "@/catalog/contracts";
import type { WorkerLaunchContext } from "@/runtime/workers/types";
import type { SharedAuthProvider, SharedAuthTokens } from "@/runtime/workers/shared-auth-broker";

type Environment = Readonly<Record<string, string | undefined>>;
type Identity = Pick<WorkerLaunchContext, "installationId" | "userId">;
const MAX_RESPONSE_BYTES = 32_768;
const unavailable = () => new Error("Personal authentication is unavailable; reconnect your account.");

/** Backend configuration only. No pathname or identity is accepted from a
 * browser, and this socket is never exposed in the employee environment. */
export function personalAuthSocketPath(context: Identity, environment: Environment = process.env): string | null {
  const root = environment.AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT?.trim();
  if (!root) return null;
  if ((environment.AIBRAIN_CODEX_AUTH_SCOPE?.trim() || "per-user") !== "per-user"
      || environment.AIBRAIN_SHARED_CODEX_AUTH_SOURCE?.trim()
      || environment.AIBRAIN_CODEX_OWNER_AUTH_SOCKET?.trim()
      || environment.AIBRAIN_INSTALLATION_OWNER_AUTH_ACK?.trim()) {
    throw new Error("Personal authentication cannot use shared or installation-owner credentials.");
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(context.installationId)
      || context.installationId.length > 63 || context.installationId.length < 2
      || !CATALOG_UUID.test(context.userId)
      || !path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root) {
    throw new Error("Personal authentication scope is invalid.");
  }
  const socket = path.join(root, context.installationId, `${context.userId}.sock`);
  // Portable across the supported macOS/Linux Unix-domain socket limits.
  if (Buffer.byteLength(socket) > 103) throw new Error("Personal authentication socket path is too long.");
  return socket;
}

async function inspectSocket(socket: string) {
  const root = path.dirname(path.dirname(socket));
  if (await realpath(root) !== root) throw unavailable();
  let directory = path.dirname(socket);
  for (;;) {
    const metadata = await lstat(directory);
    // Root-owned sticky system temporary directories cannot replace a
    // root-owned child. All other parents must reject group/world writes.
    const protectedStickyParent = directory !== root && directory !== path.dirname(socket)
      && (metadata.mode & 0o1000) !== 0;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0
        || (metadata.mode & 0o022) !== 0 && !protectedStickyParent) throw unavailable();
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const metadata = await lstat(socket);
  if (!metadata.isSocket() || metadata.isSymbolicLink() || metadata.uid !== 0
      || (metadata.mode & 0o600) !== 0o600 || (metadata.mode & 0o117) !== 0
      || (metadata.mode & 0o060) !== 0 && metadata.gid !== process.getegid?.()) throw unavailable();
  return { dev: metadata.dev, ino: metadata.ino };
}

function parseAccess(value: unknown, context: Identity, previousAccountId?: string | null): SharedAuthTokens {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "accessToken,chatgptAccountId,chatgptPlanType,installationId,userId"
      || item.installationId !== context.installationId || item.userId !== context.userId
      || typeof item.accessToken !== "string" || item.accessToken.length < 32
      || item.accessToken.length > 24_576 || !/^[\x21-\x7e]+$/.test(item.accessToken)
      || typeof item.chatgptAccountId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(item.chatgptAccountId)
      || previousAccountId && item.chatgptAccountId !== previousAccountId
      || item.chatgptPlanType !== null && (typeof item.chatgptPlanType !== "string"
        || item.chatgptPlanType.length > 128 || !/^[\x20-\x7e]+$/.test(item.chatgptPlanType))) throw unavailable();
  return {
    accessToken: item.accessToken,
    chatgptAccountId: item.chatgptAccountId,
    chatgptPlanType: item.chatgptPlanType as string | null,
  };
}

function readSnapshot(socketPath: string, context: Identity, previousAccountId: string | null, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ installationId: context.installationId, userId: context.userId, previousAccountId });
    const req = request({ socketPath, path: "/access", method: "POST", agent: false, headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(body),
    } }, res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) { req.destroy(unavailable()); return; }
        chunks.push(Buffer.from(chunk));
      });
      res.on("error", () => reject(unavailable()));
      res.on("end", () => {
        try {
          if (res.statusCode !== 200 || bytes > MAX_RESPONSE_BYTES) throw unavailable();
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch { reject(unavailable()); }
      });
    });
    const deadline = setTimeout(() => req.destroy(unavailable()), timeoutMs);
    req.once("close", () => clearTimeout(deadline));
    req.once("error", () => reject(unavailable()));
    req.end(body);
  });
}

/** Supplies only the host's current access-token snapshot. The host owns the
 * official sign-in/renewal lifecycle; this module never reads auth files,
 * receives refresh tokens, starts OAuth, or renews a token itself. */
export function userAccessAuthProvider(context: Identity, options: { environment?: Environment; timeoutMs?: number } = {}): SharedAuthProvider | undefined {
  const socket = personalAuthSocketPath(context, options.environment);
  if (!socket) return undefined;
  const timeoutMs = options.timeoutMs ?? 8_500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8_500) throw new Error("Personal authentication timeout is invalid.");
  const identity = Object.freeze({ installationId: context.installationId, userId: context.userId });
  let accountId: string | null = null;
  return async (previousAccountId, rejectedAccessToken) => {
    try {
      if (accountId && previousAccountId && previousAccountId !== accountId) throw unavailable();
      const previous = accountId ?? previousAccountId ?? null;
      const before = await inspectSocket(socket);
      const access = parseAccess(await readSnapshot(socket, identity, previous, timeoutMs), identity, previous);
      const after = await inspectSocket(socket);
      if (before.dev !== after.dev || before.ino !== after.ino
          || accountId && access.chatgptAccountId !== accountId
          || rejectedAccessToken && access.accessToken === rejectedAccessToken) throw unavailable();
      accountId = access.chatgptAccountId;
      return access;
    } catch { throw unavailable(); }
  };
}
