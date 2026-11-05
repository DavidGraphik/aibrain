import type { ClientRequest } from "../../contracts/codex/0.162.1/types/ClientRequest";
import type { McpServerToolCallParams } from "../../contracts/codex/0.162.1/types/v2/McpServerToolCallParams";
import type { CatalogPrincipal, CatalogState } from "@/catalog/contracts";
import { allowsCatalogOperation, catalogResourceForMcpTool, visibleCatalogResources } from "@/catalog/resolver";

export class CatalogRuntimeDeniedError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CatalogRuntimeDeniedError"; }
}

export type CatalogRuntimeTransport = {
  request(method: ClientRequest["method"], params: unknown, purpose: string, timeoutMs?: number): Promise<unknown>;
};

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function filteredByIds(response: unknown, key: "data" | "apps", ids: Set<string>) {
  if (!record(response) || !Array.isArray(response[key])) return { [key]: [] };
  return { ...response, [key]: response[key].filter((entry) => record(entry) && typeof entry.id === "string" && ids.has(entry.id)) };
}

function filteredSkills(response: unknown, ids: Set<string>) {
  if (!record(response) || !Array.isArray(response.data)) return { data: [] };
  return {
    ...response,
    data: response.data.filter(record).map((entry) => ({
      ...entry,
      skills: Array.isArray(entry.skills) ? entry.skills.filter((skill) => record(skill) && typeof skill.name === "string" && ids.has(skill.name)) : [],
    })),
  };
}

function filteredMcpStatus(response: unknown, servers: Set<string>) {
  if (!record(response)) return { data: [] };
  for (const key of ["data", "servers"] as const) {
    if (Array.isArray(response[key])) return { ...response, [key]: response[key].filter((item) => {
      if (!record(item)) return false;
      // Codex 0.162 uses name. Only fall back to the legacy server field when
      // name is absent, so a conflicting legacy alias cannot widen discovery.
      const name = item.name === undefined ? item.server : item.name;
      return typeof name === "string" && servers.has(name);
    }) };
  }
  return { data: [] };
}

/** Filters inventories and rejects unlisted MCP tools before they reach Codex. */
export class CatalogRuntimeEnforcer {
  constructor(private readonly state: CatalogState, private readonly principal: CatalogPrincipal) {}

  filterSkills(response: unknown) {
    return filteredSkills(response, new Set(visibleCatalogResources(this.state, this.principal, "skill").map(({ id }) => id)));
  }

  allowsSkill(skillId: string) {
    return visibleCatalogResources(this.state, this.principal, "skill").some(({ id }) => id === skillId);
  }

  allowsConnector(connectorId: string) {
    return visibleCatalogResources(this.state, this.principal, "connector").some((resource) => resource.connectorId === connectorId);
  }

  allowsConnectorWrite(connectorId: string) {
    return this.principal.workspaceCanExecute && visibleCatalogResources(this.state, this.principal, "connector").some(resource => resource.connectorId === connectorId && allowsCatalogOperation(this.state, this.principal, resource.id, "write"));
  }

  filterApps(response: unknown, installed = false) {
    const ids = new Set(visibleCatalogResources(this.state, this.principal, "app").flatMap(({ appId }) => appId ? [appId] : []));
    return filteredByIds(response, installed ? "apps" : "data", ids);
  }

  filterMcpStatus(response: unknown) {
    return filteredMcpStatus(response, new Set(visibleCatalogResources(this.state, this.principal, "mcp").flatMap(({ mcp }) => mcp ? [mcp.server] : [])));
  }

  assertMcpTool(params: unknown, managedApproval = false) {
    if (!record(params) || typeof params.server !== "string" || typeof params.tool !== "string") {
      throw new CatalogRuntimeDeniedError("CATALOG_MCP_REQUEST_INVALID", "MCP request is invalid.");
    }
    const decision = catalogResourceForMcpTool(this.state, this.principal, params.server, params.tool);
    if (!decision.resource || !decision.operation) {
      throw new CatalogRuntimeDeniedError("CATALOG_MCP_DENIED", "MCP server or tool is not assigned to this user.");
    }
    if (decision.operation === "write") {
      if (!this.principal.workspaceCanExecute || !allowsCatalogOperation(this.state, this.principal, decision.resource.id, "write")) {
        throw new CatalogRuntimeDeniedError("CATALOG_MCP_WRITE_DENIED", "Sensitive MCP write is not allowed by policy.");
      }
      if (!managedApproval) throw new CatalogRuntimeDeniedError("CATALOG_MCP_APPROVAL_REQUIRED", "Sensitive MCP writes require a managed approval and provider readback.");
    }
  }
}

export class CatalogEnforcedTransport implements CatalogRuntimeTransport {
  constructor(private readonly inner: CatalogRuntimeTransport, private readonly catalog: CatalogRuntimeEnforcer) {}

  async request(method: ClientRequest["method"], params: unknown, purpose: string, timeoutMs?: number) {
    if (["plugin/install", "plugin/uninstall", "skills/config/write", "skills/extraRoots/set", "mcpServer/oauth/login"].includes(method)) {
      throw new CatalogRuntimeDeniedError("CATALOG_MANAGEMENT_DENIED", "Employees cannot install, configure, or authenticate catalog resources from the runtime.");
    }
    if (method === "mcpServer/tool/call") this.catalog.assertMcpTool(
      params as McpServerToolCallParams,
      purpose === "connector-codex-action" || purpose === "connector-codex-readback",
    );
    const response = await this.inner.request(method, params, purpose, timeoutMs);
    if (method === "skills/list") return this.catalog.filterSkills(response);
    if (method === "app/list") return this.catalog.filterApps(response);
    if (method === "app/installed") return this.catalog.filterApps(response, true);
    if (method === "mcpServerStatus/list") return this.catalog.filterMcpStatus(response);
    return response;
  }
}
