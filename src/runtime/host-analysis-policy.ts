export type HostAnalysisPolicy = { businessReads: boolean; webSearch: boolean; onViolation?: () => void;
  supportPreview?: { installationId:string; userId:string; sessionHash:string; supportActorEmail:string; supportExpiresAt:string; publicThreadId:string; previewAppId:string } };
const reads = new Set(["attio_search", "attio_notes", "attio_deals", "attio_tasks", "attio_members", "sibema_read", "sibema_accounting_summary"]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safePath(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && value.startsWith("/") && !/[?%#\\\x00-\x1f]/.test(value) && !value.includes("..");
}
function sibemaReadAllowed(arguments_: unknown) {
  if (!record(arguments_)) return false;
  const command = arguments_.command;
  if (command === "catalog") {
    return Object.keys(arguments_).every(key => ["command", "references"].includes(key)) &&
      (arguments_.references === undefined || Array.isArray(arguments_.references) && arguments_.references.length <= 100 && arguments_.references.every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f%_]/.test(value)));
  }
  if (!["discover", "schema", "read"].includes(String(command))) return false;
  // A read-shaped discovery mistake is recoverable argument validation, not an
  // attempted mutation. Let the authenticated adapter explain the right command
  // before dispatch; retain the GET/path/key ceiling so writes still abort.
  const keys = command === "read" || command === "discover" ? ["command", "method", "path", "query"] : ["command", "method", "path"];
  return Object.keys(arguments_).every(key => keys.includes(key)) &&
    (arguments_.method === undefined || arguments_.method === "GET") &&
    (arguments_.path === undefined ? command === "discover" : safePath(arguments_.path)) &&
    (arguments_.query === undefined || record(arguments_.query));
}
export function hostAnalysisToolAllowed(policy: HostAnalysisPolicy, namespace: unknown, tool: unknown, arguments_?: unknown) {
  if (policy.supportPreview) return namespace === "aibrain_g03_production" && (tool === "read" || tool === "mutate");
  return namespace === "aibrain_documents" && tool === "inspect_attachment" ||
    policy.businessReads && namespace === "trinalum_business" && typeof tool === "string" &&
      (reads.has(tool) || tool === "sibema_api" && sibemaReadAllowed(arguments_));
}
export function hostAnalysisConfig(policy: HostAnalysisPolicy, mcpServers: string[]) {
  return {
    web_search: !policy.supportPreview && policy.webSearch ? "live" : "disabled",
    "features.shell_tool": false,
    "features.apps": false,
    "features.browser_use": false,
    "features.multi_agent": false,
    apps: { _default: { enabled: false } },
    ...Object.fromEntries(mcpServers.map(name => [`mcp_servers.${name}.enabled`, false])),
  };
}
