import type { CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";

export class NativeAppReadinessError extends Error {
  readonly code = "NATIVE_APP_READINESS_UNAVAILABLE";
  constructor() {
    super("No se han podido preparar las conexiones personales. Inténtalo de nuevo en unos segundos.");
    this.name = "NativeAppReadinessError";
  }
}

type InstalledApp = { id: string; enabled: boolean; callable: boolean };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function installedApps(value: unknown): InstalledApp[] {
  if (!record(value) || !Array.isArray(value.apps) || value.apps.length > 4096 || value.nextCursor) throw new NativeAppReadinessError();
  const ids = new Set<string>();
  return value.apps.map(app => {
    if (!record(app) || typeof app.id !== "string" || !app.id || app.id === "_default" || ids.has(app.id)
      || typeof app.enabled !== "boolean" || typeof app.callable !== "boolean") throw new NativeAppReadinessError();
    ids.add(app.id);
    return { id: app.id, enabled: app.enabled, callable: app.callable };
  });
}

/** Read the SDK's authoritative committed snapshot, with no application cache.
 * Only a missing assigned ID needs discovery. A known disabled/non-callable app
 * must stay closed; a failed refresh must never fall back to the earlier view.
 * Cold refresh publishes the complete hosted tool snapshot (17s measured on
 * the pinned SDK), so wait for that exact metadata response before admission. */
export async function nativeInstalledApps(transport: CatalogRuntimeTransport, wanted: readonly string[], purpose: string): Promise<InstalledApp[]> {
  try {
    const committed = installedApps(await transport.request("app/installed", { threadId: null, forceRefresh: false }, `${purpose}:committed`, 10_000));
    if (wanted.every(id => committed.some(app => app.id === id))) return committed;
    return installedApps(await transport.request("app/installed", { threadId: null, forceRefresh: true }, `${purpose}:refresh`, 45_000));
  } catch { throw new NativeAppReadinessError(); }
}

/** A connection can disappear between mention resolution and tool discovery.
 * Never submit a model turn that silently lost a previously admitted app. */
export function assertNativeAppToolsReady(appIds: readonly string[], policies: Readonly<Record<string, { allowed: readonly string[] }>>) {
  if (appIds.some(id => !policies[id]?.allowed.length)) throw new NativeAppReadinessError();
}
