import "server-only";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { FileConnectorBindingStore } from "@/connectors/binding-store";
import { INSTANTLY_CONNECTOR_ID, INSTANTLY_CREDENTIAL_REF, INSTANTLY_OPERATIONS, type InstantlyOperation } from "@/connectors/instantly-contracts";
import { InstantlyError, instantlyRead } from "@/connectors/instantly-api";

export async function instantlyReadForIdentity(config: Readonly<InstallationConfig>, userId: string, operation: InstantlyOperation, args: Record<string, unknown> = {}, fetcher = fetch) {
  const connector = config.connectors?.instantly;
  if (!connector?.enabled) throw new InstantlyError("INSTANTLY_NOT_CONFIGURED");
  const catalog = await catalogRuntimeEnforcer(config.installationId, userId);
  if (!catalog.allowsConnector(INSTANTLY_CONNECTOR_ID)) throw new InstantlyError("INSTANTLY_CATALOG_DENIED");
  const binding = await new FileConnectorBindingStore(config.installationId, config.paths.dataRoot)
    .resolve({ installationId: config.installationId, userId, roleId: null }, INSTANTLY_CONNECTOR_ID, { allowShared: true });
  if (binding.status !== "active" || binding.credentialRef !== INSTANTLY_CREDENTIAL_REF || !binding.scopes.includes("instantly:read")) throw new InstantlyError("INSTANTLY_BINDING_INVALID");
  const key = process.env.AIBRAIN_INSTANTLY_API_KEY?.trim();
  if (!key) throw new InstantlyError("INSTANTLY_CREDENTIAL_NOT_CONFIGURED");
  return instantlyRead(fetcher, key, connector.workspaceId, operation, args);
}

export async function instantlyCapability(config: Readonly<InstallationConfig>, userId: string) {
  const base = { connectorId: INSTANTLY_CONNECTOR_ID, label: "Instantly", effectiveOperations: [] as string[], approvalRequiredOperations: [] as string[], checkedAt: null as string | null, accountEmail: null, connectionVersion: null, connectUrl: null, disconnectUrl: null };
  if (!config.connectors?.instantly?.enabled) return { ...base, status: "not_configured" as const, statusCode: "INSTANTLY_NOT_CONFIGURED" };
  try {
    await instantlyReadForIdentity(config, userId, "workspace");
    return { ...base, status: "connected" as const, statusCode: null, checkedAt: new Date().toISOString(), effectiveOperations: [...INSTANTLY_OPERATIONS] };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "INSTANTLY_UNAVAILABLE";
    return { ...base, status: "degraded" as const, statusCode: code };
  }
}
export async function instantlyCapabilityForSession(config: Readonly<InstallationConfig>, session: AuthSession) {
  if (session.provider !== "local" || session.tenant.id !== config.installationId) throw new InstantlyError("INSTANTLY_TENANT_MISMATCH");
  return instantlyCapability(config, session.user.id);
}
