import "server-only";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

export const SERVER_MODEL_KEY_PATH = "/etc/aibrain/model-api-key";
export const PERSONAL_MODEL_TEST_PATH = "/etc/aibrain/personal-test.json";
export const SERVER_MODEL_PROVIDER = "aibrain_openai_api";
export type ModelAuthMode = "server-api-key" | "personal-codex" | "personal-test";
export type ServerModelApiKeyProvider = () => Promise<string>;
type Environment = Readonly<Record<string, string | undefined>>;
export class ModelAuthUnavailableError extends Error {
  readonly code = "MODEL_AUTH_UNAVAILABLE";
  constructor() { super("Server model authentication is unavailable."); }
}
const unavailable = () => new ModelAuthUnavailableError();

export function configuredModelAuth(environment: Environment = process.env): ModelAuthMode {
  const mode = environment.AIBRAIN_MODEL_AUTH?.trim() || (environment.NODE_ENV === "production" ? "server-api-key" : "personal-codex");
  if (!["server-api-key", "personal-codex", "personal-test"].includes(mode) || mode === "personal-codex" && environment.NODE_ENV === "production") throw unavailable();
  if ((mode === "server-api-key" || mode === "personal-test") && ((environment.AIBRAIN_CODEX_TRANSPORT?.trim() || "stdio") !== "stdio"
    || (environment.AIBRAIN_CODEX_AUTH_SCOPE?.trim() || "per-user") !== "per-user"
    || ["AIBRAIN_SHARED_CODEX_AUTH_SOURCE", "AIBRAIN_CODEX_OWNER_AUTH_SOCKET", "AIBRAIN_INSTALLATION_OWNER_AUTH_ACK",
      "OPENAI_API_KEY", "CODEX_API_KEY"].some(name => environment[name]?.trim())
    || (mode === "server-api-key" ? Boolean(environment.AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT?.trim())
      : !environment.AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT?.trim()))) throw unavailable();
  return mode as ModelAuthMode;
}

/** This is a short-lived operator-owned personal QA profile, never hosted
 * customer onboarding. Re-read for every admission/dispatch and token snapshot. */
export async function assertPersonalModelTest(identity: { installationId: string; userId: string }) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(identity.installationId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.userId)
      || await realpath(PERSONAL_MODEL_TEST_PATH) !== PERSONAL_MODEL_TEST_PATH) throw unavailable();
    const initial = await lstat(PERSONAL_MODEL_TEST_PATH);
    if (!initial.isFile() || initial.isSymbolicLink()) throw unavailable();
    handle = await open(PERSONAL_MODEL_TEST_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true }), mode = before.mode & 0o7777n;
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || before.size < 2n || before.size > 4096n
      || mode !== 0o644n && (mode !== 0o640n || before.gid !== BigInt(process.getegid?.() ?? -1))) throw unavailable();
    const buffer = Buffer.alloc(4097); let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(PERSONAL_MODEL_TEST_PATH, { bigint: true });
    const same = (s: typeof before) => ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
      .every(key => s[key as keyof typeof s] === before[key as keyof typeof before]);
    if (bytes !== Number(before.size) || !same(after) || !same(current)
      || await realpath(PERSONAL_MODEL_TEST_PATH) !== PERSONAL_MODEL_TEST_PATH) throw unavailable();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
    const now = Date.now();
    if (!record(value) || Object.keys(value).sort().join(",") !== "canonicalUserId,createdAt,expiresAt,installationId,schemaVersion"
      || value.schemaVersion !== 1 || value.installationId !== identity.installationId || value.canonicalUserId !== identity.userId
      || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0 || value.createdAt > now
      || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now
      || value.expiresAt - value.createdAt > 2 * 60 * 60_000) throw unavailable();
  } catch { throw unavailable(); }
  finally { await handle?.close().catch(() => undefined); }
}

/** These values are public policy, never credentials. Pin before initialize. */
export const SERVER_MODEL_CONFIG_OVERRIDES = Object.freeze([
  'cli_auth_credentials_store="ephemeral"', 'forced_login_method="api"',
  `model_provider="${SERVER_MODEL_PROVIDER}"`,
  `model_providers.${SERVER_MODEL_PROVIDER}={name="OpenAI",base_url="https://api.openai.com/v1",wire_api="responses",requires_openai_auth=true}`,
]);
export const PERSONAL_TEST_CONFIG_OVERRIDES = Object.freeze([
  'cli_auth_credentials_store="ephemeral"', 'forced_login_method="chatgpt"', 'model_provider="openai"',
]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Fail before loading the key if legacy configuration can alter its provider. */
export function assertServerModelConfiguration(value: unknown) {
  const config = record(value) && record(value.config) ? value.config : null;
  const providers = config && record(config.model_providers) ? config.model_providers : null;
  const provider = providers && record(providers[SERVER_MODEL_PROVIDER]) ? providers[SERVER_MODEL_PROVIDER] : null;
  if (!config || config.cli_auth_credentials_store !== "ephemeral" || config.forced_login_method !== "api"
    || config.model_provider !== SERVER_MODEL_PROVIDER || !provider
    || provider.base_url !== "https://api.openai.com/v1" || provider.wire_api !== "responses" || provider.requires_openai_auth !== true
    || Object.keys(provider).some(key => {
      if (["name", "base_url", "wire_api", "requires_openai_auth"].includes(key)) return false;
      const entry = provider[key];
      // 0.162.1 serializes optional provider fields, including nulls. No
      // credential helper, alternate auth source, header or catalog URL may
      // survive a legacy config merge before the key is released.
      if (["auth", "aws", "gateway_oauth", "env_key", "env_key_instructions", "experimental_bearer_token", "model_catalog_url"].includes(key)) return entry != null;
      if (["http_headers", "env_http_headers", "query_params"].includes(key)) return entry != null && (!record(entry) || Object.keys(entry).length !== 0);
      if (["supports_standalone_web_search", "supports_websockets"].includes(key)) return entry != null && typeof entry !== "boolean";
      if (["request_max_retries", "stream_max_retries", "stream_idle_timeout_ms", "websocket_connect_timeout_ms"].includes(key))
        return entry != null && (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0 || entry > (key.endsWith("retries") ? 16 : 3_600_000));
      if (key === "capabilities") return entry != null && (!record(entry) || Object.entries(entry).some(([name, setting]) =>
        name === "external_web_access" ? setting != null && typeof setting !== "boolean"
          : name === "remote_compaction" ? setting != null && !["unsupported", "v2"].includes(String(setting)) : true));
      return true;
    })) throw unavailable();
}

/** Ordinary RPCs cannot replace hosted model authentication. MCP has its own
 * per-user credentials and retains its existing catalog authorization. */
export function assertServerModelRpc(method: string, params: unknown) {
  assertManagedModelRpc(method, params, false);
}
export function assertPersonalTestModelRpc(method: string, params: unknown) {
  assertManagedModelRpc(method, params, true);
}
function assertManagedModelRpc(method: string, params: unknown, personalTest: boolean) {
  if (!personalTest && method.startsWith("app/") || method.startsWith("account/")
    && !["account/read", "account/rateLimits/read", "account/usage/read"].includes(method)) throw unavailable();
  if (method.startsWith("config/") && !["config/read", "config/mcpServer/reload"].includes(method)) {
    if (method !== "config/value/write" || !record(params) || typeof params.keyPath !== "string"
      || Object.keys(params).sort().join(",") !== "keyPath,mergeStrategy,value" || params.mergeStrategy !== "upsert") throw unavailable();
    const match = /^mcp_servers\.[A-Za-z0-9_-]{1,128}\.(enabled|oauth\.callback_url|oauth\.callback_port)$/.exec(params.keyPath);
    if (!match) throw unavailable();
    if (match[1] === "enabled") {
      if (typeof params.value !== "boolean") throw unavailable();
    } else if (match[1] === "oauth.callback_port") {
      if (typeof params.value !== "number" || !Number.isInteger(params.value) || params.value < 43100 || params.value > 43355) throw unavailable();
    } else {
      if (typeof params.value !== "string" || params.value.length > 2048 || params.value.trim() !== params.value || /[\u0000-\u001f\u007f]/.test(params.value)) throw unavailable();
      let callback: URL;
      try { callback = new URL(params.value); } catch { throw unavailable(); }
      if (callback.protocol !== "https:" || !callback.hostname || callback.username || callback.password || callback.hash) throw unavailable();
    }
    // Shape only: the resource's inner callback transport must attest its
    // exact persisted user/resource/server/generation lease and URL/port.
  }
  if (!record(params)) return;
  if (params.modelProvider != null && params.modelProvider !== (personalTest ? "openai" : SERVER_MODEL_PROVIDER)) throw unavailable();
  if (record(params.config) && Object.keys(params.config).some(key =>
    /^(?:model_provider|model_providers|cli_auth_credentials_store|forced_login_method|chatgpt_base_url)(?:\.|$)/.test(key))) throw unavailable();
}

/** Backend-only fixed path. The launcher hides /etc/aibrain from workers.
 * Root owns the file; the backend group may only read it. No cache or writes. */
export function serverModelApiKeyProvider(installationId: string): ServerModelApiKeyProvider {
  return async () => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let secretBytes: Buffer | undefined;
    try {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(installationId) || await realpath(SERVER_MODEL_KEY_PATH) !== SERVER_MODEL_KEY_PATH) throw unavailable();
      const gid = process.getegid?.();
      if (gid === undefined) throw unavailable();
      const valid = (s: Awaited<ReturnType<typeof lstat>>) => s.isFile() && !s.isSymbolicLink();
      if (!valid(await lstat(SERVER_MODEL_KEY_PATH))) throw unavailable();
      handle = await open(SERVER_MODEL_KEY_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.uid !== 0n || before.gid !== BigInt(gid) || before.nlink !== 1n
        || (before.mode & 0o7777n) !== 0o640n || before.size < 2n || before.size > 16_384n) throw unavailable();
      const buffer = Buffer.alloc(16_385); secretBytes = buffer; let bytes = 0;
      while (bytes < buffer.length) {
        const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true }), current = await lstat(SERVER_MODEL_KEY_PATH, { bigint: true });
      const same = (s: typeof before) => ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
        .every(key => s[key as keyof typeof s] === before[key as keyof typeof before]);
      if (bytes !== Number(before.size) || !same(after) || !same(current)
        || await realpath(SERVER_MODEL_KEY_PATH) !== SERVER_MODEL_KEY_PATH) throw unavailable();
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
      buffer.fill(0);
      if (!record(value) || Object.keys(value).sort().join(",") !== "apiKey,installationId,schemaVersion"
        || value.schemaVersion !== 1 || value.installationId !== installationId || typeof value.apiKey !== "string"
        || value.apiKey.length < 16 || value.apiKey.length > 8192 || !/^[\x21-\x7e]+$/.test(value.apiKey)) throw unavailable();
      return value.apiKey;
    } catch { throw unavailable(); }
    finally { secretBytes?.fill(0); await handle?.close().catch(() => undefined); }
  };
}
