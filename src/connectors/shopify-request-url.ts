import "server-only";
import { loadInstallationConfig } from "@/config/installation";
import { SHOPIFY_CALLBACK, SHOPIFY_START, shopifyFail } from "./shopify-contracts";

/** Next standalone constructs request.url with its bind host/port, not the public
 * Host header. Caddy terminates TLS and overwrites forwarded host/protocol.
 * Headers only validate the configured origin; they never choose a redirect. */
export async function shopifyPublicRequestUrl(request: Request, path: typeof SHOPIFY_START | typeof SHOPIFY_CALLBACK | "/api/connectors/shopify/themes/oauth/start" | "/api/connectors/shopify/themes/oauth/callback" | "/api/connectors/shopify/admin/oauth/start" | "/api/connectors/shopify/admin/oauth/callback") {
  const config = await loadInstallationConfig();
  const publicUrl = new URL(config.publicUrl), incoming = new URL(request.url);
  if (config.installationId !== "modtime" || publicUrl.protocol !== "https:" || publicUrl.port || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) shopifyFail("CALLBACK_CONFIGURATION_INVALID");
  if (incoming.protocol !== "https:" || incoming.username || incoming.password || incoming.hash || incoming.pathname !== path || (path.endsWith("/start") && incoming.search)) shopifyFail("CALLBACK_INVALID");
  if (request.headers.get("host") !== publicUrl.host) shopifyFail("CALLBACK_INVALID");
  const forwardedHost = request.headers.get("x-forwarded-host"), forwardedProto = request.headers.get("x-forwarded-proto");
  if ((forwardedHost !== null && forwardedHost !== publicUrl.host) || (forwardedProto !== null && forwardedProto !== "https")) shopifyFail("CALLBACK_INVALID");
  if (incoming.origin !== publicUrl.origin) {
    // Only the actual operator-configured standalone listener may be translated.
    const bindHost = process.env.HOSTNAME, port = process.env.PORT;
    if (!bindHost || !port || !/^\d{1,5}$/.test(port) || !["0.0.0.0", "127.0.0.1", "localhost"].includes(bindHost) || incoming.host !== `${bindHost}:${port}` || forwardedHost !== publicUrl.host || forwardedProto !== "https") shopifyFail("CALLBACK_INVALID");
  }
  return publicUrl.origin + incoming.pathname + incoming.search;
}
