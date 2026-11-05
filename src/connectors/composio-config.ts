import type { CatalogResource } from "@/catalog/contracts";

/** Reviewed installation manifest, never inferred from model text or provider tool names. */
export type ComposioToolkitConfig = {
  slug: string;
  label: string;
  authConfigId: string;
  scopes: string[];
  readTools: Array<{ slug: string; version: string }>;
};
export function isComposioToolkitConfig(value: unknown): value is ComposioToolkitConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === "authConfigId,label,readTools,scopes,slug" &&
    typeof v.slug === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(v.slug) &&
    typeof v.label === "string" && v.label.length > 0 && v.label.length <= 100 &&
    typeof v.authConfigId === "string" && (v.authConfigId === "on-connect" || /^ac_[A-Za-z0-9_-]{1,120}$/.test(v.authConfigId)) &&
    Array.isArray(v.scopes) && v.scopes.length > 0 && v.scopes.length <= 32 &&
    v.scopes.every(s => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(s)) &&
    new Set(v.scopes).size === v.scopes.length &&
    Array.isArray(v.readTools) && v.readTools.length > 0 && v.readTools.length <= 40 &&
    v.readTools.every(t => t && typeof t === "object" && Object.keys(t).sort().join() === "slug,version" &&
      typeof t.slug === "string" && /^[A-Z][A-Z0-9_]{1,150}$/.test(t.slug) &&
      typeof t.version === "string" && /^\d{8}_\d{2}$/.test(t.version)) &&
    new Set(v.readTools.map(t => t.slug)).size === v.readTools.length;
}
export function composioConnectorId(slug: string) { return `composio-${slug.replaceAll("_", "-")}`; }
export function composioResource(toolkit: ComposioToolkitConfig): CatalogResource {
  const id = composioConnectorId(toolkit.slug);
  return { id, kind: "connector", label: toolkit.label, credentialMode: "personal-oauth", managedBy: "graphikai", sharedResource: false, appId: null, connectorId: id, mcp: null };
}
