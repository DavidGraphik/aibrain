import {
  type CatalogOperation,
  type CatalogPrincipal,
  type CatalogResource,
  type CatalogRule,
  type CatalogState,
} from "@/catalog/contracts";

const precedence = ["user", "group", "role", "installation"] as const;

function applies(rule: CatalogRule, principal: CatalogPrincipal) {
  if (rule.scope === "installation") return true;
  if (rule.scope === "role") return rule.subjectId === principal.roleId;
  if (rule.scope === "group") return rule.subjectId !== null && principal.groupIds.includes(rule.subjectId);
  return rule.subjectId === principal.userId;
}

/**
 * The first matching scope wins: user, then group (a deny wins ties), role,
 * then installation. An absent rule is always a denial.
 */
export function allowsCatalogOperation(
  state: CatalogState,
  principal: CatalogPrincipal,
  resourceId: string,
  operation: CatalogOperation,
) {
  if (state.installationId !== principal.installationId) return false;
  for (const scope of precedence) {
    const matching = state.rules.filter((rule) => rule.resourceId === resourceId && rule.scope === scope &&
      rule.operations.includes(operation) && applies(rule, principal));
    if (matching.length === 0) continue;
    return !matching.some((rule) => rule.effect === "deny");
  }
  return false;
}

export function visibleCatalogResources(state: CatalogState, principal: CatalogPrincipal, kind?: CatalogResource["kind"]) {
  return state.resources.filter((resource) => (!kind || resource.kind === kind) &&
    allowsCatalogOperation(state, principal, resource.id, "read"));
}

export function catalogResourceForApp(state: CatalogState, principal: CatalogPrincipal, appId: string) {
  return visibleCatalogResources(state, principal, "app").find((resource) => resource.appId === appId) ?? null;
}

export function catalogResourceForConnector(state: CatalogState, principal: CatalogPrincipal, connectorId: string) {
  return visibleCatalogResources(state, principal, "connector").find((resource) => resource.connectorId === connectorId) ?? null;
}

export function catalogResourceForMcpTool(state: CatalogState, principal: CatalogPrincipal, server: string, tool: string) {
  const resource = visibleCatalogResources(state, principal, "mcp")
    .find((candidate) => candidate.mcp?.server === server &&
      (candidate.mcp.readTools.includes(tool) || candidate.mcp.sensitiveWriteTools.includes(tool))) ?? null;
  if (!resource || !resource.mcp) return { resource: null, operation: null as CatalogOperation | null };
  return { resource, operation: resource.mcp.sensitiveWriteTools.includes(tool) ? "write" as const : "read" as const };
}
