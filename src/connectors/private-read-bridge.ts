import "server-only";
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { unixBrokerFetch } from "@/runtime/trinalum-broker-transport";

export class PrivateReadBridgeError extends Error { constructor(readonly code: string, readonly status = 503) { super(code); } }
const deny = (): never => { throw new PrivateReadBridgeError("PRIVATE_READ_BINDING_DENIED", 403); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ERROR_STATUSES = new Set([400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504]);
const SAFE_CODE = /^(?:SAGE_|MAIL_|CONNECTOR_|PRIVATE_READ_|PRIVATE_SOURCE_|PRIVATE_ACCESS_)[A-Z0-9_]{1,64}$/;
const statusCode = (status: number) => (({400:"PRIVATE_READ_ARGUMENTS_INVALID",401:"PRIVATE_READ_SOURCE_AUTH_REQUIRED",403:"PRIVATE_READ_BINDING_DENIED",404:"PRIVATE_READ_SOURCE_NOT_FOUND",409:"PRIVATE_READ_CONNECTION_CHANGED",413:"PRIVATE_READ_REQUEST_TOO_LARGE",422:"PRIVATE_READ_ARGUMENTS_INVALID",429:"PRIVATE_READ_RATE_LIMITED"} as Record<number,string>)[status] ?? "PRIVATE_READ_SOURCE_UNAVAILABLE");
type Binding = { userId: string; socketPath: string; token: string };
export type PrivateReadConfig = { schemaVersion: 1; installationId: "g03-production"; enabled: true; readOnly: true; createdAt: number; expiresAt: number; bindings: Binding[] };
/** Only root can opt an isolated private-owner runtime into source-held connector reads. */
export function validatePrivateReadConfig(value: unknown, installationId: string, userId: string, now = Date.now()): PrivateReadConfig {
  if (!record(value) || Object.keys(value).sort().join() !== "bindings,createdAt,enabled,expiresAt,installationId,readOnly,schemaVersion"
    || value.schemaVersion !== 1 || value.installationId !== "g03-production" || value.installationId !== installationId || value.enabled !== true || value.readOnly !== true
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || Number(value.createdAt) > now || Number(value.createdAt) <= 0 || Number(value.expiresAt) <= now || Number(value.expiresAt) - Number(value.createdAt) > 7_200_000
    || !uuid.test(userId) || !Array.isArray(value.bindings) || value.bindings.length < 1 || value.bindings.length > 6) return deny();
  const seen = new Set<string>();
  for (const row of value.bindings) {
    if (!record(row) || Object.keys(row).sort().join() !== "socketPath,token,userId" || typeof row.userId !== "string" || !uuid.test(row.userId) || seen.has(row.userId)
      || row.socketPath !== `/run/aibrain-user-access/private-read/${row.userId}/broker.sock` || typeof row.token !== "string" || !/^[A-Za-z0-9_-]{32,512}$/.test(row.token)) return deny();
    seen.add(row.userId);
  }
  if (!seen.has(userId)) return deny();
  return value as PrivateReadConfig;
}
type Exchange = (socketPath: string, url: URL, init: RequestInit, options: { timeoutMs: number; maximumBytes: number }) => Promise<Response>;
export function createPrivateReadBridge(config: PrivateReadConfig, installationId: string, userId: string, exchange: Exchange = unixBrokerFetch, recheck: () => Promise<void> = async () => {}) {
  validatePrivateReadConfig(config, installationId, userId);
  const binding = config.bindings.find(row => row.userId === userId)!;
  return {
    async request(kind: "capabilities" | "sage" | "mail", body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
      validatePrivateReadConfig(config, installationId, userId); await recheck(); signal?.throwIfAborted();
      if (kind === "capabilities" ? Object.keys(body).length !== 0 : ![...(kind === "sage" ? ["discover", "read", "read_batch"] : ["folders", "list", "search", "read"])].includes(String(body.operation))) return deny();
      const raw = JSON.stringify({ kind, body });
      if (Buffer.byteLength(raw) + 1 > 65_536) throw new PrivateReadBridgeError("PRIVATE_READ_REQUEST_TOO_LARGE", 413);
      const response = await exchange(binding.socketPath, new URL("http://127.0.0.1/read"), { method: "POST", headers: { Authorization: `Bearer ${binding.token}`, "Content-Type": "application/json" }, body: raw, signal }, { timeoutMs: 65_000, maximumBytes: 2 * 1024 * 1024 });
      if (response.status !== 200) {
        if (!ERROR_STATUSES.has(response.status)) throw new PrivateReadBridgeError("PRIVATE_READ_RESPONSE_INVALID", 502);
        let error: unknown; try { error = await response.json(); } catch { /* Only safe typed errors are forwarded. */ }
        const code = record(error) && Object.keys(error).join() === "error" && typeof error.error === "string" && SAFE_CODE.test(error.error) ? error.error : statusCode(response.status);
        throw new PrivateReadBridgeError(code, response.status);
      }
      let value: unknown; try { value = await response.json(); } catch { throw new PrivateReadBridgeError("PRIVATE_READ_RESPONSE_INVALID", 502); }
      if (!record(value) || Object.keys(value).sort().join() !== "body,installationId,kind,schemaVersion,userId" || value.kind !== "private-employee-native-response" || value.schemaVersion !== 1 || value.installationId !== installationId || value.userId !== userId) throw new PrivateReadBridgeError("PRIVATE_READ_RESPONSE_INVALID", 502);
      await recheck(); validatePrivateReadConfig(config, installationId, userId); signal?.throwIfAborted();
      if (record(value.body) && "privateConnectorError" in value.body) {
        const error = value.body.privateConnectorError;
        if (Object.keys(value.body).join() !== "privateConnectorError" || !record(error) || Object.keys(error).sort().join() !== "code,status" || typeof error.code !== "string" || !SAFE_CODE.test(error.code) || typeof error.status !== "number" || !ERROR_STATUSES.has(error.status)) throw new PrivateReadBridgeError("PRIVATE_READ_RESPONSE_INVALID", 502);
        throw new PrivateReadBridgeError(error.code, error.status);
      }
      return value.body;
    },
  };
}
/** Missing opt-in preserves native local/hosted behavior. Invalid opt-in never falls back. */
export async function privateReadBridge(installationId: string, userId: string) {
  const filename = process.env.AIBRAIN_PRIVATE_READ_BRIDGE_CONFIG?.trim();
  if (!filename) return null;
  if (process.env.AIBRAIN_AUTH_MODE !== "private-owner" || !path.isAbsolute(filename) || await realpath(filename) !== filename) return deny();
  async function read() {
    const handle = await open(filename!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || before.mode & 0o022 || before.size > 16_384) return deny();
      const raw = await handle.readFile(); const after = await handle.stat(); const current = await lstat(filename!);
      if (raw.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || await realpath(filename!) !== filename) return deny();
      let value: unknown; try { value = JSON.parse(raw.toString("utf8")); } catch { return deny(); }
      return { config: validatePrivateReadConfig(value, installationId, userId), raw };
    } finally { await handle.close(); }
  }
  const initial = await read(); const binding = initial.config.bindings.find(row => row.userId === userId)!;
  const directory = path.dirname(binding.socketPath); const parent = await lstat(directory); const socket = await lstat(binding.socketPath);
  if (!parent.isDirectory() || parent.uid !== 0 || parent.mode & 0o022 || await realpath(directory) !== directory || !socket.isSocket() || socket.uid !== 0 || socket.gid !== 10001 || (socket.mode & 0o777) !== 0o660 || await realpath(binding.socketPath) !== binding.socketPath) return deny();
  return createPrivateReadBridge(initial.config, installationId, userId, unixBrokerFetch, async () => { if (!(await read()).raw.equals(initial.raw)) return deny(); });
}
export type PrivateMailCapability = { accessVerified: true; operations: string[]; connectionVersion: number };
export function privateMailCapability(value: unknown): PrivateMailCapability {
  if (record(value) && record(value.mail) && value.mail.accessVerified === false) throw new PrivateReadBridgeError("MAIL_ACCESS_DENIED", 403);
  if (!record(value) || !record(value.mail) || value.mail.accessVerified !== true || !Array.isArray(value.mail.operations) || value.mail.operations.length < 1 || value.mail.operations.some(op => !["folders", "list", "search", "read"].includes(String(op))) || new Set(value.mail.operations).size !== value.mail.operations.length || !Number.isSafeInteger(value.mail.connectionVersion) || Number(value.mail.connectionVersion) < 1) throw new PrivateReadBridgeError("PRIVATE_READ_RESPONSE_INVALID", 502);
  return value.mail as PrivateMailCapability;
}
export type PrivateSageCapability = { accessVerified: true; operations: ("discover" | "read" | "read_batch")[]; queries: { name: string; description?: string; parameters: string[] }[] | null };
/** Optional query metadata stays unknown until the SOURCE supplies it; no local query list grants access. */
export function privateSageCapability(value: unknown): PrivateSageCapability {
  if (record(value) && record(value.sage) && value.sage.accessVerified === false) throw new PrivateReadBridgeError("SAGE_ACCESS_DENIED", 403);
  if (!record(value) || !record(value.sage) || value.sage.accessVerified !== true || !Array.isArray(value.sage.operations) || value.sage.operations.length < 1 || value.sage.operations.some(op => !["discover", "read", "read_batch"].includes(String(op))) || new Set(value.sage.operations).size !== value.sage.operations.length) throw new PrivateReadBridgeError("PRIVATE_READ_RESPONSE_INVALID", 502);
  const queries = value.sage.queries;
  if (queries !== undefined && queries !== null && (!Array.isArray(queries) || queries.length > 128 || queries.some(q => !record(q) || typeof q.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(q.name) || !Array.isArray(q.parameters) || q.parameters.some(p => typeof p !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(p)) || q.description !== undefined && (typeof q.description !== "string" || q.description.length > 16_384)) || new Set(queries.map(q => q.name)).size !== queries.length)) throw new PrivateReadBridgeError("PRIVATE_READ_RESPONSE_INVALID", 502);
  return { accessVerified: true, operations: value.sage.operations as PrivateSageCapability["operations"], queries: queries as PrivateSageCapability["queries"] ?? null };
}
