import { decryptToken, encryptToken } from "./token-crypto.mjs";

const DELEGATED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.ReadWrite.Shared",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/Mail.Send.Shared",
  "https://graph.microsoft.com/MailboxFolder.ReadWrite",
  "https://graph.microsoft.com/MailboxSettings.ReadWrite",
].join(" ");

export function createGraphClient(config, store, options = {}) {
  if (config.authMode === "delegated") {
    return new DelegatedGraphClient({
      ...config,
      store,
      fetchImpl: options.fetchImpl,
    });
  }
  return new ApplicationGraphClient({
    ...config,
    fetchImpl: options.fetchImpl,
  });
}

export class ApplicationGraphClient {
  constructor({
    tenantId,
    clientId,
    clientSecret,
    mailActionMode = "review_only",
    fetchImpl = fetch,
  }) {
    this.tenantId = tenantId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.mailActionMode = mailActionMode;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.authMode = "application";
  }

  isConnected() {
    return true;
  }

  resource(mailbox, folder) {
    return `${this.mailboxRoot(mailbox)}/mailFolders('${folder}')/messages`;
  }

  mailboxRoot(mailbox) {
    return `/users/${encodeURIComponent(mailbox)}`;
  }

  async request(_mailbox, path, options = {}) {
    assertGraphActionAllowed(path, options, this.mailActionMode);
    const token = await this.accessToken();
    return graphRequest(this.fetch, token, path, options);
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const payload = await tokenRequest(this.fetch, this.tenantId, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Number(payload.expires_in ?? 3600) * 1000;
    return this.token;
  }
}

export class DelegatedGraphClient {
  constructor({
    tenantId,
    clientId,
    clientSecret,
    tokenEncryptionKey,
    mailActionMode = "review_only",
    store,
    fetchImpl = fetch,
  }) {
    this.tenantId = tenantId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenEncryptionKey = tokenEncryptionKey;
    this.store = store;
    this.fetch = fetchImpl;
    this.mailActionMode = mailActionMode;
    this.tokens = new Map();
    this.authMode = "delegated";
  }

  isConnected(mailbox) {
    return Boolean(this.store.oauthAccount(mailbox));
  }

  resource(_mailbox, folder) {
    return `${this.mailboxRoot(_mailbox)}/mailFolders('${folder}')/messages`;
  }

  mailboxRoot(mailbox) {
    const account = this.store.oauthAccount(mailbox);
    if (!account) throw new Error(`Outlook mailbox is not connected: ${mailbox}`);
    return account.principal.toLowerCase() === mailbox.toLowerCase()
      ? "/me"
      : `/users/${encodeURIComponent(mailbox)}`;
  }

  async request(mailbox, path, options = {}) {
    if (!mailbox) throw new Error("A mailbox is required for delegated Graph access");
    assertGraphActionAllowed(path, options, this.mailActionMode);
    const token = await this.accessToken(mailbox);
    return graphRequest(this.fetch, token, path, options);
  }

  async accessToken(mailbox) {
    const cached = this.tokens.get(mailbox);
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

    const account = this.store.oauthAccount(mailbox);
    if (!account) throw new Error(`Outlook mailbox is not connected: ${mailbox}`);
    const refreshToken = decryptToken(
      account.refresh_token_encrypted,
      this.tokenEncryptionKey,
    );
    const payload = await tokenRequest(
      this.fetch,
      account.tenant_id || this.tenantId,
      {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: DELEGATED_SCOPES,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      },
    );
    if (payload.refresh_token) {
      this.store.updateOAuthRefreshToken(
        mailbox,
        encryptToken(payload.refresh_token, this.tokenEncryptionKey),
        payload.scope,
      );
    }
    this.tokens.set(mailbox, {
      token: payload.access_token,
      expiresAt: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
    });
    return payload.access_token;
  }
}

export { DELEGATED_SCOPES };

export function assertGraphActionAllowed(
  path,
  { method = "GET", approval } = {},
  mode = "review_only",
) {
  const normalizedMethod = String(method).toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return;

  const pathname = graphPathname(path).toLowerCase();
  if (pathname === "/subscriptions" || pathname.startsWith("/subscriptions/")) {
    return;
  }

  if (mode === "review_only") {
    const error = new Error(
      `Outlook mailbox mutation blocked in review_only: ${normalizedMethod} ${pathname}`,
    );
    error.code = "OUTLOOK_MAIL_ACTION_BLOCKED";
    throw error;
  }

  if (mode === "approval_required") {
    const valid =
      approval?.confirmed === true &&
      typeof approval.id === "string" &&
      approval.id.trim().length >= 8 &&
      typeof approval.approvedBy === "string" &&
      approval.approvedBy.trim().length >= 2;
    if (!valid) {
      const error = new Error(
        "Outlook mailbox mutation requires a confirmed per-action approval",
      );
      error.code = "OUTLOOK_MAIL_APPROVAL_REQUIRED";
      throw error;
    }
  }
}

async function graphRequest(fetchImpl, token, path, {
  method = "GET",
  body,
  headers = {},
} = {}) {
  const url = path.startsWith("https://graph.microsoft.com/")
    ? path
    : `https://graph.microsoft.com/v1.0/${path.replace(/^\//, "")}`;
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 2000) };
    }
  }
  if (!response.ok) {
    const error = new Error(`Microsoft Graph ${method} ${url} failed with ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function graphPathname(path) {
  if (String(path).startsWith("https://graph.microsoft.com/")) {
    const url = new URL(path);
    return url.pathname.replace(/^\/(?:v1\.0|beta)/, "") || "/";
  }
  return `/${String(path).replace(/^\//, "").split("?")[0]}`;
}

async function tokenRequest(fetchImpl, tenantId, fields) {
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    const error = new Error(`Microsoft identity token request failed with ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}
