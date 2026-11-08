import { randomUUID } from "node:crypto";
import type { SharedAuthProvider, SharedAuthTokens } from "./shared-auth-broker";
import { assertServerModelConfiguration, type ServerModelApiKeyProvider } from "../server-model-auth";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Shared by both transports. Secret-bearing RPCs never become public events. */
export class PrivateStdioAuthLane {
  private tokens: SharedAuthTokens | null = null;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private closed = false;
  private apiAuthenticated = false;
  private apiKey: string | null = null;
  private refreshes = 0;
  get busy() { return this.pending.size > 0 || this.refreshes > 0; }
  constructor(private readonly provider: SharedAuthProvider | undefined,
    private readonly write: (rpc: unknown) => Promise<void>, private readonly invalidRefresh: () => void,
    private readonly apiKeyProvider?: ServerModelApiKeyProvider) {
    if (provider && apiKeyProvider) throw new Error("Model authentication modes cannot be mixed.");
  }

  async bootstrap() {
    if (!this.provider && !this.apiKeyProvider) return;
    await this.request("initialize", { clientInfo: { name: "aibrain_workbench", version: "0.4.0" }, capabilities: { experimentalApi: true } });
    await this.write({ method: "initialized" });
    if (this.apiKeyProvider) {
      try {
        assertServerModelConfiguration(await this.request("config/read", { includeLayers: false }));
        const apiKey = await this.apiKeyProvider();
        this.apiKey = apiKey;
        if (this.closed) throw new Error();
        const login = await this.request("account/login/start", { type: "apiKey", apiKey });
        if (!record(login) || login.type !== "apiKey") throw new Error();
        const account = await this.request("account/read", { refreshToken: false });
        if (!record(account) || !record(account.account) || account.account.type !== "apiKey") throw new Error();
        this.apiAuthenticated = true;
        return;
      } catch { this.apiKey = null; throw new Error("Server model authentication is unavailable."); }
    }
    const tokens = await this.provider!();
    if (this.closed) throw new Error("Private authentication channel closed.");
    this.tokens = tokens;
    const login = await this.request("account/login/start", { type: "chatgptAuthTokens", ...this.tokens });
    if (!record(login) || login.type !== "chatgptAuthTokens") throw new Error("External authentication was not accepted.");
  }
  private request(method: string, params: unknown) {
    const id = `private-auth:${randomUUID()}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Private authentication request timed out.")); }, 8000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      void this.write({ id, method, params }).catch(error => { const pending = this.pending.get(id); this.pending.delete(id); pending?.reject(error); });
    });
  }
  consume(line: string) {
    if (!this.provider && !this.apiKeyProvider) return false;
    let rpc: unknown;
    try { rpc = JSON.parse(line); } catch { return false; }
    if (!record(rpc)) return false;
    if (typeof rpc.id === "string" && rpc.id.startsWith("private-auth:")) {
      const pending = this.pending.get(rpc.id); this.pending.delete(rpc.id);
      if (rpc.error) pending?.reject(new Error("Private authentication was rejected.")); else pending?.resolve(rpc.result);
      return true;
    }
    if (this.apiKeyProvider && typeof rpc.method === "string" && rpc.method.startsWith("account/")) {
      if (rpc.method === "account/chatgptAuthTokens/refresh" || this.apiAuthenticated && rpc.method === "account/updated"
        && (!record(rpc.params) || rpc.params.authMode !== "apikey")) this.invalidRefresh();
      return true;
    }
    if (this.apiKey && JSON.stringify(rpc).includes(JSON.stringify(this.apiKey).slice(1, -1))) {
      this.invalidRefresh(); return true;
    }
    if (rpc.method !== "account/chatgptAuthTokens/refresh") return false;
    const id = rpc.id, params = rpc.params;
    if ((typeof id !== "string" && typeof id !== "number") || !record(params) || params.reason !== "unauthorized" ||
        (params.previousAccountId != null && typeof params.previousAccountId !== "string")) { this.invalidRefresh(); return true; }
    this.refreshes++;
    void this.provider!(params.previousAccountId as string | null | undefined, this.tokens?.accessToken).then(async tokens => {
      if (this.closed) return;
      this.tokens = tokens; await this.write({ id, result: tokens });
    }).catch(async () => {
      if (!this.closed) await this.write({ id, error: { code: -32603, message: "La sesión requiere reconexión del administrador." } }).catch(() => undefined);
    }).finally(() => { this.refreshes--; });
    return true;
  }
  close() {
    this.closed = true; this.tokens = null; this.apiKey = null;
    for (const pending of this.pending.values()) pending.reject(new Error("Private authentication channel closed."));
    this.pending.clear();
  }
}
