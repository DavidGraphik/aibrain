import 'server-only';
import type { CatalogResource } from '@/catalog/contracts';
import type { InstallationConfig } from '@/config/installation-schema';
import { productContextForIdentity, type ProductContext } from './access';
import { g03ProductInstallation } from './contracts';
import { readProduction } from './production';
import { listApps, readApp } from './apps';

// appId belongs to Codex-managed external apps, never to an internal database.
const resource = (id: string, label: string): CatalogResource => ({
  id, label, kind: 'connector', credentialMode: 'none', managedBy: 'graphikai',
  sharedResource: false, appId: null, connectorId: id, mcp: null,
});

/** Project only data this identity can read now. Never seed a shared authorization cache. */
export async function productConnectorResources(ctx: ProductContext) {
  const result: CatalogResource[] = [];
  if (ctx.grants.includes('read')) {
    const production = await readProduction(ctx).catch(() => null);
    if (production && production.revision > 0) result.push(resource('g03-production', 'Producció'));
  }
  for (const app of await listApps(ctx)) {
    if (app.publishedVersion === null) continue;
    // Also validate the published version and schema, just as the chat reader does.
    const readable = await readApp(ctx, app.id, true).catch(() => null);
    if (readable) result.push(resource(`g03-app-${app.id}`, app.title));
  }
  return result;
}

export async function internalConnectorsForIdentity(installation: Readonly<InstallationConfig>, userId: string) {
  if (!g03ProductInstallation(installation.installationId)) return [];
  try {
    return await productConnectorResources(await productContextForIdentity(installation.installationId, userId, installation));
  } catch {
    // Missing/revoked policy or unreadable data must not become a connected tile.
    return [];
  }
}
