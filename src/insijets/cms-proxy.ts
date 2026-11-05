import { createHash, createHmac, randomUUID } from "node:crypto";
import type { AuthSession } from "../auth/types";
import { canAccessInsiJetsCMS, cmsPathAllowed, CMS_TENANT } from "./cms-access";
export type CMSConfiguration = { installationId: string; enabled: boolean; upstreamOrigin: string; brainOrigin: string; signingKey: string; allowLoopback?: boolean };
const MAX_BODY = 8 * 1024 * 1024;
// Only the owner-authorized catalogue GET needs a complete, larger response.
const MAX_CATALOGUE_BYTES = 64 * 1024 * 1024;
const CATALOGUE_TIMEOUT_MS = 90_000;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const denied = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS });
export async function proxyCMS(request: Request, configuration: CMSConfiguration, session: AuthSession | null, path: string) {
  if (!session) return denied(401, "AUTH_REQUIRED");
  if (!canAccessInsiJetsCMS(session, configuration.installationId)) return denied(403, "CMS_ACCESS_DENIED");
  if (!cmsPathAllowed(path, request.method)) return denied(403, "CMS_PATH_DENIED");
  if (!configuration.enabled || configuration.signingKey.length < 32) return denied(503, "CMS_NOT_CONNECTED");
  let upstream: URL;
  try {
    upstream = new URL(configuration.upstreamOrigin);
    if (upstream.href !== upstream.origin + "/" || upstream.username || upstream.password ||
      (upstream.protocol !== "https:" && !(configuration.allowLoopback && upstream.protocol === "http:" && ["127.0.0.1", "localhost"].includes(upstream.hostname)))) throw Error();
    if (new URL(configuration.brainOrigin).origin !== configuration.brainOrigin) throw Error();
  } catch { return denied(503, "CMS_CONFIGURATION_INVALID"); }
  if (request.headers.get("sec-fetch-site") === "cross-site") return denied(403, "ORIGIN_DENIED");
  if (request.method !== "GET" && request.headers.get("origin") !== configuration.brainOrigin) return denied(403, "ORIGIN_DENIED");
  if (request.method !== "GET" && !request.headers.get("content-type")?.startsWith("application/json")) return denied(415, "JSON_REQUIRED");
  const chunks: Uint8Array[] = []; let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); return denied(413, "REQUEST_TOO_LARGE"); } chunks.push(chunk.value); }
  }
  const body = Buffer.concat(chunks);
  const query = new URL(request.url).searchParams;
  // The CMS only uses locale/type and immutable asset versions; arbitrary redirect/token parameters never cross.
  if ([...query.keys()].some(key => !["locale", "type", "v", "id"].includes(key))) return denied(400, "QUERY_DENIED");
  const target = "/brain-cms" + path + (query.size ? "?" + query.toString() : "");
  const assertion = Buffer.from(JSON.stringify({ version: 1, tenant: CMS_TENANT, email: session.user.email.toLowerCase(),
    userId: session.user.id, method: request.method, target, at: Date.now(), nonce: randomUUID(),
    bodyHash: createHash("sha256").update(body).digest("hex") })).toString("base64url");
  const catalogueRead = request.method === "GET" && path === "/api/admin/content";
  const signal = catalogueRead
    ? AbortSignal.any([request.signal, AbortSignal.timeout(CATALOGUE_TIMEOUT_MS)])
    : AbortSignal.timeout(20000);
  try {
    const response = await fetch(upstream.origin + target, { method: request.method, redirect: "manual", cache: "no-store",
      signal, headers: { "X-InsiJets-CMS-Assertion": assertion,
        "X-InsiJets-CMS-Signature": createHmac("sha256", configuration.signingKey).update(assertion).digest("hex"),
        ...(request.method === "GET" ? {} : { "Content-Type": "application/json" }) },
      ...(request.method === "GET" ? {} : { body }) });
    if (response.status >= 300 && response.status < 400) return denied(502, "CMS_REDIRECT_DENIED");
    const headers = new Headers(HEADERS);
    headers.set("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    headers.set("X-Frame-Options", "SAMEORIGIN");
    headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'");
    if (catalogueRead && response.ok) {
      if (response.status !== 200 || !/^application\/json(?:;|$)/iu.test(headers.get("Content-Type") || "") || !response.body) {
        await response.body?.cancel();
        return denied(502, "CMS_RESPONSE_INVALID");
      }
      if (Number(response.headers.get("content-length")) > MAX_CATALOGUE_BYTES) {
        await response.body.cancel();
        return denied(502, "CMS_RESPONSE_TOO_LARGE");
      }
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > MAX_CATALOGUE_BYTES) {
            await reader.cancel();
            return denied(502, "CMS_RESPONSE_TOO_LARGE");
          }
          parts.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const complete = Buffer.concat(parts, received);
      try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(complete)); }
      catch { return denied(502, "CMS_RESPONSE_INVALID"); }
      headers.set("Content-Length", String(received));
      return new Response(new Uint8Array(complete), { status: response.status, headers });
    }
    if (headers.get("Content-Type")?.startsWith("text/css")) {
      const css = (await response.text()).replace(/url\((['"]?)(\/(?!\/)[^)'"\s]+)\1\)/g, (_match, quote: string, asset: string) => `url(${quote}/api/insijets/cms${asset}${quote})`);
      return new Response(css, { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  } catch {
    if (catalogueRead && signal.aborted && signal.reason?.name === "TimeoutError") return denied(504, "CMS_RESPONSE_TIMEOUT");
    return denied(502, "CMS_UNAVAILABLE");
  }
}
