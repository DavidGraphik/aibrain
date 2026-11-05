export const SERVER_APPROVALS_REVIEWER = "auto_review";

const applied = new WeakMap<object, Map<string, string>>();
export type NativeAppToolPolicies = Record<string, { allowed: readonly string[]; known: readonly string[] }>;
const fingerprint = (appIds: readonly string[], mcp: Record<string, boolean | string[]> = {}, tools: NativeAppToolPolicies = {}) => JSON.stringify({
  apps: [...new Set(appIds)].sort(), mcp: Object.entries(mcp).sort(([left], [right]) => left.localeCompare(right)),
  tools: Object.entries(tools).sort(([left], [right]) => left.localeCompare(right))
    .map(([id, policy]) => [id, [...policy.allowed].sort(), [...policy.known].sort()]),
});

/** The complete inventory replaces the previous configuration, including when
 * the final connection is removed. An unknown/restarted worker must resume
 * once before its loaded configuration can be reused. */
export function connectedAppConfig(appIds: readonly string[], toolPolicies?: NativeAppToolPolicies) {
  const permittedApps = new Set(appIds);
  const allApps = [...new Set([...appIds, ...Object.keys(toolPolicies ?? {})])].filter(id => id !== "_default");
  return {
    apps: {
      _default: {
        enabled: false,
        approvals_reviewer: SERVER_APPROVALS_REVIEWER,
        destructive_enabled: false,
        open_world_enabled: false,
        default_tools_approval_mode: "writes",
      },
      ...Object.fromEntries(allApps.map((id) => [id, {
        // No metadata/allowed tools means no callable app. Explicitly disable
        // old app entries: `_default.enabled=false` cannot override them.
        enabled: permittedApps.has(id) && (toolPolicies?.[id]?.allowed.length ?? 0) > 0,
        approvals_reviewer: SERVER_APPROVALS_REVIEWER,
        destructive_enabled: false,
        open_world_enabled: false,
        default_tools_approval_mode: "writes",
        default_tools_enabled: false,
        // Per-tool entries override default_tools_enabled. Include negative
        // overrides for all observed and previously configured tools so a
        // lower config layer cannot retain a formerly granted write.
        tools: Object.fromEntries([...new Set([...(toolPolicies?.[id]?.known ?? []), ...(toolPolicies?.[id]?.allowed ?? [])])]
          .map(name => [name, { enabled: permittedApps.has(id) && (toolPolicies?.[id]?.allowed.includes(name) ?? false), approval_mode: "writes" }])),
      }])),
    },
  };
}

export function markConnectedAppConfigApplied(client: object, threadId: string, appIds: readonly string[], mcp?: Record<string, boolean | string[]>, tools?: NativeAppToolPolicies) {
  let threads = applied.get(client);
  if (!threads) { threads = new Map(); applied.set(client, threads); }
  threads.set(threadId, fingerprint(appIds, mcp, tools));
}

export function hasAppliedConnectedAppConfig(client: object, threadId: string, appIds: readonly string[], mcp?: Record<string, boolean | string[]>, tools?: NativeAppToolPolicies) {
  return applied.get(client)?.get(threadId) === fingerprint(appIds, mcp, tools);
}
