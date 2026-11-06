import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { lstat, open, realpath } from "node:fs/promises";
import { assertServerModelConfiguration, assertServerModelRpc, configuredModelAuth, SERVER_MODEL_KEY_PATH,
  SERVER_MODEL_PROVIDER, serverModelApiKeyProvider } from "./server-model-auth";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), open: vi.fn(), realpath: vi.fn() }));
const KEY = "sk-synthetic-NEVER-PUBLIC-123456789";
const metadata = () => ({ isFile: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n, uid: 0n,
  gid: BigInt(process.getegid?.() ?? 0), mode: 0o100640n, nlink: 1n, size: 0n, mtimeNs: 1n, ctimeNs: 1n });
function secret(value: unknown = { schemaVersion: 1, installationId: "company-alpha", apiKey: KEY }) {
  const bytes = Buffer.from(JSON.stringify(value)); const info = { ...metadata(), size: BigInt(bytes.length) };
  const handle = { stat: vi.fn().mockResolvedValue(info), close: vi.fn().mockResolvedValue(undefined),
    read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
      const count = Math.min(7, length, bytes.length - position); if (count > 0) bytes.copy(target, offset, position, position + count);
      return { bytesRead: count, buffer: target };
    }) };
  vi.mocked(realpath).mockResolvedValue(SERVER_MODEL_KEY_PATH);vi.mocked(lstat).mockResolvedValue(info as never);
  vi.mocked(open).mockResolvedValue(handle as never);return { handle, info };
}
beforeEach(() => { vi.resetAllMocks(); });

it("requires API auth in production and rejects personal, broker, shared, gateway and env-key fallbacks", () => {
  expect(configuredModelAuth({ NODE_ENV: "production" })).toBe("server-api-key");
  expect(configuredModelAuth({ NODE_ENV: "test" })).toBe("personal-codex");
  expect(configuredModelAuth({ NODE_ENV: "development", AIBRAIN_MODEL_AUTH: "personal-codex" })).toBe("personal-codex");
  for (const extra of [{ AIBRAIN_MODEL_AUTH: "personal-codex" }, { AIBRAIN_MODEL_AUTH: "unknown" }, { AIBRAIN_CODEX_TRANSPORT: "gateway" },
    { AIBRAIN_CODEX_AUTH_SCOPE: "shared-qa" }, { AIBRAIN_SHARED_CODEX_AUTH_SOURCE: "/private/auth.json" },
    { AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT: "/run/access" }, { AIBRAIN_CODEX_OWNER_AUTH_SOCKET: "/run/owner" }, { OPENAI_API_KEY: KEY }])
    expect(() => configuredModelAuth({ NODE_ENV: "production", ...extra })).toThrow("Server model authentication is unavailable.");
});
it("lazily reads only the fixed root-owned, backend-readable installation key and closes the file", async () => {
  const { handle } = secret();const provider = serverModelApiKeyProvider("company-alpha");expect(open).not.toHaveBeenCalled();
  await expect(provider()).resolves.toBe(KEY);expect(open).toHaveBeenCalledWith(SERVER_MODEL_KEY_PATH, expect.any(Number));
  expect(handle.close).toHaveBeenCalledOnce();expect(handle.read.mock.calls.length).toBeGreaterThan(1);
});
it.each(["uid", "gid", "mode", "nlink", "size", "symlink", "changed", "replaced", "read-error"])("rejects unsafe or changing secret (%s) without exposing it", async kind => {
  const { handle, info } = secret();
  if (kind === "uid") info.uid = 10001n;
  if (kind === "gid") info.gid += 1n;
  if (kind === "mode") info.mode = 0o100644n;
  if (kind === "nlink") info.nlink = 2n;
  if (kind === "size") info.size = 16_385n;
  if (kind === "symlink") vi.mocked(realpath).mockResolvedValue("/other/file");
  if (kind === "changed") handle.stat.mockResolvedValueOnce(info).mockResolvedValueOnce({ ...info, ctimeNs: 2n });
  if (kind === "replaced") vi.mocked(lstat).mockResolvedValueOnce(info as never).mockResolvedValueOnce({ ...info, ino: 3n } as never);
  if (kind === "read-error") handle.read.mockRejectedValueOnce(Error(KEY));
  await expect(serverModelApiKeyProvider("company-alpha")()).rejects.toThrow(/^Server model authentication is unavailable\.$/);
});
it.each([{ schemaVersion: 1, installationId: "other", apiKey: KEY }, { schemaVersion: 2, installationId: "company-alpha", apiKey: KEY },
  { schemaVersion: 1, installationId: "company-alpha", apiKey: KEY, extra: true }, { schemaVersion: 1, installationId: "company-alpha", apiKey: "bad\nkey" }])("rejects a mismatched or malformed document", async value => {
  secret(value);await expect(serverModelApiKeyProvider("company-alpha")()).rejects.toThrow("Server model authentication is unavailable.");
});
it("verifies effective API/ephemeral/OpenAI policy before allowing a key to load", () => {
  const config = { cli_auth_credentials_store: "ephemeral", forced_login_method: "api", model_provider: SERVER_MODEL_PROVIDER,
    model_providers: { [SERVER_MODEL_PROVIDER]: { name: "OpenAI", base_url: "https://api.openai.com/v1", wire_api: "responses", requires_openai_auth: true } } };
  expect(() => assertServerModelConfiguration({ config })).not.toThrow();
  const defaults = { auth: null, aws: null, capabilities: null, env_http_headers: null, env_key: null, env_key_instructions: null,
    experimental_bearer_token: null, gateway_oauth: null, http_headers: null, model_catalog_url: null, query_params: null,
    request_max_retries: null, stream_idle_timeout_ms: null, stream_max_retries: null, supports_standalone_web_search: false,
    supports_websockets: false, websocket_connect_timeout_ms: null };
  expect(() => assertServerModelConfiguration({ config: { ...config, model_providers: { [SERVER_MODEL_PROVIDER]: { ...config.model_providers[SERVER_MODEL_PROVIDER], ...defaults } } } })).not.toThrow();
  for (const unsafe of [{ auth: { command: "/other" } }, { experimental_bearer_token: KEY }, { http_headers: { Authorization: KEY } },
    { env_http_headers: { Authorization: "PRIVATE_ENV" } }, { gateway_oauth: {} }, { model_catalog_url: "https://other.invalid" }, { unknown: true }])
    expect(() => assertServerModelConfiguration({ config: { ...config, model_providers: { [SERVER_MODEL_PROVIDER]: { ...config.model_providers[SERVER_MODEL_PROVIDER], ...defaults, ...unsafe } } } })).toThrow();
  for (const patch of [{ cli_auth_credentials_store: "file" }, { forced_login_method: "chatgpt" }, { model_provider: "other" },
    { model_providers: { [SERVER_MODEL_PROVIDER]: { ...config.model_providers[SERVER_MODEL_PROVIDER], base_url: "https://other.invalid" } } },
    { model_providers: { [SERVER_MODEL_PROVIDER]: { ...config.model_providers[SERVER_MODEL_PROVIDER], auth: { command: "other" } } } }])
    expect(() => assertServerModelConfiguration({ config: { ...config, ...patch } })).toThrow();
});
it("blocks model authentication/provider/app swaps while preserving independent MCP operations", () => {
  for (const [method, params] of [["app/installed", {}], ["account/login/start", { type: "chatgpt" }], ["account/logout", {}],
    ["account/gatewayOAuth/login", undefined], ["account/gatewayOAuth/cancel", undefined], ["account/bedrock/setup", { type: "environment", region: "us-east-1" }],
    ["account/sendAddCreditsNudgeEmail", { creditType: "credits" }], ["account/rateLimitResetCredit/consume", { idempotencyKey: "synthetic" }],
    ["account/workspaceMessages/read", undefined], ["account/futureMutation", {}],
    ["config/value/write", { keyPath: "model_provider", value: "other", mergeStrategy: "upsert" }], ["config/batchWrite", {}],
    ["thread/start", { modelProvider: "other" }], ["thread/resume", { config: { "model_providers.other.base_url": "https://other.invalid" } }]] as const)
    expect(() => assertServerModelRpc(method, params)).toThrow();
  for (const [method, params] of [["mcpServer/oauth/login", { name: "own-mcp" }], ["config/mcpServer/reload", {}],
    ["config/value/write", { keyPath: "mcp_servers.own.enabled", value: true, mergeStrategy: "upsert" }], ["account/read", { refreshToken: false }],
    ["account/rateLimits/read", undefined], ["account/usage/read", undefined],
    ["thread/start", { modelProvider: SERVER_MODEL_PROVIDER, config: { web_search: "live" } }]] as const)
    expect(() => assertServerModelRpc(method, params)).not.toThrow();
});
it("allows only the three exact MCP scalar settings; callback leases remain an inner-transport requirement", () => {
  const write = (keyPath: string, value: unknown, extra = {}) => () => assertServerModelRpc("config/value/write", { keyPath, value, mergeStrategy: "upsert", ...extra });
  const server = "Own_Server-1", prefix = `mcp_servers.${server}.`;
  expect(write(prefix + "enabled", true)).not.toThrow();expect(write(prefix + "enabled", false)).not.toThrow();
  expect(write(prefix + "oauth.callback_url", "https://brain.example.test/api/connectors/native/callback")).not.toThrow();
  for (const port of [43100, 43200, 43355]) expect(write(prefix + "oauth.callback_port", port)).not.toThrow();
  for (const value of [43099, 43356, 43100.5, "43100", NaN, Infinity, null, true]) expect(write(prefix + "oauth.callback_port", value)).toThrow();
  for (const value of ["http://brain.example.test/callback", "//brain.example.test/callback", "file:///tmp/callback", "https://user:password@brain.example.test/callback",
    "https://brain.example.test/callback#fragment", "https://brain.example.test/\ncallback", "", " " + "https://brain.example.test", {}, 43100, true]) expect(write(prefix + "oauth.callback_url", value)).toThrow();
  for (const key of ["mcp_oauth_callback_url", "mcp_oauth_callback_port", "mcp_servers.own.oauth", "mcp_servers.own.oauth.client_id", "mcp_servers.own.oauth.scopes",
    "mcp_servers.own.http_headers", "mcp_servers.own.auth", "model_providers.openai.base_url", "forced_login_method", "cli_auth_credentials_store",
    "mcp_servers..oauth.callback_port", "mcp_servers.bad/server.oauth.callback_port", `mcp_servers.${"a".repeat(129)}.oauth.callback_port`]) expect(write(key, 43100)).toThrow();
  for (const extra of [{ filePath: "/other/config.toml" }, { expectedVersion: "other" }, { mergeStrategy: "replace" }, { headers: {} }])
    expect(write(prefix + "oauth.callback_port", 43100, extra)).toThrow();
});
