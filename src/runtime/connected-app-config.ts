export const SERVER_APPROVALS_REVIEWER = "auto_review";

const applied = new WeakMap<object, Map<string, string>>();
const fingerprint = (appIds: readonly string[]) => JSON.stringify([...new Set(appIds)].sort());

/** The complete inventory replaces the previous configuration, including when
 * the final connection is removed. An unknown/restarted worker must resume
 * once before its loaded configuration can be reused. */
export function connectedAppConfig(appIds: readonly string[]) {
  return {
    apps: {
      _default: {
        enabled: false,
        approvals_reviewer: SERVER_APPROVALS_REVIEWER,
        destructive_enabled: false,
        open_world_enabled: false,
        default_tools_approval_mode: "writes",
      },
      ...Object.fromEntries([...new Set(appIds)].map((id) => [id, {
        enabled: true,
        approvals_reviewer: SERVER_APPROVALS_REVIEWER,
        destructive_enabled: false,
        open_world_enabled: false,
        default_tools_approval_mode: "writes",
        default_tools_enabled: true,
        tools: null,
      }])),
    },
  };
}

export function markConnectedAppConfigApplied(client: object, threadId: string, appIds: readonly string[]) {
  let threads = applied.get(client);
  if (!threads) { threads = new Map(); applied.set(client, threads); }
  threads.set(threadId, fingerprint(appIds));
}

export function hasAppliedConnectedAppConfig(client: object, threadId: string, appIds: readonly string[]) {
  return applied.get(client)?.get(threadId) === fingerprint(appIds);
}
