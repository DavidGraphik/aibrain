import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { FileConnectorBindingStore } from "@/connectors/binding-store";
import {
  CODEX_MANAGED_APP_CONNECTOR_ID,
  CodexManagedAppProvider,
  type CodexInstalledAppTransport,
} from "@/connectors/codex-managed-app-provider";
import type { CodexManagedAppPreflightDependencies } from "@/connectors/preflight";
import { loadInstallationConfig } from "@/config/installation";
import type { McpAuthStatus } from "../../contracts/codex/0.162.1/types/v2/McpAuthStatus";
import { workerAppServerForUser } from "@/runtime/worker-runtime-service";

function isMcpAuthStatus(value: unknown): value is McpAuthStatus {
  return value === "unknown" || value === "unsupported" || value === "notLoggedIn" || value === "bearerToken" || value === "oAuth";
}

function parseMcpInventory(value: unknown) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) {
    throw new Error("MCP inventory response is invalid.");
  }
  return (value as { data: unknown[] }).data.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as { name?: unknown; tools?: unknown; authStatus?: unknown };
    if (typeof record.name !== "string" || !record.tools || typeof record.tools !== "object" || Array.isArray(record.tools) || !isMcpAuthStatus(record.authStatus)) return [];
    return [{
      name: record.name,
      tools: Object.keys(record.tools as Record<string, unknown>),
      authStatus: record.authStatus,
    }];
  });
}

/** Privileged Node assembly used only by the operator CLI. */
export function codexManagedAppPreflightRuntimeDependencies(): CodexManagedAppPreflightDependencies {
  const transportForUser = async (userId: string): Promise<CodexInstalledAppTransport> => (await workerAppServerForUser(userId)).client;
  const provider = new CodexManagedAppProvider(transportForUser);
  return {
    loadInstallation: loadInstallationConfig,
    readLocalUser: async (installation, userId) => new FileLocalUserStore(installation.paths.usersRoot).read(userId),
    workspacePolicy: async (installation, userId) => {
      const effective = await workspacePolicyForIdentity(installation.installationId, userId, installation);
      return { roleId: effective.roleId, execute: effective.policy.capabilities.execute };
    },
    resolveBinding: async (installation, principal) => new FileConnectorBindingStore(principal.installationId, installation.paths.dataRoot)
      .resolve(principal, CODEX_MANAGED_APP_CONNECTOR_ID, { allowShared: false }),
    inspectApp: async (principal, binding) => {
      const inspected = await provider.inspect({ principal, binding });
      return { status: inspected.health.status, code: inspected.health.code };
    },
    listMcpInventory: async (userId) => parseMcpInventory(await (await transportForUser(userId)).request(
      "mcpServerStatus/list",
      { detail: "toolsAndAuthOnly", threadId: null },
      "connector-codex-app-preflight-mcp-inventory",
      10_000,
    )),
  };
}
