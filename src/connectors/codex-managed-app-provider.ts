import { createHash } from "node:crypto";
import { assertBindingAccess, credentialBindingFingerprint } from "@/connectors/authorization";
import {
  ConnectorError,
  type ConnectorCredentialHandle,
  type ConnectorDefinition,
  type ConnectorPrincipal,
  type ConnectorProviderHealth,
  type CredentialBinding,
} from "@/connectors/contracts";
import type { ConnectorCredentialProvider, RegisteredConnector } from "@/connectors/registry";
import type { McpServerToolCallParams } from "../../contracts/codex/0.162.1/types/v2/McpServerToolCallParams";
import type { ListMcpServerStatusParams } from "../../contracts/codex/0.162.1/types/v2/ListMcpServerStatusParams";

export const CODEX_MANAGED_APP_CONNECTOR_ID = "codex-managed-app";
export const CODEX_MANAGED_APP_READ_SCOPE = "app.installed.read";
export const CODEX_MANAGED_APP_EXECUTE_SCOPE = "mcp.tool.call";

const CREDENTIAL_REF_PREFIX = "codex-app:";
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const codexManagedAppDefinition: ConnectorDefinition = {
  id: CODEX_MANAGED_APP_CONNECTOR_ID,
  label: "Aplicación gestionada por Codex",
  operations: [{
    id: "read-availability",
    requiredScopes: [CODEX_MANAGED_APP_READ_SCOPE],
    mutating: false,
    approval: "never",
  }, {
    id: "execute-allowlisted-action",
    requiredScopes: [CODEX_MANAGED_APP_READ_SCOPE, CODEX_MANAGED_APP_EXECUTE_SCOPE],
    mutating: true,
    approval: "required",
  }],
};

export type CodexInstalledAppTransport = {
  request(
    method: "app/installed",
    params: { forceRefresh: false },
    purpose: string,
    timeoutMs?: number,
  ): Promise<unknown>;
  request(
    method: "mcpServer/tool/call",
    params: McpServerToolCallParams,
    purpose: string,
    timeoutMs?: number,
  ): Promise<unknown>;
  request(
    method: "mcpServerStatus/list",
    params: ListMcpServerStatusParams,
    purpose: string,
    timeoutMs?: number,
  ): Promise<unknown>;
};

type InstalledApp = {
  id: string;
  enabled: boolean;
  callable: boolean;
};

function parseCredentialRef(credentialRef: string) {
  const appId = credentialRef.startsWith(CREDENTIAL_REF_PREFIX)
    ? credentialRef.slice(CREDENTIAL_REF_PREFIX.length)
    : "";
  if (!APP_ID.test(appId)) {
    throw new ConnectorError("CODEX_APP_CREDENTIAL_REF_INVALID", "Codex app credential reference is invalid.");
  }
  return appId;
}

export function codexManagedAppIdForBinding(credentialRef: string) {
  return parseCredentialRef(credentialRef);
}

function parseInstalledApps(value: unknown): InstalledApp[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { apps?: unknown }).apps)) {
    throw new ConnectorError("CODEX_APP_RESPONSE_INVALID", "Codex did not return an installed-app snapshot.");
  }
  const result: InstalledApp[] = [];
  for (const candidate of (value as { apps: unknown[] }).apps) {
    if (!candidate || typeof candidate !== "object") continue;
    const app = candidate as { id?: unknown; enabled?: unknown; callable?: unknown };
    if (typeof app.id !== "string" || !APP_ID.test(app.id) ||
        typeof app.enabled !== "boolean" || typeof app.callable !== "boolean") continue;
    result.push({ id: app.id, enabled: app.enabled, callable: app.callable });
  }
  return result;
}

function handleFor(binding: CredentialBinding): ConnectorCredentialHandle {
  return {
    // Never return the opaque provider reference. This handle is deterministic
    // only for the current durable binding and is not an OAuth credential.
    handleId: `codex-app-handle:${createHash("sha256").update(binding.credentialRef).digest("hex")}`,
    bindingFingerprint: credentialBindingFingerprint(binding),
    bindingVersion: binding.version,
  };
}

/**
 * Server-only adapter for the App Server's already authenticated App/MCP
 * surface. It receives neither OAuth tokens nor callback parameters: Codex is
 * the only party that owns its own connection lifecycle. A future Auth-owned
 * handoff may call mcpServer/oauth/login, but no connector mutation is exposed
 * until that contract provides the approval receipt and durable audit path.
 */
export class CodexManagedAppProvider implements ConnectorCredentialProvider {
  constructor(
    private readonly transportForUser: (userId: string) => Promise<CodexInstalledAppTransport>,
    private readonly now: () => number = Date.now,
  ) {}

  async inspect(input: {
    principal: ConnectorPrincipal;
    binding: CredentialBinding;
  }): Promise<{ handle: ConnectorCredentialHandle; health: ConnectorProviderHealth }> {
    if (input.binding.connectorId !== CODEX_MANAGED_APP_CONNECTOR_ID) {
      throw new ConnectorError("CODEX_APP_BINDING_CONNECTOR_MISMATCH", "Codex app binding has another connector.");
    }
    // Codex account state is per worker user. Shared bindings would let one
    // employee inspect another employee's authenticated App Server session.
    if (input.binding.userId === null) {
      throw new ConnectorError("CODEX_APP_SHARED_BINDING_DENIED", "Codex app bindings must be personal.");
    }
    assertBindingAccess(input.principal, input.binding, { allowShared: false });
    if (!input.binding.scopes.includes(CODEX_MANAGED_APP_READ_SCOPE)) {
      throw new ConnectorError("CONNECTOR_SCOPE_MISSING", "Codex app availability scope is missing.");
    }
    const appId = parseCredentialRef(input.binding.credentialRef);
    const transport = await this.transportForUser(input.principal.userId);
    const apps = parseInstalledApps(await transport.request(
      "app/installed",
      { forceRefresh: false },
      "connector-codex-app-list",
      10_000,
    ));
    const app = apps.find((candidate) => candidate.id === appId);
    const checkedAt = new Date(this.now()).toISOString();
    if (!app) {
      return { handle: handleFor(input.binding), health: { status: "reauth_required", checkedAt, code: "CODEX_APP_NOT_INSTALLED" } };
    }
    if (!app.enabled) {
      return { handle: handleFor(input.binding), health: { status: "degraded", checkedAt, code: "CODEX_APP_DISABLED" } };
    }
    if (!app.callable) {
      return { handle: handleFor(input.binding), health: { status: "reauth_required", checkedAt, code: "CODEX_APP_NOT_CALLABLE" } };
    }
    return { handle: handleFor(input.binding), health: { status: "connected", checkedAt, code: null } };
  }

  async revoke(): Promise<void> {
    // ConnectorRegistry revokes the local binding before this call. External
    // Codex-managed OAuth revocation waits for the Auth approval/audit contract.
    throw new ConnectorError("CODEX_APP_EXTERNAL_REVOKE_PENDING", "External Codex app revocation is not connected yet.");
  }
}

export function codexManagedAppRegistration(
  transportForUser: (userId: string) => Promise<CodexInstalledAppTransport>,
): RegisteredConnector {
  return {
    definition: codexManagedAppDefinition,
    credentialProvider: new CodexManagedAppProvider(transportForUser),
  };
}
