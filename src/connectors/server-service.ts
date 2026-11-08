import "server-only";

import type { AuthSession } from "@/auth/types";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { FileConnectorBindingStore } from "@/connectors/binding-store";
import { FileConnectorAuthorizationStore } from "@/connectors/authorization-store";
import { CodexManagedAppAction } from "@/connectors/codex-managed-app-action";
import { connectorFingerprint } from "@/connectors/canonical";
import { CODEX_MANAGED_APP_CONNECTOR_ID, codexManagedAppRegistration } from "@/connectors/codex-managed-app-provider";
import { ConnectorError, type ConnectorCapabilitySnapshot } from "@/connectors/contracts";
import { ConnectorRegistry } from "@/connectors/registry";
import { loadInstallationConfig } from "@/config/installation";
import { FileApprovalStore } from "@/runtime/approval-store";
import { catalogTransportForUser } from "@/catalog/server-service";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";

async function connectorContext(session: AuthSession) {
  const installation = await loadInstallationConfig();
  if (installation.installationId !== session.tenant.id) {
    throw new Error("Authenticated installation does not match connector storage.");
  }
  const workspacePolicy = await workspacePolicyForIdentity(
    installation.installationId,
    session.user.id,
    installation,
  );
  const principal = {
    installationId: installation.installationId,
    userId: session.user.id,
    roleId: workspacePolicy.roleId,
  };
  return { installation, workspacePolicy, principal };
}

/**
 * The principal is always derived from the authenticated server session and
 * durable workspace role. There is deliberately no request-body equivalent.
 */
export async function codexManagedAppCapabilities(
  session: AuthSession,
): Promise<ConnectorCapabilitySnapshot[]> {
  const { installation, principal } = await connectorContext(session);
  if (!installation.connectors?.codexManagedAppAction) {
    return [{
      connectorId: "codex-managed-app",
      label: "Aplicación gestionada por Codex",
      status: "not_configured",
      statusCode: "CODEX_APP_ACTION_NOT_CONFIGURED",
      checkedAt: null,
      effectiveOperations: [],
      approvalRequiredOperations: [],
    }];
  }
  const registry = new ConnectorRegistry(
    new FileConnectorBindingStore(installation.installationId, installation.paths.dataRoot),
    [codexManagedAppRegistration(async (userId) => catalogTransportForUser(installation.installationId, userId))],
  );
  const catalog = await catalogRuntimeEnforcer(installation.installationId, session.user.id);
  if (!catalog.allowsConnector(CODEX_MANAGED_APP_CONNECTOR_ID)) return [];
  return registry.capabilities(principal, { allowSharedCredentials: false });
}

/** Server-only construction for legacy HTTP receipts and authenticated chat.
 * The chat runner passes its current immutable permission fingerprint. */
export async function codexManagedAppActionForSession(session: AuthSession, turn?: { permissionFingerprint: string }) {
  const { installation, workspacePolicy, principal } = await connectorContext(session);
  const config = installation.connectors?.codexManagedAppAction;
  if (!config) {
    throw new ConnectorError("CODEX_APP_ACTION_NOT_CONFIGURED", "No Codex MCP action is allowlisted for this installation.");
  }
  if (!workspacePolicy.policy.capabilities.execute) {
    throw new ConnectorError("CODEX_APP_ACTION_PERMISSION_DENIED", "Workspace policy does not permit connector execution.");
  }
  if (!(await catalogRuntimeEnforcer(installation.installationId, session.user.id)).allowsConnector(CODEX_MANAGED_APP_CONNECTOR_ID)) {
    throw new ConnectorError("CODEX_APP_ACTION_CATALOG_DENIED", "This connector is not assigned to the authenticated user.");
  }
  if (turn && !/^[a-f0-9]{64}$/.test(turn.permissionFingerprint)) {
    throw new ConnectorError("CODEX_APP_ACTION_PERMISSION_DENIED", "Turn permission fingerprint is invalid.");
  }
  const transportForUser = async (userId: string) => catalogTransportForUser(installation.installationId, userId);
  return new CodexManagedAppAction(
    new FileConnectorBindingStore(installation.installationId, installation.paths.dataRoot),
    new FileConnectorAuthorizationStore(installation.installationId, installation.paths.dataRoot),
    new FileApprovalStore({
      installationId: installation.installationId,
      userId: session.user.id,
      usersRoot: installation.paths.usersRoot,
    }),
    principal,
    config,
    transportForUser,
    turn?.permissionFingerprint ?? connectorFingerprint({ roleId: workspacePolicy.roleId, execute: workspacePolicy.policy.capabilities.execute }),
    connectorFingerprint(workspacePolicy.policy),
  );
}
