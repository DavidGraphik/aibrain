export type PermissionScope =
  | "installation"
  | "role"
  | "project"
  | "user"
  | "user-project";

export type PermissionAction = "consult" | "respond" | "execute" | "publish";
export type PermissionEffect = "allow" | "deny";

export type PermissionRule = {
  ruleId: string;
  action: PermissionAction;
  effect: PermissionEffect;
  instruction: string;
};

export type PermissionPolicyDocument = {
  schemaVersion: 1;
  policyVersion: number;
  scope: PermissionScope;
  installationId: string;
  roleId?: string;
  projectId?: string;
  userId?: string;
  rules: readonly PermissionRule[];
};

export type PermissionResolutionContext = {
  turnId: string;
  roleId: string | null;
  projectId: string | null;
};

export type ResolvedPermissionSource = {
  scope: PermissionScope;
  precedence: number;
  policyVersion: number;
  fingerprint: string;
};

export type ResolvedPermissionRule = PermissionRule & {
  sourceScope: PermissionScope;
  sourcePolicyVersion: number;
  precedence: number;
};

export type ResolvedPermissions = {
  schemaVersion: 1;
  installationId: string;
  userId: string;
  roleId: string | null;
  projectId: string | null;
  turnId: string;
  resolvedAt: string;
  fingerprint: string;
  sources: readonly ResolvedPermissionSource[];
  rules: readonly ResolvedPermissionRule[];
  developerInstructions: string;
};

export type PermissionResolutionAuditSource = {
  scope: PermissionScope;
  precedence: number;
  policyVersion: number;
  fingerprint: string;
};

type PermissionResolutionAuditBase = {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  turnId: string;
  installationId: string;
  userId: string;
  roleId: string | null;
  projectId: string | null;
};

export type PermissionResolutionAuditEvent = PermissionResolutionAuditBase & (
  | {
    outcome: "resolved";
    fingerprint: string;
    effectiveRuleCount: number;
    sources: readonly PermissionResolutionAuditSource[];
  }
  | {
    outcome: "rejected";
    errorCode: string;
    sources: readonly PermissionResolutionAuditSource[];
  }
);

export interface PermissionResolutionAuditSink {
  record(event: PermissionResolutionAuditEvent): Promise<void>;
}

export interface PermissionProvider {
  resolveForUser(
    installationId: string,
    userId: string,
    context: PermissionResolutionContext,
  ): Promise<ResolvedPermissions>;
}
