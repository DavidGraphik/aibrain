import type { WorkspaceGroup } from "@/admin/contracts";
import type { LocalUser } from "@/auth/local-user-store";
import type { AutomationAudience } from "@/automations/contracts";

function identityKey(user: Pick<LocalUser, "email">) {
  return user.email.trim().toLocaleLowerCase("en-US");
}

/**
 * Legacy provisioning could leave two local UUIDs for the same normalized
 * email. Automation selectors represent people, so expose one canonical
 * enabled identity per email. Authorization remains bound to exact UUIDs.
 */
export function canonicalAutomationUsers(
  users: readonly LocalUser[],
  preferredUserId?: string,
) {
  const canonical = new Map<string, LocalUser>();
  for (const user of users) {
    const key = identityKey(user);
    const current = canonical.get(key);
    if (!current) {
      canonical.set(key, user);
      continue;
    }
    const useCandidate = user.userId === preferredUserId || (
      current.userId !== preferredUserId && (
        Number(user.enabled) > Number(current.enabled) ||
        (user.enabled === current.enabled && user.displayName.trim().length > current.displayName.trim().length) ||
        (user.enabled === current.enabled && user.displayName.trim().length === current.displayName.trim().length &&
          user.userId.localeCompare(current.userId) < 0)
      )
    );
    if (useCandidate) canonical.set(key, user);
  }
  return [...canonical.values()];
}

export function canonicalizeAutomationAudience(
  audience: AutomationAudience,
  users: readonly LocalUser[],
  preferredUserId?: string,
): AutomationAudience {
  const usersById = new Map(users.map((user) => [user.userId, user]));
  const canonicalByIdentity = new Map(
    canonicalAutomationUsers(users, preferredUserId).map((user) => [identityKey(user), user.userId]),
  );
  return {
    membershipPolicy: "current",
    userIds: [...new Set(audience.userIds.map((id) => {
      const user = usersById.get(id);
      return user ? canonicalByIdentity.get(identityKey(user)) ?? id : id;
    }))],
    groupIds: [...new Set(audience.groupIds)],
  };
}

export function invalidAutomationAudienceTargets(
  audience: AutomationAudience,
  users: readonly LocalUser[],
  groups: readonly WorkspaceGroup[],
) {
  const enabledUserIds = new Set(users.filter(({ enabled }) => enabled).map(({ userId }) => userId));
  const groupIds = new Set(groups.map(({ id }) => id));
  return {
    userIds: audience.userIds.filter((id) => !enabledUserIds.has(id)),
    groupIds: audience.groupIds.filter((id) => !groupIds.has(id)),
  };
}

/** Resolves selectors against current workspace membership. Direct and group
 * recipients are deduplicated, and disabled/deleted users fail closed. */
export function resolveCurrentAutomationAudience(
  audience: AutomationAudience,
  users: readonly LocalUser[],
  groups: readonly WorkspaceGroup[],
) {
  const enabledUsers = users.filter(({ enabled }) => enabled);
  const enabledUserIds = new Set(enabledUsers.map(({ userId }) => userId));
  const selectedUserIds = new Set(audience.userIds.filter((id) => enabledUserIds.has(id)));
  const selectedGroups = new Set(audience.groupIds);
  for (const group of groups) {
    if (!selectedGroups.has(group.id)) continue;
    for (const memberId of group.memberIds) {
      if (enabledUserIds.has(memberId)) selectedUserIds.add(memberId);
    }
  }
  // Authorization is always UUID-bound. Email canonicalization is a write-time
  // and selector-display concern; applying it for the viewer would grant a
  // recreated account access to results addressed to an older UUID.
  return selectedUserIds;
}
