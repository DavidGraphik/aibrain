import type { CatalogRuntimeEnforcer, CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";
import type { NativeAppToolPolicies } from "./connected-app-config";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Native metadata describes tools; workspace/catalog policy decides whether a
 * write is allowed. Unknown or disabled tools never inherit a blanket enable. */
export async function nativeAppToolsForTurn(transport: CatalogRuntimeTransport, resolveCatalog: () => Promise<CatalogRuntimeEnforcer>,
  appIds: readonly string[], purpose: string, allowWrites = false): Promise<NativeAppToolPolicies> {
  const ids = [...new Set(appIds)];
  // Read only names from previous config, never return provider/link metadata.
  // An explicit saved app/tool enable outranks an app default, so it must be
  // represented in the new turn's negative overrides as well.
  const configuration = await transport.request("config/read", { includeLayers: false }, `${purpose}:config`, 10_000);
  if (!record(configuration) || !record(configuration.config) ||
      configuration.config.apps != null && !record(configuration.config.apps)) throw new Error("NATIVE_APP_CONFIG_UNAVAILABLE");
  const previous = record(configuration.config.apps) ? configuration.config.apps : {};
  const knownIds = [...new Set([...ids, ...Object.keys(previous).filter(id => id !== "_default")])];
  const result: NativeAppToolPolicies = Object.fromEntries(knownIds.map(id => {
    const entry = previous[id];
    return [id, { allowed: [], known: record(entry) && record(entry.tools) ? Object.keys(entry.tools).sort() : [] }];
  }));
  for (let offset = 0; offset < ids.length; offset += 100) {
    const selected = ids.slice(offset, offset + 100);
    let response: unknown;
    try { response = await transport.request("app/read", { appIds: selected, includeTools: true }, `${purpose}:${offset}`, 10_000); }
    catch { continue; } // Disable this batch; unrelated ordinary chat can proceed.
    if (!record(response) || !Array.isArray(response.apps)) continue;
    const catalog = await resolveCatalog();
    for (const id of selected) {
      if (!catalog.allowsNativeAppRead(id)) continue;
      const matches = response.apps.filter(app => record(app) && app.id === id);
      if (matches.length !== 1 || !record(matches[0]) || !Array.isArray(matches[0].toolSummaries)) continue;
      const tools = matches[0].toolSummaries;
      const seen = new Set<string>();
      const duplicate = new Set<string>();
      for (const tool of tools) if (record(tool) && typeof tool.name === "string") {
        result[id].known = [...new Set([...result[id].known, tool.name])].sort();
        if (seen.has(tool.name)) duplicate.add(tool.name); else seen.add(tool.name);
      }
      result[id].allowed = tools.flatMap(tool => record(tool) && typeof tool.name === "string" && !duplicate.has(tool.name)
        && tool.name.length > 0 && tool.name.length <= 512 && !/[\u0000-\u001f\u007f]/.test(tool.name)
        && tool.isEnabled === true && typeof tool.isReadOnly === "boolean"
        && (tool.isReadOnly || allowWrites && catalog.allowsNativeAppWrite(id)) ? [tool.name] : []).sort();
    }
  }
  return result;
}
