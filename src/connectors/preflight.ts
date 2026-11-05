import {
  CODEX_MANAGED_APP_CONNECTOR_ID,
  CODEX_MANAGED_APP_EXECUTE_SCOPE,
  CODEX_MANAGED_APP_READ_SCOPE,
  codexManagedAppIdForBinding,
} from "@/connectors/codex-managed-app-provider";
import type { ConnectorHealthStatus, ConnectorPrincipal, CredentialBinding } from "@/connectors/contracts";
import type { InstallationConfig } from "@/config/installation-schema";
import type { McpAuthStatus } from "../../contracts/codex/0.162.1/types/v2/McpAuthStatus";

export type ConnectorPreflightCheck = {
  ok: boolean;
  code: string | null;
};

/**
 * Intentionally contains codes and booleans only. It is an operator artifact,
 * not a diagnostic dump: no identifiers, bindings, scopes, arguments, tool
 * output, or provider response may cross this boundary.
 */
export type CodexManagedAppPreflightReport = {
  schemaVersion: 1;
  ready: boolean;
  checks: {
    manifest: ConnectorPreflightCheck;
    localUser: ConnectorPreflightCheck;
    executePolicy: ConnectorPreflightCheck;
    binding: ConnectorPreflightCheck;
    app: ConnectorPreflightCheck;
    action: ConnectorPreflightCheck;
    readback: ConnectorPreflightCheck;
  };
};

type McpInventoryEntry = {
  name: string;
  tools: readonly string[];
  authStatus: McpAuthStatus;
};

export type CodexManagedAppPreflightDependencies = {
  loadInstallation: () => Promise<Readonly<InstallationConfig>>;
  readLocalUser: (installation: Readonly<InstallationConfig>, userId: string) => Promise<{ enabled: boolean } | null>;
  workspacePolicy: (installation: Readonly<InstallationConfig>, userId: string) => Promise<{
    roleId: string;
    execute: boolean;
  }>;
  resolveBinding: (installation: Readonly<InstallationConfig>, principal: ConnectorPrincipal) => Promise<CredentialBinding>;
  inspectApp: (principal: ConnectorPrincipal, binding: CredentialBinding) => Promise<{
    status: Exclude<ConnectorHealthStatus, "not_configured">;
    code: string | null;
  }>;
  listMcpInventory: (userId: string) => Promise<readonly McpInventoryEntry[]>;
};

const CHECK_OK: ConnectorPreflightCheck = { ok: true, code: null };

function failed(code: string): ConnectorPreflightCheck {
  return { ok: false, code };
}

function allFailed(code: string): CodexManagedAppPreflightReport {
  return {
    schemaVersion: 1,
    ready: false,
    checks: {
      manifest: failed(code),
      localUser: failed("PREFLIGHT_NOT_RUN"),
      executePolicy: failed("PREFLIGHT_NOT_RUN"),
      binding: failed("PREFLIGHT_NOT_RUN"),
      app: failed("PREFLIGHT_NOT_RUN"),
      action: failed("PREFLIGHT_NOT_RUN"),
      readback: failed("PREFLIGHT_NOT_RUN"),
    },
  };
}

function report(checks: CodexManagedAppPreflightReport["checks"]): CodexManagedAppPreflightReport {
  return {
    schemaVersion: 1,
    ready: Object.values(checks).every((check) => check.ok),
    checks,
  };
}

function requiredScopesPresent(binding: CredentialBinding) {
  return binding.scopes.includes(CODEX_MANAGED_APP_READ_SCOPE) &&
    binding.scopes.includes(CODEX_MANAGED_APP_EXECUTE_SCOPE);
}

type InventoryServerCheck =
  | { entry: McpInventoryEntry; authReady: boolean }
  | { entry: null; authReady: false };

function inventoryCheck(
  serverChecks: ReadonlyMap<string, InventoryServerCheck>,
  server: string,
  tool: string,
  prefix: string,
) {
  const checked = serverChecks.get(server);
  if (!checked || !checked.entry) return failed(`${prefix}_SERVER_UNAVAILABLE`);
  if (!checked.authReady) return failed(`${prefix}_AUTH_UNAVAILABLE`);
  const entry = checked.entry;
  return entry.tools.includes(tool) ? CHECK_OK : failed(`${prefix}_TOOL_UNAVAILABLE`);
}

function inventoryServerChecks(inventory: readonly McpInventoryEntry[], servers: readonly string[]) {
  const checks = new Map<string, InventoryServerCheck>();
  for (const server of servers) {
    if (checks.has(server)) continue;
    const entry = inventory.find((candidate) => candidate.name === server) ?? null;
    checks.set(server, entry
      ? { entry, authReady: entry.authStatus === "bearerToken" || entry.authStatus === "oAuth" || entry.authStatus === "unsupported" }
      : { entry: null, authReady: false });
  }
  return checks;
}

/**
 * Read-only readiness gate for the fixed Codex App/MCP action. Dependencies
 * deliberately return reduced data, so a provider response cannot be emitted
 * accidentally by the CLI or tests.
 */
export async function runCodexManagedAppPreflight(
  userId: string,
  dependencies: CodexManagedAppPreflightDependencies,
): Promise<CodexManagedAppPreflightReport> {
  let installation: Readonly<InstallationConfig>;
  try {
    installation = await dependencies.loadInstallation();
  } catch {
    return allFailed("INSTALLATION_CONFIG_UNAVAILABLE");
  }

  const config = installation.connectors?.codexManagedAppAction;
  if (!config) return allFailed("CODEX_APP_ACTION_NOT_CONFIGURED");

  let localUser: { enabled: boolean } | null;
  try {
    localUser = await dependencies.readLocalUser(installation, userId);
  } catch {
    return report({
      manifest: CHECK_OK,
      localUser: failed("LOCAL_USER_UNAVAILABLE"),
      executePolicy: failed("PREFLIGHT_NOT_RUN"), binding: failed("PREFLIGHT_NOT_RUN"),
      app: failed("PREFLIGHT_NOT_RUN"), action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }
  if (!localUser?.enabled) {
    return report({
      manifest: CHECK_OK,
      localUser: failed("LOCAL_USER_NOT_ENABLED"),
      executePolicy: failed("PREFLIGHT_NOT_RUN"), binding: failed("PREFLIGHT_NOT_RUN"),
      app: failed("PREFLIGHT_NOT_RUN"), action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }

  let policy: { roleId: string; execute: boolean };
  try {
    policy = await dependencies.workspacePolicy(installation, userId);
  } catch {
    return report({
      manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: failed("WORKSPACE_POLICY_UNAVAILABLE"),
      binding: failed("PREFLIGHT_NOT_RUN"), app: failed("PREFLIGHT_NOT_RUN"),
      action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }
  if (!policy.execute) {
    return report({
      manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: failed("CODEX_APP_ACTION_PERMISSION_DENIED"),
      binding: failed("PREFLIGHT_NOT_RUN"), app: failed("PREFLIGHT_NOT_RUN"),
      action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }

  const principal: ConnectorPrincipal = { installationId: installation.installationId, userId, roleId: policy.roleId };
  let binding: CredentialBinding;
  try {
    binding = await dependencies.resolveBinding(installation, principal);
  } catch {
    return report({
      manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: CHECK_OK,
      binding: failed("CODEX_APP_PERSONAL_BINDING_UNAVAILABLE"), app: failed("PREFLIGHT_NOT_RUN"),
      action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }
  if (binding.installationId !== principal.installationId || binding.userId !== principal.userId || binding.connectorId !== CODEX_MANAGED_APP_CONNECTOR_ID) {
    return report({
      manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: CHECK_OK,
      binding: failed("CODEX_APP_PERSONAL_BINDING_MISMATCH"), app: failed("PREFLIGHT_NOT_RUN"),
      action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }
  try {
    if (codexManagedAppIdForBinding(binding.credentialRef) !== config.appId) {
      return report({
        manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: CHECK_OK,
        binding: failed("CODEX_APP_PERSONAL_BINDING_MISMATCH"), app: failed("PREFLIGHT_NOT_RUN"),
        action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
      });
    }
  } catch {
    return report({
      manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: CHECK_OK,
      binding: failed("CODEX_APP_PERSONAL_BINDING_MISMATCH"), app: failed("PREFLIGHT_NOT_RUN"),
      action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }
  if (binding.status !== "active") {
    return report({
      manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: CHECK_OK,
      binding: failed(binding.status === "revoked" ? "CODEX_APP_BINDING_REVOKED" : "CODEX_APP_BINDING_REAUTH_REQUIRED"), app: failed("PREFLIGHT_NOT_RUN"),
      action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }
  if (!requiredScopesPresent(binding)) {
    return report({
      manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: CHECK_OK,
      binding: failed("CODEX_APP_MINIMUM_SCOPE_MISSING"), app: failed("PREFLIGHT_NOT_RUN"),
      action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }

  let app: { status: Exclude<ConnectorHealthStatus, "not_configured">; code: string | null };
  try {
    app = await dependencies.inspectApp(principal, binding);
  } catch {
    return report({
      manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: CHECK_OK, binding: CHECK_OK,
      app: failed("CODEX_APP_HEALTH_UNAVAILABLE"), action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }
  if (app.status !== "connected") {
    const appCode = app.code === "CODEX_APP_NOT_INSTALLED" || app.code === "CODEX_APP_DISABLED" || app.code === "CODEX_APP_NOT_CALLABLE"
      ? app.code
      : "CODEX_APP_NOT_CONNECTED";
    return report({
      manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: CHECK_OK, binding: CHECK_OK,
      app: failed(appCode),
      action: failed("PREFLIGHT_NOT_RUN"), readback: failed("PREFLIGHT_NOT_RUN"),
    });
  }

  let inventory: readonly McpInventoryEntry[];
  try {
    inventory = await dependencies.listMcpInventory(userId);
  } catch {
    return report({
      manifest: CHECK_OK, localUser: CHECK_OK, executePolicy: CHECK_OK, binding: CHECK_OK, app: CHECK_OK,
      action: failed("MCP_INVENTORY_UNAVAILABLE"), readback: failed("MCP_INVENTORY_UNAVAILABLE"),
    });
  }
  // Each configured server is evaluated at most once. `unsupported` is the
  // generated contract's explicit no-auth state; unknown and notLoggedIn are
  // intentionally not treated as an implicit public-server exemption.
  const serverChecks = inventoryServerChecks(inventory, [config.server, config.readback.server]);
  return report({
    manifest: CHECK_OK,
    localUser: CHECK_OK,
    executePolicy: CHECK_OK,
    binding: CHECK_OK,
    app: CHECK_OK,
    action: inventoryCheck(serverChecks, config.server, config.tool, "MCP_ACTION"),
    readback: inventoryCheck(serverChecks, config.readback.server, config.readback.tool, "MCP_READBACK"),
  });
}

export function unavailableCodexManagedAppPreflight(): CodexManagedAppPreflightReport {
  return allFailed("INSTALLATION_CONFIG_UNAVAILABLE");
}
