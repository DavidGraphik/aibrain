import { randomUUID } from "node:crypto";
import type { CatalogRuntimeEnforcer, CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";
import type { NativeAppToolPolicies } from "./connected-app-config";
import { nativeInstalledApps } from "./native-app-inventory";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const toolKey = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const MAX_TOOLS = 4096;
const APPS_SERVER = "codex_apps";
type RuntimeTool = { name: string; title: string | null; readOnly: boolean | null; modelVisible: boolean };

function modelVisible(meta: Record<string, unknown>) {
  if (meta.ui === undefined) return true;
  if (!record(meta.ui)) return false;
  if (meta.ui.visibility === undefined) return true;
  return Array.isArray(meta.ui.visibility) && meta.ui.visibility.length <= 16
    && meta.ui.visibility.every(value => typeof value === "string") && meta.ui.visibility.includes("model");
}

/** The SDK policy matches the raw name, then the native (already normalized)
 * title. Display metadata is not that namespace, and cannot supply identity. */
async function runtimeTools(transport: CatalogRuntimeTransport, wanted: ReadonlySet<string>, purpose: string) {
  let server: Record<string, unknown> | undefined;
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 4; page++) {
    const response = await transport.request("mcpServerStatus/list", { serverName: APPS_SERVER,
      detail: "toolsAndAuthOnly", threadId: null, limit: 1, ...(cursor ? { cursor } : {}),
    }, `${purpose}:${page}`, 10_000);
    if (!record(response) || !Array.isArray(response.data) || response.data.length > 1) throw new Error("NATIVE_APP_TOOLS_INVALID");
    for (const row of response.data) {
      if (!record(row) || row.name !== APPS_SERVER || server) throw new Error("NATIVE_APP_TOOLS_AMBIGUOUS");
      server = row;
    }
    if (response.nextCursor === null) break;
    if (typeof response.nextCursor !== "string" || !response.nextCursor || response.nextCursor.length > 4096
      || cursors.has(response.nextCursor) || page === 3) throw new Error("NATIVE_APP_TOOLS_CURSOR_INVALID");
    cursors.add(response.nextCursor); cursor = response.nextCursor;
  }
  if (!server || !record(server.tools) || Object.keys(server.tools).length > MAX_TOOLS || server.toolsError !== null
    // A published cached catalog remains usable while its connection starts.
    || ![null, "notStarted", "starting", "connected"].includes(server.runtimeStatus as string | null)
    || typeof server.authStatus !== "string" || !["unknown", "unsupported", "bearerToken", "oAuth"].includes(server.authStatus)) throw new Error("NATIVE_APP_TOOLS_UNAVAILABLE");
  const result = new Map<string, RuntimeTool[]>();
  for (const [key, tool] of Object.entries(server.tools)) {
    if (!record(tool) || !toolKey(key) || tool.name !== key || !record(tool.inputSchema)) throw new Error("NATIVE_APP_TOOL_INVALID");
    const meta = record(tool._meta) ? tool._meta : null;
    if (!meta || typeof meta.connector_id !== "string" || !wanted.has(meta.connector_id)) continue;
    if (tool.title !== undefined && !toolKey(tool.title)) continue;
    const annotations = record(tool.annotations) ? tool.annotations : {};
    const values = result.get(meta.connector_id) ?? [];
    values.push({ name: key, title: toolKey(tool.title) ? tool.title : null,
      readOnly: typeof annotations.readOnlyHint === "boolean" ? annotations.readOnlyHint : null, modelVisible: modelVisible(meta) });
    result.set(meta.connector_id, values);
  }
  return result;
}

function allowedAppConfig(value: unknown) {
  return value === undefined || record(value) && value.enabled !== false && (value.tools === undefined || record(value.tools));
}
function explicitlyDisabled(value: unknown, keys: readonly (string | null)[]) {
  const tools = record(value) && record(value.tools) ? value.tools : {};
  return keys.some(key => key !== null && record(tools[key]) && tools[key].enabled === false);
}

/** Native metadata describes tools; workspace/catalog policy decides whether a
 * write is allowed. Unknown or disabled tools never inherit a blanket enable. */
export async function nativeAppToolsForTurn(transport: CatalogRuntimeTransport, resolveCatalog: () => Promise<CatalogRuntimeEnforcer>,
  appIds: readonly string[], purpose: string, allowWrites = false, previousThread: NativeAppToolPolicies = {}): Promise<NativeAppToolPolicies> {
  const observation = `${purpose}:${randomUUID()}`;
  const ids = [...new Set(appIds)];
  // Previous thread knowledge supplies negatives, never authorization.
  const denied = (): NativeAppToolPolicies => Object.fromEntries([...new Set([...ids, ...Object.keys(previousThread)])]
    .map(id => [id, { allowed: [], known: [...(previousThread[id]?.known ?? [])] }]));
  let configuration: unknown;
  try { configuration = await transport.request("config/read", { includeLayers: false }, `${observation}:config`, 10_000); }
  catch { return denied(); }
  if (!record(configuration) || !record(configuration.config) ||
      configuration.config.apps != null && !record(configuration.config.apps)) return denied();
  const previous = record(configuration.config.apps) ? configuration.config.apps : {};
  let snapshot: Awaited<ReturnType<typeof nativeInstalledApps>>;
  try { snapshot = await nativeInstalledApps(transport, ids, `${observation}:installed`); }
  catch { return denied(); }
  const installed = new Map(snapshot.map(app => [app.id, app.enabled && app.callable]));
  const knownIds = [...new Set([...ids, ...Object.keys(previous).filter(id => id !== "_default"), ...Object.keys(previousThread), ...installed.keys()])];
  const result: NativeAppToolPolicies = Object.fromEntries(knownIds.map(id => {
    const entry = previous[id];
    return [id, { allowed: [], known: [...new Set([...(previousThread[id]?.known ?? []),
      ...(record(entry) && record(entry.tools) ? Object.keys(entry.tools) : []),
    ])].sort() }];
  }));
  let initialCatalog: CatalogRuntimeEnforcer;
  try { initialCatalog = await resolveCatalog(); } catch { return result; }
  const accessible = ids.filter(id => installed.get(id) && allowedAppConfig(previous[id]) && initialCatalog.allowsNativeAppRead(id));
  if (!accessible.length) return result;
  let native: Map<string, RuntimeTool[]>;
  try { native = await runtimeTools(transport, new Set(accessible), `${observation}:mcp`); }
  catch { return result; }
  for (let offset = 0; offset < accessible.length; offset += 100) {
    const selected = accessible.slice(offset, offset + 100);
    let response: unknown;
    try { response = await transport.request("app/read", { appIds: selected, includeTools: true }, `${observation}:${offset}`, 10_000); }
    catch { continue; }
    if (!record(response) || !Array.isArray(response.apps) || response.apps.length > selected.length) continue;
    let catalog: CatalogRuntimeEnforcer;
    try { catalog = await resolveCatalog(); } catch { continue; }
    for (const id of selected) {
      if (!catalog.allowsNativeAppRead(id)) continue;
      const matches = response.apps.filter(app => record(app) && app.id === id);
      if (matches.length !== 1 || !record(matches[0]) || !Array.isArray(matches[0].toolSummaries) || matches[0].toolSummaries.length > MAX_TOOLS) continue;
      const summaries = matches[0].toolSummaries;
      const runtime = native.get(id) ?? [];
      const names = new Map<string, number>(), titles = new Map<string, number>();
      for (const tool of summaries) if (record(tool) && toolKey(tool.name)) names.set(tool.name, (names.get(tool.name) ?? 0) + 1);
      for (const tool of runtime) if (tool.title) titles.set(tool.title, (titles.get(tool.title) ?? 0) + 1);
      const mapped = summaries.flatMap(summary => {
        if (!record(summary) || !toolKey(summary.name)) return [];
        const candidates = runtime.filter(tool => [tool.name, tool.title].includes(summary.name as string)
          || toolKey(summary.title) && [tool.name, tool.title].includes(summary.title));
        return [{ summary, candidates }];
      });
      const bindings = new Map<string, number>();
      for (const { candidates } of mapped) for (const tool of candidates) bindings.set(tool.name, (bindings.get(tool.name) ?? 0) + 1);
      const known = new Set(result[id].known), allowed = new Set<string>();
      for (const { summary, candidates } of mapped) {
        const name = summary.name as string;
        known.add(name);
        if (candidates.length !== 1 || (names.get(name) ?? 0) !== 1) {
          for (const tool of candidates) known.add(tool.name);
          continue;
        }
        const tool = candidates[0];
        const key = [tool.name, tool.title].includes(name) ? name : tool.name;
        known.add(key);
        if ((bindings.get(tool.name) ?? 0) !== 1 || tool.title && (titles.get(tool.title) ?? 0) !== 1
          || !tool.modelVisible || summary.isEnabled !== true || summary.disabledReason != null
          || summary.title != null && !toolKey(summary.title)
          || typeof summary.isReadOnly !== "boolean" || tool.readOnly === null || summary.isReadOnly !== tool.readOnly
          || explicitlyDisabled(previous[id], [name, tool.name, tool.title])
          || !tool.readOnly && !(allowWrites && catalog.allowsNativeAppWrite(id))) continue;
        allowed.add(key);
        // An old raw override outranks a valid title alias. It can be enabled
        // only by this fresh binding/grant, never by previous-thread knowledge.
        if (key !== tool.name && known.has(tool.name)) allowed.add(tool.name);
      }
      result[id] = { allowed: [...allowed].sort(), known: [...known].sort() };
    }
  }
  return result;
}
