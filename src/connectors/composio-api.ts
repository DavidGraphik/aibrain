import { createHash } from "node:crypto";
import type { ComposioToolkitConfig } from "./composio-config";

export class ComposioError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ComposioError"; }
}
export function composioUserId(installationId: string, userId: string) {
  return `aibrain-${createHash("sha256").update(`${installationId}\0${userId}`).digest("hex")}`;
}
export function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export class ComposioApi {
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) {
    if (!key.trim()) throw new ComposioError("COMPOSIO_NOT_CONFIGURED");
  }
  async request(path: string, method = "GET", body?: unknown, missingOkay = false): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`https://backend.composio.dev/api/v3.1${path}`, {
      method, headers: { "x-api-key": this.key, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    if (missingOkay && response.status === 404 || response.status === 204) return {};
    if (!response.ok) throw new ComposioError(response.status === 429 ? "COMPOSIO_RATE_LIMITED" : "COMPOSIO_PROVIDER_UNAVAILABLE");
    const raw = await response.text();
    if (raw.length > 2_000_000) throw new ComposioError("COMPOSIO_RESPONSE_TOO_LARGE");
    if (!raw) return {};
    const data: unknown = JSON.parse(raw);
    if (!object(data)) throw new ComposioError("COMPOSIO_RESPONSE_INVALID");
    return data;
  }
  async verifyConfig(toolkit: ComposioToolkitConfig) {
    const data = await this.request(`/auth_configs/${encodeURIComponent(toolkit.authConfigId)}`);
    if (!object(data.toolkit) || data.toolkit.slug !== toolkit.slug || data.id !== toolkit.authConfigId || data.status !== "ENABLED" || data.auth_scheme !== "OAUTH2") {
      throw new ComposioError("COMPOSIO_AUTH_CONFIG_MISMATCH");
    }
    return data;
  }
  async begin(toolkit: ComposioToolkitConfig, userId: string, callback: string) {
    await this.verifyConfig(toolkit);
    const result = await this.request("/connected_accounts/link", "POST", { auth_config_id: toolkit.authConfigId, user_id: userId, callback_url: callback });
    if (typeof result.redirect_url !== "string") throw new ComposioError("COMPOSIO_LINK_INVALID");
    const url = new URL(result.redirect_url);
    if (url.protocol !== "https:" || url.username || url.password || !(url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"))) throw new ComposioError("COMPOSIO_LINK_INVALID");
    return url.href;
  }
  async account(toolkit: ComposioToolkitConfig, userId: string, accountId: string, requireActive = true, allowMissing = false) {
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(accountId)) throw new ComposioError("COMPOSIO_ACCOUNT_INVALID");
    const data = await this.request(`/connected_accounts?${new URLSearchParams({ connected_account_ids: accountId, user_ids: userId, limit: "10" })}`);
    const account = Array.isArray(data.items) ? data.items.find(a => object(a) && a.id === accountId) : null;
    if (!account && allowMissing) return { active: false };
    if (!object(account) || account.user_id !== userId || !object(account.toolkit) || account.toolkit.slug !== toolkit.slug ||
      (account.auth_config_id ?? (object(account.auth_config) ? account.auth_config.id : null)) !== toolkit.authConfigId) throw new ComposioError("COMPOSIO_ACCOUNT_IDENTITY_MISMATCH");
    if (requireActive && account.status !== "ACTIVE") throw new ComposioError("COMPOSIO_REAUTH_REQUIRED");
    return { active: account.status === "ACTIVE" };
  }
  async tools(toolkit: ComposioToolkitConfig) {
    const tools = [];
    for (const allowed of toolkit.readTools) {
      const data = await this.request(`/tools/${encodeURIComponent(allowed.slug)}?${new URLSearchParams({ version: allowed.version })}`);
      if (data.slug !== allowed.slug || data.version !== allowed.version || !object(data.toolkit) || data.toolkit.slug !== toolkit.slug || !object(data.input_parameters)) throw new ComposioError("COMPOSIO_TOOL_DEFINITION_MISMATCH");
      tools.push({ slug: allowed.slug, description: typeof data.description === "string" ? data.description : allowed.slug, inputSchema: data.input_parameters });
    }
    return tools;
  }
  async execute(toolkit: ComposioToolkitConfig, userId: string, accountId: string, slug: string, args: Record<string, unknown>) {
    const allowed = toolkit.readTools.find(t => t.slug === slug);
    if (!allowed) throw new ComposioError("COMPOSIO_TOOL_DENIED");
    await this.account(toolkit, userId, accountId);
    const result = await this.request(`/tools/execute/${encodeURIComponent(slug)}`, "POST", { connected_account_id: accountId, user_id: userId, version: allowed.version, arguments: args });
    if (result.successful !== true) throw new ComposioError("COMPOSIO_TOOL_FAILED");
    return { data: result.data ?? null, readbackId: typeof result.log_id === "string" ? result.log_id : null };
  }
  async revoke(accountId: string) {
    await this.request(`/connected_accounts/${encodeURIComponent(accountId)}/revoke`, "POST", undefined, true);
    await this.request(`/connected_accounts/${encodeURIComponent(accountId)}`, "DELETE", undefined, true);
  }
}
