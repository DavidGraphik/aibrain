import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { SERVER_MODEL_PROVIDER } from "../server-model-auth";
import { PrivateStdioAuthLane } from "./private-stdio-auth";
const KEY = "sk-synthetic-private-123456789";
const config = { cli_auth_credentials_store: "ephemeral", forced_login_method: "api", model_provider: SERVER_MODEL_PROVIDER,
  model_providers: { [SERVER_MODEL_PROVIDER]: { name: "OpenAI", base_url: "https://api.openai.com/v1", wire_api: "responses", requires_openai_auth: true } } };
function fixture(options: { badConfig?: boolean; badAccount?: boolean; loginError?: boolean } = {}) {
  const writes: Array<Record<string, unknown>> = [], fail = vi.fn(), provider = vi.fn(async () => KEY);
  let lane!: PrivateStdioAuthLane;
  lane = new PrivateStdioAuthLane(undefined, async rpc => {
    const r = rpc as Record<string, unknown>;writes.push(r);if (!r.id) return;
    let result: unknown = {};
    if (r.method === "config/read") result = { config: options.badConfig ? { ...config, forced_login_method: "chatgpt" } : config };
    if (r.method === "account/login/start") result = { type: "apiKey", echo: KEY };
    if (r.method === "account/read") result = { account: { type: options.badAccount ? "chatgpt" : "apiKey" }, echo: KEY };
    queueMicrotask(() => lane.consume(JSON.stringify({ id: r.id, ...(options.loginError && r.method === "account/login/start" ? { error: { message: KEY } } : { result }) })));
  }, fail, provider);
  return { lane, writes, fail, provider };
}
it("performs only private API bootstrap, validates config before reading a key, and consumes secret-bearing auth replies", async () => {
  const f = fixture();await f.lane.bootstrap();
  expect(f.writes.map(r => r.method)).toEqual(["initialize", "initialized", "config/read", "account/login/start", "account/read"]);
  expect(f.writes[3].params).toEqual({ type: "apiKey", apiKey: KEY });expect(f.provider).toHaveBeenCalledOnce();
  expect(f.lane.consume(JSON.stringify({ method: "account/login/completed", params: { success: true, echo: KEY } }))).toBe(true);
  expect(f.lane.consume(JSON.stringify({ method: "account/updated", params: { authMode: "apikey", echo: KEY } }))).toBe(true);
  expect(f.lane.consume(JSON.stringify({ method: "some/event", params: { echo: KEY } }))).toBe(true);expect(f.fail).toHaveBeenCalled();f.lane.close();
});
it("drops a key echoed with JSON Unicode escapes before a public event can exist", async () => {
  const f = fixture();await f.lane.bootstrap();
  const escaped = [...KEY].map(char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  expect(f.lane.consume('{"method":"some/event","params":{"echo":"' + escaped + '"}}')).toBe(true);
  expect(f.fail).toHaveBeenCalledOnce();f.lane.close();
});
it("never loads a key with a legacy/redirected config", async () => {
  const f = fixture({ badConfig: true });await expect(f.lane.bootstrap()).rejects.toThrow("Server model authentication is unavailable.");
  expect(f.provider).not.toHaveBeenCalled();f.lane.close();
});
it.each([{ badAccount: true }, { loginError: true }])("fails closed with a generic error when API authentication is rejected or replaced", async options => {
  const f = fixture(options);await expect(f.lane.bootstrap()).rejects.toThrow(/^Server model authentication is unavailable\.$/);f.lane.close();
});
it("cannot refresh ChatGPT or mix it with server model authentication", async () => {
  const f = fixture();await f.lane.bootstrap();
  expect(f.lane.consume(JSON.stringify({ id: "refresh", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized" } }))).toBe(true);
  expect(f.fail).toHaveBeenCalledOnce();expect(f.provider).toHaveBeenCalledOnce();f.lane.close();
  expect(() => new PrivateStdioAuthLane(async () => ({ accessToken: "old", chatgptAccountId: "old", chatgptPlanType: null }), async () => {}, () => {}, async () => KEY)).toThrow(/cannot be mixed/);
});
