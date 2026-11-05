import type { CatalogRuntimeEnforcer, CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";

/** Reads only server names from the private config. Addresses, headers and
 * credentials never enter developer instructions or the browser. */
export async function nativeMcpConfigForTurn(transport: CatalogRuntimeTransport, resolveCatalog: () => Promise<CatalogRuntimeEnforcer>,
  connectedResourceIds: ReadonlySet<string>, purpose: string, allowWrites = false) {
  const response = await transport.request("config/read", { includeLayers: false }, purpose, 10_000);
  if (!response || typeof response !== "object" || Array.isArray(response) || !("config" in response)
    || !response.config || typeof response.config !== "object" || Array.isArray(response.config)) throw new Error("NATIVE_MCP_CONFIG_UNAVAILABLE");
  const configured = "mcp_servers" in response.config ? response.config.mcp_servers : undefined;
  if (configured !== undefined && (!configured || typeof configured !== "object" || Array.isArray(configured))) throw new Error("NATIVE_MCP_CONFIG_INVALID");
  const plugins = "plugins" in response.config ? response.config.plugins : undefined;
  if (plugins !== undefined && (!plugins || typeof plugins !== "object" || Array.isArray(plugins))) throw new Error("NATIVE_MCP_CONFIG_INVALID");
  const catalog = await resolveCatalog();
  const locations = Object.keys(configured ?? {}).map(server => ({ server, prefix: "mcp_servers" }));
  const overrides: Record<string, boolean | string[]> = {};
  for (const [plugin, raw] of Object.entries(plugins ?? {})) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("NATIVE_PLUGIN_CONFIG_INVALID");
    const entry = raw as Record<string, unknown>;
    const servers = entry.mcp_servers;
    if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) throw new Error("NATIVE_PLUGIN_CONFIG_INVALID");
    // A packaged server without explicit configuration provenance cannot be
    // matched to a tenant policy. Do not let the plugin bypass the MCP boundary.
    const prefix = `plugins.${JSON.stringify(plugin)}`;
    const names = Object.keys(servers ?? {});
    overrides[`${prefix}.enabled`] = false;
    for (const server of names) locations.push({ server, prefix: `${prefix}.mcp_servers` });
  }
  const counts = new Map<string, number>();
  for (const { server } of locations) counts.set(server, (counts.get(server) ?? 0) + 1);
  for (const { server, prefix } of locations) {
    const policy = catalog.nativeMcpConfig([server], counts.get(server) === 1 ? connectedResourceIds : new Set(), allowWrites);
    for (const suffix of ["enabled", "enabled_tools"]) overrides[`${prefix}.${server}.${suffix}`] = policy[`mcp_servers.${server}.${suffix}`];
    // Configuration can contain only overrides for a subset of a plugin's
    // bundled servers. Keep the bundle disabled until its complete manifest
    // provenance can be verified; one assigned server cannot authorize siblings.
  }
  return overrides;
}
