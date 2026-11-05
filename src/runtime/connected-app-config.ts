export const SERVER_APPROVALS_REVIEWER = "auto_review";

export type NativeAppToolPolicies = Record<string, { allowed: readonly string[]; known: readonly string[] }>;
const applied = new WeakMap<object, Map<string, { fingerprint: string; known: NativeAppToolPolicies }>>();
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
  const callable = allApps.some(id => permittedApps.has(id) && (toolPolicies?.[id]?.allowed.length ?? 0) > 0);
  return {
    // Set both states explicitly: a reconnect must replace the preceding
    // thread's feature=false. The caller admits tools only from a complete
    // currently callable inventory; host analysis can still disable it later.
    "features.apps": callable,
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
  const previous = threads.get(threadId)?.known ?? {};
  const ids = [...new Set([...appIds, ...Object.keys(previous), ...Object.keys(tools ?? {})])];
  const known: NativeAppToolPolicies = Object.fromEntries(ids.map(id => [id, { allowed: [], known: [...new Set([
    ...(previous[id]?.known ?? []), ...(tools?.[id]?.known ?? []), ...(tools?.[id]?.allowed ?? []),
  ])].sort() }]));
  threads.set(threadId, { fingerprint: fingerprint(appIds, mcp, tools), known });
}

export function hasAppliedConnectedAppConfig(client: object, threadId: string, appIds: readonly string[], mcp?: Record<string, boolean | string[]>, tools?: NativeAppToolPolicies) {
  return applied.get(client)?.get(threadId)?.fingerprint === fingerprint(appIds, mcp, tools);
}

/** Negative knowledge only: a loaded thread can retain overrides absent from
 * base config. Never carry a previous grant into the next turn's policy. */
export function previousConnectedAppPolicies(client: object, threadId: string | null): NativeAppToolPolicies {
  const previous = threadId ? applied.get(client)?.get(threadId)?.known : null;
  return Object.fromEntries(Object.entries(previous ?? {}).map(([id, policy]) => [id, { allowed: [], known: [...policy.known] }]));
}
