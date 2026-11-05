import "server-only";

import type { CatalogResource } from "@/catalog/contracts";
import type { CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";
import type { ConnectorHealthStatus } from "@/connectors/contracts";

type NativeConnectionHealth = { status: ConnectorHealthStatus; statusCode: string | null };
type InventoryEntry = Record<string, unknown>;
const unavailable = (): NativeConnectionHealth => ({ status: "degraded", statusCode: "NATIVE_CONNECTION_UNAVAILABLE" });
const record = (value: unknown): value is InventoryEntry => Boolean(value && typeof value === "object" && !Array.isArray(value));

async function inventory(
  transport: CatalogRuntimeTransport,
  method: "app/list" | "mcpServerStatus/list",
  wanted: ReadonlySet<string>,
): Promise<Map<string, InventoryEntry | null>> {
  const entries = new Map<string, InventoryEntry | null>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await transport.request(method, {
      ...(method === "app/list" ? { forceRefetch: true } : { detail: "toolsAndAuthOnly" }),
      threadId: null,
      ...(cursor ? { cursor } : {}),
    }, "connector-native-connection-health", 10_000);
    if (!record(response) || !Array.isArray(response.data)) throw new Error("Invalid native connection inventory.");
    for (const entry of response.data) {
      if (!record(entry)) continue;
      const id = entry[method === "app/list" ? "id" : "name"];
      if (typeof id !== "string" || !wanted.has(id)) continue;
      // Ambiguous provider records never establish a usable connection.
      entries.set(id, entries.has(id) ? null : entry);
    }
    const next = response.nextCursor;
    if (next === null || next === undefined) break;
    if (typeof next !== "string" || next.length === 0 || cursors.has(next)) throw new Error("Invalid native connection cursor.");
    cursors.add(next);
    cursor = next;
  } while (cursor);
  return entries;
}

function appHealth(entry: InventoryEntry | null | undefined): NativeConnectionHealth {
  if (entry === undefined) return { status: "not_configured", statusCode: "NATIVE_APP_NOT_LISTED" };
  if (!entry || typeof entry.isEnabled !== "boolean" || typeof entry.isAccessible !== "boolean") return unavailable();
  if (!entry.isEnabled) return { status: "not_configured", statusCode: "NATIVE_APP_DISABLED" };
  return entry.isAccessible ? { status: "connected", statusCode: null }
    : { status: "reauth_required", statusCode: "NATIVE_APP_LOGIN_REQUIRED" };
}

function mcpHealth(entry: InventoryEntry | null | undefined): NativeConnectionHealth {
  if (!entry) return unavailable();
  if (entry.runtimeStatus === "authenticationRequired" || entry.authStatus === "notLoggedIn") {
    return { status: "reauth_required", statusCode: "NATIVE_MCP_LOGIN_REQUIRED" };
  }
  return entry.runtimeStatus === "connected" && typeof entry.authStatus === "string" && ["unknown", "unsupported", "bearerToken", "oAuth"].includes(entry.authStatus)
    ? { status: "connected", statusCode: null } : unavailable();
}

/** Uses only the identity-bound, catalog-filtered inventories. Provider records
 * and references never leave this module; callers receive resource IDs/status. */
export async function nativeConnectionHealthForIdentity(
  installationId: string,
  userId: string,
  resources: readonly CatalogResource[],
): Promise<Map<string, NativeConnectionHealth>> {
  const health = new Map<string, NativeConnectionHealth>();
  const apps = resources.filter(resource => resource.kind === "app");
  const mcps = resources.filter(resource => resource.kind === "mcp");
  const native = [...apps, ...mcps];
  if (!native.length) return health;
  for (const resource of native) health.set(resource.id, unavailable());
  try {
    const { catalogTransportForUser } = await import("@/catalog/server-service");
    const transport = await catalogTransportForUser(installationId, userId);
    const groups = [
      { resources: apps, method: "app/list" as const, id: (resource: CatalogResource) => resource.appId, project: appHealth },
      { resources: mcps, method: "mcpServerStatus/list" as const, id: (resource: CatalogResource) => resource.mcp?.server, project: mcpHealth },
    ].filter(group => group.resources.length > 0);
    const results = await Promise.allSettled(groups.map(group => inventory(transport, group.method,
      new Set(group.resources.flatMap(resource => group.id(resource) ? [group.id(resource)!] : [])))));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") continue;
      const group = groups[index];
      for (const resource of group.resources) {
        const id = group.id(resource);
        if (id) health.set(resource.id, group.project(result.value.get(id)));
      }
    }
  } catch { /* An unavailable transport must not hide other providers or grant access. */ }
  return health;
}
