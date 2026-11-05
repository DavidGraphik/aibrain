import type { CatalogRuntimeEnforcer, CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";
import type { NativeAppToolPolicies } from "./connected-app-config";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Native metadata describes tools; workspace/catalog policy decides whether a
 * write is allowed. Unknown or disabled tools never inherit a blanket enable. */
export async function nativeAppToolsForTurn(transport: CatalogRuntimeTransport, resolveCatalog: () => Promise<CatalogRuntimeEnforcer>,
  appIds: readonly string[], purpose: string, allowWrites = false, previousThread: NativeAppToolPolicies = {}): Promise<NativeAppToolPolicies> {
  const ids = [...new Set(appIds)];
  // Read only names from previous config, never return provider/link metadata.
  // An explicit saved app/tool enable outranks an app default, so it must be
  // represented in the new turn's negative overrides as well.
  const denied = (): NativeAppToolPolicies => Object.fromEntries([...new Set([...ids, ...Object.keys(previousThread)])]
    .map(id => [id, { allowed: [], known: [...(previousThread[id]?.known ?? [])] }]));
  let configuration: unknown;
  try { configuration = await transport.request("config/read", { includeLayers: false }, `${purpose}:config`, 10_000); }
  catch { return denied(); }
  if (!record(configuration) || !record(configuration.config) ||
      configuration.config.apps != null && !record(configuration.config.apps)) return denied();
  const previous = record(configuration.config.apps) ? configuration.config.apps : {};
  let snapshot: unknown;
  try { snapshot = await transport.request("app/installed", { forceRefresh: false }, `${purpose}:installed`, 10_000); }
  catch { return denied(); }
  // 0.162.1 installed snapshots are complete and unpaginated. Only committed
  // runtime IDs are needed here; no remote metadata refresh or foreign app/read.
  if (!record(snapshot) || !Array.isArray(snapshot.apps) || snapshot.apps.length > 4096 || snapshot.nextCursor) return denied();
  const installed = new Map<string, boolean>();
  for (const app of snapshot.apps) {
    if (!record(app) || typeof app.id !== "string" || !app.id || app.id === "_default" || installed.has(app.id)
      || typeof app.enabled !== "boolean" || typeof app.callable !== "boolean") return denied();
    installed.set(app.id, app.enabled && app.callable);
  }
  const knownIds = [...new Set([...ids, ...Object.keys(previous).filter(id => id !== "_default"), ...Object.keys(previousThread), ...installed.keys()])];
  const result: NativeAppToolPolicies = Object.fromEntries(knownIds.map(id => {
    const entry = previous[id];
    return [id, { allowed: [], known: [...new Set([...(previousThread[id]?.known ?? []),
      ...(record(entry) && record(entry.tools) ? Object.keys(entry.tools) : []),
    ])].sort() }];
  }));
  const accessible = ids.filter(id => installed.get(id));
  for (let offset = 0; offset < accessible.length; offset += 100) {
    const selected = accessible.slice(offset, offset + 100);
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
