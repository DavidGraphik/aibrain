import { createHash } from "node:crypto";
import {
  OUTLOOK_API_SCOPES,
  OUTLOOK_OAUTH_SCOPES,
  type OutlookProfile,
  type OutlookTokenSet,
} from "@/connectors/outlook-contracts";

export class OutlookApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); this.name = "OutlookApiError"; }
}

type Fetcher = typeof fetch;
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function oauthBody(value: Record<string, string>) { return new URLSearchParams(value).toString(); }
function authority(tenantId: string) { return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`; }

async function json(response: Response) {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new OutlookApiError(response.status === 401 || record(value) && ["invalid_grant", "interaction_required", "consent_required"].includes(String(value.error)) ? "OUTLOOK_REAUTH_REQUIRED" : "OUTLOOK_PROVIDER_ERROR", "Microsoft Graph request failed.", response.status);
  }
  return value;
}

function grantedScopes(value: unknown, fallback: readonly string[]) {
  const result = typeof value === "string" ? value.split(/\s+/u).filter(Boolean) : [...fallback];
  if (!OUTLOOK_API_SCOPES.every((scope) => result.includes(scope)) || result.some((scope) => !OUTLOOK_OAUTH_SCOPES.includes(scope))) {
    throw new OutlookApiError("OUTLOOK_SCOPE_MISMATCH", "Microsoft granted scopes outside the configured minimum.", 403);
  }
  return [...new Set(result)].sort();
}

function tokenSet(value: unknown, refreshToken: string | null, fallbackScopes: readonly string[], now: number): OutlookTokenSet {
  if (!record(value) || typeof value.access_token !== "string" || value.access_token.length < 10 ||
      typeof value.expires_in !== "number" || value.expires_in < 60 ||
      !(typeof value.refresh_token === "string" && value.refresh_token.length >= 10 || refreshToken)) {
    throw new OutlookApiError("OUTLOOK_TOKEN_RESPONSE_INVALID", "Microsoft token response is incomplete.");
  }
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : refreshToken!,
    expiresAt: new Date(now + value.expires_in * 1_000).toISOString(),
    scopes: grantedScopes(value.scope, fallbackScopes),
    tokenType: "Bearer",
  };
}

export function outlookPkceChallenge(codeVerifier: string) { return createHash("sha256").update(codeVerifier).digest("base64url"); }

export function outlookAuthorizationUrl(input: { tenantId: string; clientId: string; redirectUri: string; state: string; codeVerifier: string }) {
  const url = new URL(`${authority(input.tenantId)}/authorize`);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: OUTLOOK_OAUTH_SCOPES.join(" "),
    state: input.state,
    code_challenge: outlookPkceChallenge(input.codeVerifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export async function exchangeOutlookCode(fetcher: Fetcher, input: { tenantId: string; clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }, now = Date.now()) {
  return tokenSet(await json(await fetcher(`${authority(input.tenantId)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: oauthBody({ client_id: input.clientId, client_secret: input.clientSecret, redirect_uri: input.redirectUri, grant_type: "authorization_code", code: input.code, code_verifier: input.codeVerifier, scope: OUTLOOK_OAUTH_SCOPES.join(" ") }),
  })), null, OUTLOOK_OAUTH_SCOPES, now);
}

export async function refreshOutlookToken(fetcher: Fetcher, input: { tenantId: string; clientId: string; clientSecret: string; token: OutlookTokenSet }, now = Date.now()) {
  return tokenSet(await json(await fetcher(`${authority(input.tenantId)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: oauthBody({ client_id: input.clientId, client_secret: input.clientSecret, refresh_token: input.token.refreshToken, grant_type: "refresh_token", scope: OUTLOOK_OAUTH_SCOPES.join(" ") }),
  })), input.token.refreshToken, input.token.scopes, now);
}

async function graphJson(fetcher: Fetcher, accessToken: string, url: string, headers: Record<string, string> = {}) {
  return json(await fetcher(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", ...headers } }));
}

export async function readOutlookProfile(fetcher: Fetcher, accessToken: string, expectedTenantId: string): Promise<OutlookProfile> {
  // Microsoft Graph access tokens are intentionally treated as opaque. Tenant
  // isolation is established by the exact tenant authority used for both the
  // authorization and token endpoints, never by parsing an unverified JWT.
  const tenantId = expectedTenantId.toLowerCase();
  const value = await graphJson(fetcher, accessToken, "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName");
  const emailAddress = record(value) && typeof value.mail === "string" && value.mail.trim() ? value.mail : record(value) && typeof value.userPrincipalName === "string" ? value.userPrincipalName : null;
  if (!record(value) || typeof value.id !== "string" || typeof value.displayName !== "string" || !emailAddress) {
    throw new OutlookApiError("OUTLOOK_PROFILE_INVALID", "Outlook profile readback is invalid.");
  }
  return { id: value.id, displayName: value.displayName, emailAddress, tenantId };
}

function escapedSearch(query: string) { return `\"${query.replace(/\\/gu, "\\\\").replace(/"/gu, '\\\"')}\"`; }
function plainTextBody(content: string, contentType: unknown) {
  const bounded = content.slice(0, 200_000);
  if (contentType !== "html") return bounded.slice(0, 50_000);
  return bounded
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 50_000);
}
function address(value: unknown) {
  if (!record(value) || !record(value.emailAddress) || typeof value.emailAddress.address !== "string") return null;
  return { name: typeof value.emailAddress.name === "string" ? value.emailAddress.name.slice(0, 500) : "", address: value.emailAddress.address.slice(0, 500) };
}

export async function searchOutlookMessages(fetcher: Fetcher, accessToken: string, query: string, maxResults: number) {
  const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
  url.searchParams.set("$search", escapedSearch(query));
  url.searchParams.set("$top", String(Math.min(20, Math.max(1, maxResults))));
  url.searchParams.set("$select", "id,conversationId,receivedDateTime,subject,bodyPreview,from");
  const value = await graphJson(fetcher, accessToken, url.toString(), { ConsistencyLevel: "eventual" });
  if (!record(value) || !Array.isArray(value.value)) throw new OutlookApiError("OUTLOOK_SEARCH_INVALID", "Outlook search response is invalid.");
  return { messages: value.value.flatMap((item) => record(item) && typeof item.id === "string" ? [{ id: item.id, conversationId: typeof item.conversationId === "string" ? item.conversationId : null, receivedDateTime: typeof item.receivedDateTime === "string" ? item.receivedDateTime : null, subject: typeof item.subject === "string" ? item.subject.slice(0, 2_000) : "", bodyPreview: typeof item.bodyPreview === "string" ? item.bodyPreview.slice(0, 4_000) : "", from: address(item.from) }] : []) };
}

export async function readOutlookMessage(fetcher: Fetcher, accessToken: string, messageId: string) {
  if (!/^[A-Za-z0-9._~+/=-]{4,512}$/u.test(messageId)) throw new OutlookApiError("OUTLOOK_MESSAGE_ID_INVALID", "Outlook message id is invalid.", 400);
  const url = new URL(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("$select", "id,conversationId,receivedDateTime,subject,bodyPreview,from,toRecipients,ccRecipients,body");
  const value = await graphJson(fetcher, accessToken, url.toString());
  if (!record(value) || typeof value.id !== "string") throw new OutlookApiError("OUTLOOK_MESSAGE_INVALID", "Outlook message response is invalid.");
  const body = record(value.body) && typeof value.body.content === "string"
    ? plainTextBody(value.body.content, value.body.contentType)
    : null;
  const recipients = (candidate: unknown) => Array.isArray(candidate) ? candidate.flatMap((item) => address(item) ?? []).slice(0, 100) : [];
  return {
    id: value.id,
    conversationId: typeof value.conversationId === "string" ? value.conversationId : null,
    receivedDateTime: typeof value.receivedDateTime === "string" ? value.receivedDateTime : null,
    subject: typeof value.subject === "string" ? value.subject.slice(0, 2_000) : "",
    bodyPreview: typeof value.bodyPreview === "string" ? value.bodyPreview.slice(0, 4_000) : "",
    from: address(value.from),
    to: recipients(value.toRecipients),
    cc: recipients(value.ccRecipients),
    body,
  };
}
