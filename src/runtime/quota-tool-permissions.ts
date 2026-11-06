import { createHash } from "node:crypto";
import path from "node:path";

type FileAccess = "read" | "write" | "deny";
type Profile = { extends: string; filesystem: Record<string, FileAccess> };

export type QuotaToolPermissions = {
  workspace: string;
  readOnlyId: string;
  workspaceWriteId: string;
  config: { default_permissions: string; permissions: Record<string, Profile> };
};

const attestedThreads = new WeakMap<object, Map<string, string>>();

/** Production uses hosted API authentication; explicit API mode has the same
 * privacy boundary in development. Keep legacy personal development compatible. */
export function privateCodexToolPermissionsRequired(
  config: { installationId?: unknown; usageLimits?: unknown },
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return environment.NODE_ENV === "production" || environment.AIBRAIN_MODEL_AUTH?.trim() === "server-api-key"
    || ["modtime", "trinalum-production"].includes(String(config.installationId)) || Boolean(config.usageLimits);
}

/** The model's subprocess policy; App Server itself retains its private state. */
export function createQuotaToolPermissions(roots: {
  workspace: string;
  codexHome: string;
  transportAudit: string;
}): QuotaToolPermissions {
  if (Object.values(roots).some((root) => typeof root !== "string" || !path.isAbsolute(root) || root === "/")) {
    throw new Error("No se ha podido verificar el espacio privado del asistente.");
  }
  const workspace = path.resolve(roots.workspace);
  const codexHome = path.resolve(roots.codexHome);
  const transportAudit = path.resolve(roots.transportAudit);
  // Changing the private boundary must invalidate cached native attestations.
  const fingerprint = createHash("sha256").update(JSON.stringify([2, codexHome, transportAudit])).digest("hex").slice(0, 24);
  // Deny the private stores individually: a denied CODEX_HOME parent breaks
  // Linux sandbox helper dispatch even when its child is allowed. Avoid broad
  // recursive metadata globs, which also collide with the denied directories.
  const privatePaths = [
    "sessions", "archived_sessions", "log", "logs", "memories",
    "history.jsonl", "session_index.jsonl", "config.toml", "auth.json*",
    ".credentials.json*", "mcp-oauth-locks",
    ...["state_", "logs_", "goals_", "memories_", "queue_", "thread_history_"]
      .map((prefix) => `${prefix}*.sqlite*`),
  ];
  const privateStores = Object.fromEntries(privatePaths.map((entry) => [path.join(codexHome, entry), "deny" as const]));
  const readOnlyId = `aibrain-quota-read-${fingerprint}`;
  const workspaceWriteId = `aibrain-quota-write-${fingerprint}`;
  return {
    workspace, readOnlyId, workspaceWriteId,
    config: {
      default_permissions: readOnlyId,
      permissions: {
        [readOnlyId]: {
          extends: ":read-only",
          filesystem: {
            "/etc/aibrain": "deny",
            ...privateStores,
            [transportAudit]: "deny",
            [path.join(codexHome, "skills")]: "read",
            [path.join(codexHome, "plugins")]: "read",
            [path.join(codexHome, "tmp", "arg0")]: "read",
          },
        },
        [workspaceWriteId]: {
          extends: readOnlyId,
          // Privacy-protected turns supply only the exact legacy writable root
          // as runtimeWorkspaceRoots, never artifact/user metadata roots.
          filesystem: { ":workspace_roots": "write", ":tmpdir": "write", ":slash_tmp": "write" },
        },
      },
    },
  };
}

/** Startup overrides survive the engine's per-turn profile re-resolution. */
export function quotaToolPermissionConfigOverrides(roots: { codexHome: string; transportAudit: string }) {
  const policy = createQuotaToolPermissions({ ...roots, workspace: "/quota-profile-context" });
  const toml = (value: string | Record<string, unknown>): string => typeof value === "string"
    ? JSON.stringify(value)
    : `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}=${toml(entry as string | Record<string, unknown>)}`).join(",")}}`;
  return [
    `default_permissions=${toml(policy.config.default_permissions)}`,
    `permissions=${toml(policy.config.permissions)}`,
  ];
}

export function quotaToolPermissionId(policy: QuotaToolPermissions, mode: string) {
  return mode === "read-only" ? policy.readOnlyId : policy.workspaceWriteId;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function attestQuotaToolPermissions(client: object, result: unknown, policy: QuotaToolPermissions) {
  const profile = record(result) && record(result.activePermissionProfile) ? result.activePermissionProfile.id : null;
  const threadId = record(result) && record(result.thread) ? result.thread.id : null;
  if (!record(result) || typeof result.cwd !== "string" || path.resolve(result.cwd) !== policy.workspace ||
      result.approvalPolicy !== "never" ||
      (profile !== policy.readOnlyId && profile !== policy.workspaceWriteId) || typeof threadId !== "string") {
    throw new Error("No se han podido verificar los permisos privados de la conversación. Vuelve a conectar el asistente.");
  }
  let threads = attestedThreads.get(client);
  if (!threads) { threads = new Map(); attestedThreads.set(client, threads); }
  threads.set(threadId, `${policy.readOnlyId}:${policy.workspace}`);
}

export function hasAttestedQuotaToolPermissions(client: object, threadId: string, policy: QuotaToolPermissions) {
  return attestedThreads.get(client)?.get(threadId) === `${policy.readOnlyId}:${policy.workspace}`;
}
