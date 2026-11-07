import "server-only";

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { ResourceLockManager, atomicWriteJson, defineVersionedSchema, recoverAtomicJsonFile } from "@/storage";
import { CATALOG_ID, CATALOG_UUID } from "@/catalog/contracts";
import { validExecutionOrigin, type WorkerExecutionOrigin } from "@/runtime/workers/kernel-ownership";
import { NativeConnectionError } from "@/connectors/native-connection-lifecycle";

export const NATIVE_OAUTH_PORT_MIN = 43100;
export const NATIVE_OAUTH_PORT_MAX = 43355;
const TTL = 10 * 60_000;
const GRACE = 30_000;
const MAX_ATTEMPTS = 256;
const ID = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
type Phase = "preparing" | "pending" | "consuming" | "completed" | "failed" | "uncertain" | "revoked";
export type NativeOAuthAttempt = {
  id: string; userId: string; resourceId: string; server: string; generation: WorkerExecutionOrigin;
  port: number; createdAt: number; expiresAt: number; phase: Phase;
  nativePath: string | null; stateHash: string | null; loginId: string | null;
};
type State = { schemaVersion: 1; installationId: string; attempts: NativeOAuthAttempt[] };
export type NativeOAuthOwner = { userId: string; resourceId: string; server: string; generation: WorkerExecutionOrigin };
const error = (code: string, status = 409) => new NativeConnectionError(code, status);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const NATIVE_OAUTH_CALLBACK_PATH = "/api/connectors/native/callback";
export const sameNativeOAuthGeneration = (left: WorkerExecutionOrigin, right: WorkerExecutionOrigin) =>
  left.generation === right.generation && left.instanceId === right.instanceId && left.dev === right.dev && left.ino === right.ino;
function validAttempt(value: unknown): value is NativeOAuthAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as NativeOAuthAttempt;
  return Object.keys(v).sort().join() === "createdAt,expiresAt,generation,id,loginId,nativePath,phase,port,resourceId,server,stateHash,userId"
    && typeof v.id === "string" && typeof v.userId === "string" && typeof v.resourceId === "string" && typeof v.server === "string"
    && ID.test(v.id) && CATALOG_UUID.test(v.userId) && CATALOG_ID.test(v.resourceId)
    && /^[A-Za-z0-9_-]{1,128}$/.test(v.server) && validExecutionOrigin(v.generation)
    && Number.isInteger(v.port) && v.port >= NATIVE_OAUTH_PORT_MIN && v.port <= NATIVE_OAUTH_PORT_MAX
    && Number.isSafeInteger(v.createdAt) && v.createdAt > 0 && v.expiresAt === v.createdAt + TTL
    && ["preparing", "pending", "consuming", "completed", "failed", "uncertain", "revoked"].includes(v.phase)
    && (v.nativePath === null || typeof v.nativePath === "string" && (v.nativePath === NATIVE_OAUTH_CALLBACK_PATH || v.nativePath.startsWith(NATIVE_OAUTH_CALLBACK_PATH + "/") && /^[A-Za-z0-9/_-]{1,256}$/.test(v.nativePath.slice(NATIVE_OAUTH_CALLBACK_PATH.length))))
    && (v.stateHash === null || HASH.test(v.stateHash))
    && (v.loginId === null || /^[A-Za-z0-9._:-]{1,256}$/.test(v.loginId));
}
const schema = defineVersionedSchema<State>({
  name: "NativeOAuthCallbackState", schemaVersion: 1, keys: ["installationId", "attempts"],
  parse(value, context) {
    if (typeof value.installationId !== "string" || !/^[a-z][a-z0-9-]{1,62}$/.test(value.installationId)
      || !Array.isArray(value.attempts) || value.attempts.length > MAX_ATTEMPTS || !value.attempts.every(validAttempt)
      || new Set(value.attempts.map(row => row.id)).size !== value.attempts.length
      || new Set(value.attempts.map(row => row.port)).size !== value.attempts.length) context.fail("invalid native OAuth callback state");
    return { schemaVersion: 1, installationId: value.installationId as string, attempts: value.attempts as NativeOAuthAttempt[] };
  },
});

/** Brief availability probe, never port zero. Native Codex owns the listener.
 * A collision after this probe fails the login; no automatic OAuth retry occurs. */
export async function nativeOAuthPortAvailable(port: number) {
  return new Promise<boolean>(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** A small private receipt/port lease store, not an OAuth token store. It keeps
 * only a state digest and consumes before forwarding; crashes cannot replay codes. */
export class NativeOAuthCallbackStore {
  private readonly root: string;
  private readonly file: string;
  private readonly locks: ResourceLockManager;
  private readonly origin: string;
  private readonly publicCallbackAllowed: boolean;
  constructor(readonly installationId: string, dataRoot: string, publicUrl: string,
    private readonly now: () => number = Date.now,
    private readonly portAvailable: (port: number) => Promise<boolean> = nativeOAuthPortAvailable) {
    const url = new URL(publicUrl);
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(installationId) || !path.isAbsolute(dataRoot) || !["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.hash || url.search) throw error("NATIVE_OAUTH_PUBLIC_ORIGIN_INVALID", 503);
    this.origin = url.origin;
    this.publicCallbackAllowed = url.protocol === "https:" && !["localhost", "[::1]", "[::]", "0.0.0.0"].includes(url.hostname)
      && !url.hostname.endsWith(".localhost") && !/^127\./.test(url.hostname);
    this.root = path.join(path.resolve(dataRoot), "native-oauth-callbacks");
    this.file = path.join(this.root, "state.json");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks") });
  }
  private async transaction<T>(action: (state: State) => Promise<T> | T) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || await realpath(this.root) !== this.root
      || process.getuid && info.uid !== process.getuid()) throw error("NATIVE_OAUTH_STORE_UNSAFE", 503);
    return this.locks.withLock("callback-state", async () => {
      let state: State;
      try {
        const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const meta = await handle.stat(); if (!meta.isFile() || meta.nlink !== 1 || meta.mode & 0o077 || process.getuid && meta.uid !== process.getuid() || meta.size > 512_000) throw error("NATIVE_OAUTH_STORE_UNSAFE", 503); }
        finally { await handle.close(); }
        state = (await recoverAtomicJsonFile(this.file, schema)).value;
      } catch (cause) {
        if (!cause || typeof cause !== "object" || !("code" in cause) || cause.code !== "ENOENT") throw cause;
        state = { schemaVersion: 1, installationId: this.installationId, attempts: [] };
      }
      if (state.installationId !== this.installationId) throw error("NATIVE_OAUTH_SCOPE_DENIED", 403);
      const result = await action(state);
      await atomicWriteJson(this.file, state, schema, { mode: 0o600 });
      return result;
    });
  }
  async begin(owner: NativeOAuthOwner) {
    if (!this.publicCallbackAllowed) throw error("NATIVE_OAUTH_PUBLIC_ORIGIN_INVALID", 503);
    if (!CATALOG_UUID.test(owner.userId) || !CATALOG_ID.test(owner.resourceId) || !/^[A-Za-z0-9_-]{1,128}$/.test(owner.server)
      || !validExecutionOrigin(owner.generation)) throw error("NATIVE_OAUTH_SCOPE_DENIED", 403);
    return this.transaction(async state => {
      const now = this.now();
      state.attempts = state.attempts.filter(row => row.expiresAt + GRACE > now);
      if (state.attempts.some(row => row.userId === owner.userId && row.expiresAt > now && ["preparing", "pending", "consuming", "uncertain"].includes(row.phase))) throw error("NATIVE_OAUTH_ALREADY_PENDING");
      if (state.attempts.length >= MAX_ATTEMPTS) throw error("NATIVE_OAUTH_CAPACITY_REACHED", 503);
      const held = new Set(state.attempts.map(row => row.port));
      let port: number | null = null;
      for (let value = NATIVE_OAUTH_PORT_MIN; value <= NATIVE_OAUTH_PORT_MAX; value++) {
        if (!held.has(value) && await this.portAvailable(value)) { port = value; break; }
      }
      if (port === null) throw error("NATIVE_OAUTH_NO_PRIVATE_PORT", 503);
      const row: NativeOAuthAttempt = { ...structuredClone(owner), id: randomBytes(32).toString("hex"), port,
        createdAt: now, expiresAt: now + TTL, phase: "preparing", nativePath: null, stateHash: null, loginId: null };
      state.attempts.push(row);
      return { attempt: structuredClone(row), callbackUrl: this.origin + NATIVE_OAUTH_CALLBACK_PATH };
    });
  }
  async bind(id: string, authorizationUrl: string, loginId: string | null, staticClientConfigured = false) {
    return this.transaction(state => {
      const row = state.attempts.find(row => row.id === id);
      if (!row || row.phase !== "preparing" || row.expiresAt <= this.now()) throw error("NATIVE_OAUTH_ATTEMPT_EXPIRED", 410);
      const auth = new URL(authorizationUrl), redirects = auth.searchParams.getAll("redirect_uri"), values = auth.searchParams.getAll("state");
      if (redirects.length !== 1 || values.length !== 1 || !values[0] || values[0].length > 4096 || !loginId) throw error("NATIVE_OAUTH_CALLBACK_STATE_UNSUPPORTED");
      const redirect = new URL(redirects[0]);
      if (redirect.origin !== this.origin || redirect.search || redirect.hash || redirect.username || redirect.password
        || !(redirect.pathname === NATIVE_OAUTH_CALLBACK_PATH || redirect.pathname.startsWith(NATIVE_OAUTH_CALLBACK_PATH + "/") && /^[A-Za-z0-9/_-]{1,256}$/.test(redirect.pathname.slice(NATIVE_OAUTH_CALLBACK_PATH.length)))) throw error("NATIVE_OAUTH_CALLBACK_MISMATCH");
      // Static Google-style registrations require one exact redirect URI.
      // The pinned SDK adds a random suffix for that mode; do not expose a
      // known-incompatible link. Other unverified path variants also fail closed.
      if (redirect.pathname !== NATIVE_OAUTH_CALLBACK_PATH) throw error(staticClientConfigured
        ? "NATIVE_OAUTH_STATIC_CALLBACK_UNSUPPORTED" : "NATIVE_OAUTH_CALLBACK_VARIANT_UNSUPPORTED");
      const stateHash = hash(values[0]);
      if (state.attempts.some(other => other.id !== id && other.stateHash === stateHash && other.expiresAt > this.now())) throw error("NATIVE_OAUTH_STATE_AMBIGUOUS");
      row.stateHash = stateHash; row.nativePath = redirect.pathname; row.loginId = loginId; row.phase = "pending";
      return structuredClone(row);
    });
  }
  async assertPreparing(callbackUrl: string, owner: NativeOAuthOwner, port: number) {
    return this.transaction(state => {
      const row = state.attempts.find(row => row.userId === owner.userId && row.resourceId === owner.resourceId && row.server === owner.server && row.port === port);
      if (!row || row.phase !== "preparing" || row.expiresAt <= this.now() || row.userId !== owner.userId
        || row.resourceId !== owner.resourceId || row.server !== owner.server || row.port !== port
        || !sameNativeOAuthGeneration(row.generation, owner.generation) || callbackUrl !== this.origin + NATIVE_OAUTH_CALLBACK_PATH) throw error("NATIVE_OAUTH_LEASE_DENIED", 403);
    });
  }
  async consume(userId: string, requestUrl: string,
    validateOwner: (attempt: NativeOAuthAttempt) => Promise<WorkerExecutionOrigin>) {
    const incoming = new URL(requestUrl), incomingStates = incoming.searchParams.getAll("state");
    if (incomingStates.length !== 1 || !incomingStates[0] || incomingStates[0].length > 4096 || requestUrl.length > 16_384) throw error("NATIVE_OAUTH_STATE_DENIED", 403);
    const incomingHash = hash(incomingStates[0]);
    return this.transaction(async state => {
      const row = state.attempts.find(row => row.stateHash === incomingHash);
      if (!row) throw error("NATIVE_OAUTH_ATTEMPT_UNKNOWN", 404);
      if (row.userId !== userId) throw error("NATIVE_OAUTH_SCOPE_DENIED", 403);
      if (row.expiresAt <= this.now() || row.phase !== "pending") throw error("NATIVE_OAUTH_ATTEMPT_EXPIRED", 410);
      const url = new URL(requestUrl), values = url.searchParams.getAll("state");
      if (url.origin !== this.origin || url.pathname !== row.nativePath || requestUrl.length > 16_384
        || values.length !== 1 || !row.stateHash || !timingSafeEqual(Buffer.from(hash(values[0]), "hex"), Buffer.from(row.stateHash, "hex"))) throw error("NATIVE_OAUTH_STATE_DENIED", 403);
      const generation = await validateOwner(structuredClone(row));
      if (!sameNativeOAuthGeneration(row.generation, generation)) throw error("NATIVE_OAUTH_RUNTIME_CHANGED", 409);
      // Persist before the network request. A timeout/restart never resends it.
      row.phase = "consuming";
      return structuredClone(row);
    });
  }
  async finish(id: string, phase: "completed" | "failed" | "uncertain") {
    return this.transaction(state => { const row = state.attempts.find(row => row.id === id); if (row && !["revoked", "completed"].includes(row.phase)) row.phase = phase; });
  }
  async revoke(userId: string, resourceId: string) {
    return this.transaction(state => { for (const row of state.attempts) if (row.userId === userId && row.resourceId === resourceId) row.phase = "revoked"; });
  }
}

/** Fixed numeric loopback only. Neither URL/port/path nor headers come from a
 * browser destination parameter. Codex validates state/PKCE and exchanges tokens. */
export async function forwardNativeOAuthCallback(attempt: NativeOAuthAttempt, incomingUrl: string) {
  const incoming = new URL(incomingUrl);
  if (!validAttempt(attempt) || attempt.phase !== "consuming" || !attempt.nativePath || incoming.pathname !== attempt.nativePath
    || incomingUrl.length > 16_384) throw error("NATIVE_OAUTH_FORWARD_DENIED", 403);
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: attempt.port, method: "GET",
      path: attempt.nativePath + incoming.search, agent: false, headers: { Connection: "close" } }, response => {
      let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65_536) request.destroy(); });
      response.once("end", () => resolve(response.statusCode ?? 502));
      response.once("error", () => reject(error("NATIVE_OAUTH_CALLBACK_OUTCOME_UNCERTAIN", 503)));
    });
    request.setTimeout(30_000, () => request.destroy());
    request.once("error", () => reject(error("NATIVE_OAUTH_CALLBACK_OUTCOME_UNCERTAIN", 503)));
    request.end();
  });
}
