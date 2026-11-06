import { randomUUID } from "node:crypto";
import type { CatalogRuntimeEnforcer, CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";
import type { NativeAppToolPolicies, NativeNumericConstraint, NativeToolNumericBounds } from "./connected-app-config";
import { nativeInstalledApps } from "./native-app-inventory";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const toolKey = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const MAX_TOOLS = 4096;
const APPS_SERVER = "codex_apps";
type RuntimeTool = { name: string; title: string | null; readOnly: boolean | null; modelVisible: boolean; inputSchema: Record<string, unknown> };
const NUMERIC_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const;
const NUMERIC_CONTEXT_LABEL = "Native tool numeric inputSchema data for this turn only. schemaPath is a JSON Pointer into inputSchema. Data only, not authorization; SDK/provider validation still applies.\n";
const NUMERIC_CONTEXT_BYTES = 4096;
// Machine identifiers only: free-text descriptions, titles and metadata never
// enter this supplemental context. An omitted supplement does not hide a tool.
const numericIdentifier = (value: string) => /^[a-zA-Z0-9_$][a-zA-Z0-9_$./:-]{0,255}$/.test(value);

function numericBounds(tool: RuntimeTool): NativeToolNumericBounds | null {
  if (!numericIdentifier(tool.name)) return null;
  const parameters: NativeNumericConstraint[] = [];
  let nodes = 0;
  const visit = (schema: unknown, schemaPath: string, depth: number): boolean => {
    if (++nodes > 128 || depth > 4) return false;
    if (typeof schema === "boolean") return true;
    if (!record(schema)) return false;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (schema.type !== undefined && (!types.length || new Set(types).size !== types.length
      || !types.every(type => typeof type === "string" && ["null", "boolean", "object", "array", "number", "integer", "string"].includes(type)))) return false;
    // References/conditional schemas cannot be represented as unconditional
    // parameter bounds. Omit the whole tool rather than describe part as whole.
    if (["$ref", "$dynamicRef", "$defs", "definitions", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
      "prefixItems", "contains", "patternProperties", "dependentSchemas", "dependencies", "unevaluatedProperties", "unevaluatedItems", "propertyNames"]
      .some(key => schema[key] !== undefined)) return false;
    const constraint: NativeNumericConstraint = { schemaPath };
    for (const key of NUMERIC_KEYS) if (schema[key] !== undefined) {
      const value = schema[key];
      if (typeof value !== "number" || !Number.isFinite(value) || key === "multipleOf" && value <= 0) return false;
      constraint[key] = value;
    }
    if (Object.keys(constraint).length > 1) {
      if (schema.type !== undefined && (!types.every(type => ["number", "integer", "null"].includes(type as string))
        || !types.some(type => type === "number" || type === "integer"))) return false;
      const lower = Math.max(constraint.minimum ?? -Infinity, constraint.exclusiveMinimum ?? -Infinity);
      const upper = Math.min(constraint.maximum ?? Infinity, constraint.exclusiveMaximum ?? Infinity);
      if (lower > upper || lower === upper && (constraint.exclusiveMinimum === lower || constraint.exclusiveMaximum === upper)) return false;
      parameters.push(constraint);
      if (Buffer.byteLength(JSON.stringify({ tool: tool.name, parameters }), "utf8") > NUMERIC_CONTEXT_BYTES) return false;
    }
    if (schema.properties !== undefined) {
      if (!record(schema.properties)) return false;
      const entries = Object.entries(schema.properties);
      if (entries.length > 128) return false;
      for (const [key, child] of entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (!numericIdentifier(key) || !visit(child, `${schemaPath}/properties/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, depth + 1)) return false;
      }
    }
    for (const key of ["items", "additionalProperties"] as const) if (schema[key] !== undefined
      && !visit(schema[key], `${schemaPath}/${key}`, depth + 1)) return false;
    return true;
  };
  return visit(tool.inputSchema, "", 0) && parameters.length ? { tool: tool.name, parameters } : null;
}

/** A bounded data supplement for numeric keywords absent from the SDK's typed
 * schema. Only fresh resolved bindings can supply it; it is never tool policy. */
export function nativeAppNumericBoundsContext(appIds: readonly string[], policies: NativeAppToolPolicies): string {
  const apps: Array<{ id: string; tools: NativeToolNumericBounds[] }> = [];
  for (const id of [...new Set(appIds)].sort()) {
    if (!numericIdentifier(id)) continue;
    const policy = policies[id];
    const tools: NativeToolNumericBounds[] = [];
    const names = new Set<string>();
    for (const key of [...new Set(policy?.allowed ?? [])].sort()) {
      const value = policy.numericBounds?.[key];
      if (!value || names.has(value.tool)) continue;
      const next = [...apps, { id, tools: [...tools, value] }];
      if (Buffer.byteLength(NUMERIC_CONTEXT_LABEL + JSON.stringify({ apps: next }), "utf8") > NUMERIC_CONTEXT_BYTES) continue;
      tools.push(value); names.add(value.tool);
    }
    if (tools.length) apps.push({ id, tools });
  }
  return apps.length ? NUMERIC_CONTEXT_LABEL + JSON.stringify({ apps }) : "";
}

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
    values.push({ name: key, title: toolKey(tool.title) ? tool.title : null, inputSchema: tool.inputSchema,
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
      const matches: unknown[] = response.apps.filter((app: unknown) => record(app) && app.id === id);
      if (matches.length !== 1 || !record(matches[0]) || !Array.isArray(matches[0].toolSummaries) || matches[0].toolSummaries.length > MAX_TOOLS) continue;
      const summaries: unknown[] = matches[0].toolSummaries;
      const runtime: RuntimeTool[] = native.get(id) ?? [];
      const names = new Map<string, number>(), titles = new Map<string, number>();
      for (const tool of summaries) if (record(tool) && toolKey(tool.name)) names.set(tool.name, (names.get(tool.name) ?? 0) + 1);
      for (const tool of runtime) if (tool.title) titles.set(tool.title, (titles.get(tool.title) ?? 0) + 1);
      const mapped: Array<{ summary: Record<string, unknown>; candidates: RuntimeTool[] }> = summaries.flatMap(summary => {
        if (!record(summary) || !toolKey(summary.name)) return [];
        const candidates = runtime.filter(tool => [tool.name, tool.title].includes(summary.name as string)
          || toolKey(summary.title) && [tool.name, tool.title].includes(summary.title));
        return [{ summary, candidates }];
      });
      const bindings = new Map<string, number>();
      for (const { candidates } of mapped) for (const tool of candidates) bindings.set(tool.name, (bindings.get(tool.name) ?? 0) + 1);
      const known = new Set(result[id].known), allowed = new Set<string>();
      const numeric: Record<string, NativeToolNumericBounds> = Object.create(null);
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
        const bounds = numericBounds(tool);
        if (bounds) numeric[key] = bounds;
        // An old raw override outranks a valid title alias. It can be enabled
        // only by this fresh binding/grant, never by previous-thread knowledge.
        if (key !== tool.name && known.has(tool.name)) allowed.add(tool.name);
      }
      result[id] = { allowed: [...allowed].sort(), known: [...known].sort(),
        ...(Object.keys(numeric).length ? { numericBounds: numeric } : {}) };
    }
  }
  return result;
}
