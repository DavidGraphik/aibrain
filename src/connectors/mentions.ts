import { g03ProductInstallation } from '@/g03-products/contracts';
import { internalConnectorsForIdentity } from '@/g03-products/connectors';
import { g03SageHealth } from "@/connectors/g03-sage-service";
import { G03_SAGE_RESOURCE } from "@/connectors/g03-catalog";
import { instantlyCapability } from "@/connectors/instantly-service";
import { composioCapability, composioCapabilitiesForSession } from "@/connectors/composio-service";
import { modtimeReportingCapabilities, MODTIME_REPORTING_RESOURCES } from "@/connectors/modtime-reporting";
import { trinalumConnectorHealth } from "@/connectors/trinalum-capabilities";
import "server-only";

import { workspacePolicyForIdentity } from "@/admin/policy-service";
import type { CatalogPrincipal, CatalogResource } from "@/catalog/contracts";
import { visibleCatalogResources, allowsCatalogOperation } from "@/catalog/resolver";
import { FileCatalogStore } from "@/catalog/store";
import type { AuthSession } from "@/auth/types";
import { loadInstallationConfig } from "@/config/installation";
import { codexManagedAppCapabilities } from "@/connectors/server-service";
import {
  projectConnectorMention,
} from "@/connectors/mentions-contract";
import { ensureInstallationCatalog } from "@/catalog/baseline";
import { gmailAccessForIdentity, gmailCapabilityForSession } from "@/connectors/gmail-server-service";
import { COMPANY_MAIL_CONNECTOR_ID } from "@/connectors/company-mail-contracts";
import { companyMailAccessForIdentity, companyMailCapabilityForSession } from "@/connectors/company-mail-server-service";
import { GMAIL_CONNECTOR_ID } from "@/connectors/gmail-contracts";
import { outlookAccessForIdentity, outlookCapabilityForSession } from "@/connectors/outlook-server-service";
import { OUTLOOK_CONNECTOR_ID } from "@/connectors/outlook-contracts";
import { MAIL_CONNECTOR_ID } from "@/connectors/mail-contracts";
import { mailCapabilityForSession, mailAccessForIdentity } from "@/connectors/mail-server-service";
import { nativeConnectionHealthForIdentity } from "@/connectors/native-connection-health";

export type { ConnectorMention, ConnectorMentionStatus, ResolvedConnectorMention } from "@/connectors/mentions-contract";

export class ConnectorMentionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ConnectorMentionError"; }
}

async function catalogForIdentity(installationId: string, userId: string) {
  const installation = await loadInstallationConfig();
  if (installation.installationId !== installationId) {
    throw new ConnectorMentionError("CONNECTOR_MENTION_TENANT_MISMATCH", "La instalación no coincide con la sesión.");
  }
  const workspace = await workspacePolicyForIdentity(installationId, userId, installation);
  const principal: CatalogPrincipal = {
    installationId,
    userId,
    roleId: workspace.roleId,
    groupIds: workspace.groups.map(({ id }) => id),
    workspaceCanExecute: workspace.policy.capabilities.execute,
  };
  const store = new FileCatalogStore(installationId, installation.paths.dataRoot);
  const state = await ensureInstallationCatalog(store, installation);
  return { installation, principal, state };
}

async function resolvedMentions(installationId: string, userId: string, session?: AuthSession) {
  const { installation, state, principal } = await catalogForIdentity(installationId, userId);
  const resources = visibleCatalogResources(state, principal)
    .filter((resource): resource is CatalogResource & { kind: "app" | "connector" | "mcp" } => resource.kind !== "skill")
    .filter(resource => !g03ProductInstallation(installationId) || resource.id !== "g03-production" && !resource.id.startsWith("g03-app-"));
  if (principal.workspaceCanExecute && (!session || session.provider === "local")) {
    const internal = await internalConnectorsForIdentity(installation, userId);
    resources.push(...internal.filter(resource => !state.rules.some(rule => rule.resourceId === resource.id) || allowsCatalogOperation(state, principal, resource.id, "read")) as typeof resources);
  }
  resources.sort((left, right) => left.label.localeCompare(right.label, g03ProductInstallation(installationId) ? "ca" : "es"));
  const connectUrls = new Map<string, string | null>();
  const health = new Map<string, { status: string; statusCode: string | null; accessVerified?: boolean }>();
  for (const [id, status] of await trinalumConnectorHealth(installationId, userId)) health.set(id, status);
  health.set(G03_SAGE_RESOURCE.id, await g03SageHealth(installationId, userId));
  // A previously provisioned tile must fail closed if installation configuration is removed.
  for (const resource of MODTIME_REPORTING_RESOURCES) {
    health.set(resource.id, { status: "not_configured", statusCode: "MODTIME_REPORTING_NOT_CONFIGURED" });
  }
  for (const capability of await modtimeReportingCapabilities(installationId, userId).catch(() => [])) {
    health.set(capability.connectorId, capability);
    connectUrls.set(capability.connectorId, capability.connectUrl);
  }
  if (session) {
    // An unavailable provider must not prevent ordinary chat or hide healthy
    // connections belonging to another provider. Its resources fail closed.
    const groups = [
      { ids: ["codex-managed-app"], read: () => codexManagedAppCapabilities(session) },
      { ids: resources.flatMap((resource) => resource.connectorId?.startsWith("composio-") ? [resource.connectorId] : []), read: () => composioCapabilitiesForSession(session) },
      { ids: [COMPANY_MAIL_CONNECTOR_ID], read: () => companyMailCapabilityForSession(session).then((capability) => [capability]) },
      ...(installation.connectors?.instantly?.enabled ? [{ ids: ["instantly"], read: () => instantlyCapability(installation, userId).then((capability) => [capability]) }] : []),
      { ids: [GMAIL_CONNECTOR_ID], read: () => gmailCapabilityForSession(session).then((capability) => [capability]) },
      { ids: [OUTLOOK_CONNECTOR_ID], read: () => outlookCapabilityForSession(session).then((capability) => [capability]) },
      ...(installation.connectors?.mail?.enabled ? [{ ids: [MAIL_CONNECTOR_ID], read: () => mailCapabilityForSession(session).then((capability) => capability ? [capability] : []) }] : []),
    ];
    const results = await Promise.allSettled(groups.map((group) => group.read()));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        for (const id of groups[index].ids) health.set(id, { status: "degraded", statusCode: "CONNECTOR_HEALTH_UNAVAILABLE" });
        continue;
      }
      for (const connector of result.value) {
        if ("connectUrl" in connector) connectUrls.set(connector.connectorId, connector.connectUrl as string | null);
        health.set(connector.connectorId, { status: connector.status, statusCode: connector.statusCode });
      }
    }
  } else {
    // Turn-time revalidation has no browser session object. It still verifies
    // the exact per-user binding and encrypted token instead of trusting the
    // connector chip rendered earlier by the client.
    for (const toolkit of installation.connectors?.composio?.toolkits ?? []) {
      const capability = await composioCapability(installation, userId, toolkit.slug).catch(() => null);
      if (capability) health.set(capability.connectorId, capability);
    }
    if (installation.connectors?.instantly?.enabled) {
      try {
        const capability = await instantlyCapability(installation, userId);
        health.set(capability.connectorId, capability);
      } catch {
        health.set("instantly", { status: "degraded", statusCode: "CONNECTOR_HEALTH_UNAVAILABLE" });
      }
    }
    const checks = [
      resources.some(resource => resource.connectorId === COMPANY_MAIL_CONNECTOR_ID) ? { id: COMPANY_MAIL_CONNECTOR_ID, access: () => companyMailAccessForIdentity(installation, userId), fallback: "MAIL_LOGIN_REQUIRED" } : null,
      resources.some((resource) => resource.connectorId === GMAIL_CONNECTOR_ID) ? { id: GMAIL_CONNECTOR_ID, access: () => gmailAccessForIdentity(installation, userId), fallback: "GMAIL_REAUTH_REQUIRED" } : null,
      resources.some((resource) => resource.connectorId === OUTLOOK_CONNECTOR_ID) ? { id: OUTLOOK_CONNECTOR_ID, access: () => outlookAccessForIdentity(installation, userId), fallback: "OUTLOOK_REAUTH_REQUIRED" } : null,
      resources.some((resource) => resource.connectorId === MAIL_CONNECTOR_ID) ? { id: MAIL_CONNECTOR_ID, access: () => mailAccessForIdentity(installation, userId), fallback: "MAIL_REAUTH_REQUIRED" } : null,
    ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    for (const check of checks) {
      try {
        await check.access();
        health.set(check.id, { status: "connected", statusCode: null });
      } catch (error) {
        const statusCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : check.fallback;
        health.set(check.id, { status: "reauth_required", statusCode });
      }
    }
  }
  const nativeWriteResources = new Set(resources.filter(resource => principal.workspaceCanExecute
    && allowsCatalogOperation(state, principal, resource.id, "write")).map(resource => resource.id));
  for (const [id, capability] of await nativeConnectionHealthForIdentity(installationId, userId, resources, nativeWriteResources)) {
    health.set(id, capability);
  }
  for (const resource of resources) {
    if (resource.kind === "mcp" && resource.credentialMode === "personal-oauth" && !resource.sharedResource) {
      connectUrls.set(resource.id, `/api/connectors/native/${encodeURIComponent(resource.id)}/oauth`);
    }
  }
  return { resources, mentions: resources.map((resource) => ({ ...projectConnectorMention(resource, health), connectUrl: connectUrls.get(resource.connectorId ?? resource.id) ?? null })) };
}

export async function connectorMentionsForSession(session: AuthSession) {
  const { mentions } = await resolvedMentions(session.tenant.id, session.user.id, session);
  return { schemaVersion: 1 as const, mentions };
}

/** Every connected resource is available to the assistant. Optional composer
 * hints never grant access or restrict the rest of this fresh inventory. */
export async function resolveAvailableConnectorsForTurn(
  installationId: string,
  userId: string,
  resourceIds: readonly string[] = [],
  session?: AuthSession,
) {
  if (resourceIds.length > 20 || new Set(resourceIds).size !== resourceIds.length) {
    throw new ConnectorMentionError("CONNECTOR_MENTION_INVALID", "Las referencias de conectores no son válidas.");
  }
  if (session && (session.tenant.id !== installationId || session.user.id !== userId)) {
    throw new ConnectorMentionError("CONNECTOR_MENTION_IDENTITY_MISMATCH", "La sesión del conector no coincide con el turno.");
  }
  const { resources, mentions } = await resolvedMentions(installationId, userId, session);
  const projected = new Map(mentions.map((mention) => [mention.id, mention]));
  // Validate client hints against current server data, even though no hint is
  // required. A forged or revoked hint must not enable a foreign resource.
  for (const id of resourceIds) {
    const mention = projected.get(id);
    if (!mention) throw new ConnectorMentionError("CONNECTOR_MENTION_DENIED", "La conexión indicada no está disponible para este usuario.");
    if (!mention.canRead) throw new ConnectorMentionError("CONNECTOR_MENTION_NOT_CONNECTED", "La conexión indicada requiere iniciar sesión o no está disponible.");
  }
  return resources.flatMap((resource) => {
    const mention = projected.get(resource.id);
    return mention?.canRead ? [{ resource, mention }] : [];
  });
}

/** Returns only catalog resources that are both currently visible and
 * callable for this identity. The turn resolver is still called afterwards,
 * so this convenience projection never becomes an authorization cache. */
export async function authorizedConnectorMentionIdsForTurn(
  session: AuthSession,
) {
  const { mentions } = await resolvedMentions(session.tenant.id, session.user.id, session);
  return mentions.filter((mention) => mention.canRead).map((mention) => mention.id);
}
