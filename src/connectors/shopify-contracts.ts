export const SHOPIFY_SHOP = "c7f82c-f0.myshopify.com";
export const SHOPIFY_CLIENT_ID = "f30d32703feccfacdf96b7c5bf862aa4";
export const SHOPIFY_CONNECTOR_ID = "modtime-shopify-orders";
export const SHOPIFY_SCOPES = ["read_orders", "read_draft_orders"] as const;
export const SHOPIFY_CALLBACK = "/api/connectors/shopify/oauth/callback";
export const SHOPIFY_START = "/api/connectors/shopify/oauth/start";
export type ShopifyToken = { accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number; scopes: string[] };
export function shopifyFail(code: string): never { throw new Error(`MODTIME_SHOPIFY_${code}`); }
export function exactShopifyScopes(value: unknown): boolean {
  const scopes = typeof value === "string" ? value.split(",").map(s => s.trim()) : value;
  return Array.isArray(scopes) && scopes.length === 2 && SHOPIFY_SCOPES.every(s => scopes.includes(s));
}
export function parseShopifyToken(value: unknown): ShopifyToken {
  const t = value as ShopifyToken;
  if (!t || typeof t.accessToken !== "string" || !t.accessToken || /\s/.test(t.accessToken) || typeof t.refreshToken !== "string" || !t.refreshToken || /\s/.test(t.refreshToken) ||
    !Number.isSafeInteger(t.expiresAt) || !Number.isSafeInteger(t.refreshExpiresAt) || !exactShopifyScopes(t.scopes)) shopifyFail("TOKEN_INVALID");
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, refreshExpiresAt: t.refreshExpiresAt, scopes: [...SHOPIFY_SCOPES] };
}

export type ShopifyCredentialProfile = { clientId: string; scopes: readonly string[]; directory: "shopify-orders" | "shopify-themes" | "shopify-admin" };
export const SHOPIFY_ORDERS_PROFILE: ShopifyCredentialProfile = { clientId: SHOPIFY_CLIENT_ID, scopes: SHOPIFY_SCOPES, directory: "shopify-orders" };
export function exactShopifyProfileScopes(value: unknown, profile: ShopifyCredentialProfile): boolean {
  const scopes: unknown = typeof value === "string" ? value.split(",").map(s => s.trim()) : value;
  if (!Array.isArray(scopes) || new Set(scopes).size !== scopes.length || scopes.some(s => typeof s !== "string")) return false;
  if (profile.directory === "shopify-admin") {
    return profile.scopes.every(required => scopes.includes(required) ||
      required.startsWith("read_") && scopes.includes(`write_${required.slice(5)}`)) &&
      scopes.every(granted => profile.scopes.includes(granted));
  }
  // Shopify's write_themes includes read_themes. The provider may omit the
  // redundant read handle; this does not authorize any additional capability.
  if (profile.directory === "shopify-themes" && profile.scopes.length === 2 && profile.scopes.includes("read_themes") && profile.scopes.includes("write_themes")) {
    return scopes.includes("write_themes") && scopes.every(s => profile.scopes.includes(s));
  }
  return scopes.length === profile.scopes.length && profile.scopes.every(s => scopes.includes(s));
}
export function parseShopifyProfileToken(value: unknown, profile: ShopifyCredentialProfile): ShopifyToken {
  const t = value as ShopifyToken;
  if (!t || typeof t.accessToken !== "string" || !t.accessToken || /\s/.test(t.accessToken) || typeof t.refreshToken !== "string" || !t.refreshToken || /\s/.test(t.refreshToken) ||
    !Number.isSafeInteger(t.expiresAt) || !Number.isSafeInteger(t.refreshExpiresAt) || !exactShopifyProfileScopes(t.scopes, profile)) shopifyFail("TOKEN_INVALID");
  return { ...t, scopes: [...profile.scopes] };
}
