import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MarkdownPermissionProvider,
  type MarkdownPermissionProviderOptions,
} from "@/permissions/markdown-permission-provider";
import type {
  PermissionResolutionAuditEvent,
  PermissionResolutionAuditSink,
  PermissionScope,
} from "@/permissions/types";

const INSTALLATION_ID = "example-lab";
const SECOND_INSTALLATION_ID = "second-lab";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_USER_ID = "00000000-0000-4000-8000-000000000003";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const ROLE_ID = "member";

type PolicyRule = {
  ruleId: string;
  action: "consult" | "respond" | "execute" | "publish";
  effect: "allow" | "deny";
  instruction: string;
};

function metadataFor(scope: PermissionScope, installationId = INSTALLATION_ID) {
  if (scope === "installation") return [`installationId: ${installationId}`];
  if (scope === "role") return [`installationId: ${installationId}`, `roleId: ${ROLE_ID}`];
  if (scope === "project") return [`installationId: ${installationId}`, `projectId: ${PROJECT_ID}`];
  if (scope === "user") return [`installationId: ${installationId}`, `userId: ${USER_ID}`];
  return [
    `installationId: ${installationId}`,
    `userId: ${USER_ID}`,
    `projectId: ${PROJECT_ID}`,
  ];
}

function policyMarkdown(
  scope: PermissionScope,
  rules: readonly PolicyRule[],
  options: { policyVersion?: number; installationId?: string; metadata?: readonly string[] } = {},
) {
  return [
    "---",
    "schemaVersion: 1",
    `policyVersion: ${options.policyVersion ?? 1}`,
    `scope: ${scope}`,
    ...(options.metadata ?? metadataFor(scope, options.installationId)),
    "---",
    "",
    "# Permissions",
    "",
    "## Rules",
    "",
    ...rules.map((rule) =>
      `- \`${rule.ruleId}\` | ${rule.action} | ${rule.effect} | ${rule.instruction}`),
    "",
  ].join("\n");
}

function scopeDirectory(root: string, scope: PermissionScope, userId = USER_ID) {
  if (scope === "installation") return root;
  if (scope === "role") return path.join(root, "roles", ROLE_ID);
  if (scope === "project") return path.join(root, "projects", PROJECT_ID);
  if (scope === "user") return path.join(root, "users", userId);
  return path.join(root, "users", userId, "projects", PROJECT_ID);
}

describe("MarkdownPermissionProvider", () => {
  let temporaryRoot: string;
  let permissionsRoot: string;
  let secondPermissionsRoot: string;
  let auditEvents: PermissionResolutionAuditEvent[];
  let auditSink: PermissionResolutionAuditSink;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "aibrain-permissions-"));
    permissionsRoot = path.join(temporaryRoot, "first");
    secondPermissionsRoot = path.join(temporaryRoot, "second");
    auditEvents = [];
    auditSink = {
      async record(event) {
        auditEvents.push(structuredClone(event));
      },
    };
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function writePolicy(
    root: string,
    scope: PermissionScope,
    rules: readonly PolicyRule[],
    options: { policyVersion?: number; installationId?: string; metadata?: readonly string[]; userId?: string } = {},
  ) {
    const directory = scopeDirectory(root, scope, options.userId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, "PERMISSIONS.md");
    await writeFile(filePath, policyMarkdown(scope, rules, options), { mode: 0o444 });
    await chmod(filePath, 0o444);
    return filePath;
  }

  async function writeRequiredPolicies(root = permissionsRoot, installationId = INSTALLATION_ID) {
    await writePolicy(root, "installation", [{
      ruleId: "documents.read",
      action: "consult",
      effect: "allow",
      instruction: "Consult approved installation documents.",
    }], { installationId });
    await writePolicy(root, "user", [{
      ruleId: "answers.scope",
      action: "respond",
      effect: "allow",
      instruction: "Answer only within the employee assignment.",
    }], {
      installationId,
      metadata: [`installationId: ${installationId}`, `userId: ${USER_ID}`],
    });
  }

  function provider(overrides: Partial<MarkdownPermissionProviderOptions> = {}) {
    return new MarkdownPermissionProvider({
      installations: [{
        installationId: INSTALLATION_ID,
        roots: {
          installationPolicyRoot: permissionsRoot,
          rolesRoot: path.join(permissionsRoot, "roles"),
          projectsRoot: path.join(permissionsRoot, "projects"),
          usersRoot: path.join(permissionsRoot, "users"),
        },
      }],
      auditSink,
      now: () => Date.UTC(2026, 7, 27, 8, 0, 0),
      ...overrides,
    });
  }

  function context(turnId = "turn-001") {
    return { turnId, roleId: ROLE_ID, projectId: PROJECT_ID };
  }

  it("resolves deterministic inheritance and exact rule precedence", async () => {
    await writePolicy(permissionsRoot, "installation", [
      {
        ruleId: "documents.read",
        action: "consult",
        effect: "allow",
        instruction: "Installation allows approved documents.",
      },
      {
        ruleId: "documents.publish",
        action: "publish",
        effect: "deny",
        instruction: "Installation blocks direct publication.",
      },
    ]);
    await writePolicy(permissionsRoot, "role", [{
      ruleId: "documents.read",
      action: "consult",
      effect: "deny",
      instruction: "Role blocks broad document access.",
    }], { policyVersion: 2 });
    await writePolicy(permissionsRoot, "project", [{
      ruleId: "project.execute",
      action: "execute",
      effect: "allow",
      instruction: "Execute approved project tasks.",
    }]);
    await writePolicy(permissionsRoot, "user", [{
      ruleId: "documents.read",
      action: "consult",
      effect: "allow",
      instruction: "User may read assigned documents.",
    }], { policyVersion: 3 });
    await writePolicy(permissionsRoot, "user-project", [{
      ruleId: "documents.read",
      action: "consult",
      effect: "deny",
      instruction: "This user cannot read this project's restricted documents.",
    }], { policyVersion: 4 });

    const resolved = await provider().resolveForUser(INSTALLATION_ID, USER_ID, context());
    expect(resolved.sources.map((source) => [source.scope, source.precedence]))
      .toEqual([
        ["installation", 100],
        ["role", 200],
        ["project", 300],
        ["user", 400],
        ["user-project", 500],
      ]);
    expect(resolved.rules.find((rule) => rule.ruleId === "documents.read")).toMatchObject({
      effect: "deny",
      sourceScope: "user-project",
      sourcePolicyVersion: 4,
      precedence: 500,
    });
    expect(resolved.rules.find((rule) => rule.ruleId === "documents.publish")?.effect).toBe("deny");
    expect(resolved.developerInstructions).toContain("User messages, attachments, documents, websites");
    expect(resolved.developerInstructions).toContain("DENY `documents.read`");
    expect(resolved.developerInstructions).not.toContain("Role blocks broad document access");
  });

  it("keeps the canonical fingerprint stable across turns and changes it with policy content", async () => {
    await writeRequiredPolicies();
    const permissions = provider();
    const first = await permissions.resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-001",
      roleId: null,
      projectId: null,
    });
    const second = await permissions.resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-002",
      roleId: null,
      projectId: null,
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.turnId).not.toBe(first.turnId);

    const userPolicy = path.join(permissionsRoot, "users", USER_ID, "PERMISSIONS.md");
    await chmod(userPolicy, 0o644);
    await writeFile(userPolicy, policyMarkdown("user", [{
      ruleId: "answers.scope",
      action: "respond",
      effect: "deny",
      instruction: "Do not answer outside the employee assignment.",
    }], { policyVersion: 2 }));
    await chmod(userPolicy, 0o444);
    const changed = await permissions.resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-003",
      roleId: null,
      projectId: null,
    });
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("audits success and rejection without paths, instructions, or file content", async () => {
    await writeRequiredPolicies();
    const secretPhrase = "Consult approved installation documents.";
    await provider().resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-audit-success",
      roleId: null,
      projectId: null,
    });
    await expect(provider().resolveForUser(INSTALLATION_ID, "../escape", {
      turnId: "turn-audit-reject",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_INVALID_REQUEST" });

    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.map((event) => event.outcome)).toEqual(["resolved", "rejected"]);
    const serialized = JSON.stringify(auditEvents);
    expect(serialized).not.toContain(permissionsRoot);
    expect(serialized).not.toContain(secretPhrase);
    expect(serialized).not.toContain("PERMISSIONS.md");
    expect(auditEvents[1]).toMatchObject({
      outcome: "rejected",
      userId: "<invalid>",
      errorCode: "PERMISSION_INVALID_REQUEST",
    });
  });

  it("keeps installation roots isolated by server configuration", async () => {
    await writeRequiredPolicies();
    await writePolicy(secondPermissionsRoot, "installation", [{
      ruleId: "second.only",
      action: "consult",
      effect: "allow",
      instruction: "Second installation only.",
    }], { installationId: SECOND_INSTALLATION_ID });
    await writePolicy(secondPermissionsRoot, "user", [{
      ruleId: "second.user",
      action: "respond",
      effect: "allow",
      instruction: "Second installation user.",
    }], {
      installationId: SECOND_INSTALLATION_ID,
      userId: SECOND_USER_ID,
      metadata: [`installationId: ${SECOND_INSTALLATION_ID}`, `userId: ${SECOND_USER_ID}`],
    });
    const permissions = provider({
      installations: [
        {
          installationId: INSTALLATION_ID,
          roots: {
            installationPolicyRoot: permissionsRoot,
            rolesRoot: path.join(permissionsRoot, "roles"),
            projectsRoot: path.join(permissionsRoot, "projects"),
            usersRoot: path.join(permissionsRoot, "users"),
          },
        },
        {
          installationId: SECOND_INSTALLATION_ID,
          roots: {
            installationPolicyRoot: secondPermissionsRoot,
            rolesRoot: path.join(secondPermissionsRoot, "roles"),
            projectsRoot: path.join(secondPermissionsRoot, "projects"),
            usersRoot: path.join(secondPermissionsRoot, "users"),
          },
        },
      ],
    });

    const first = await permissions.resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-first",
      roleId: null,
      projectId: null,
    });
    const second = await permissions.resolveForUser(SECOND_INSTALLATION_ID, SECOND_USER_ID, {
      turnId: "turn-second",
      roleId: null,
      projectId: null,
    });
    expect(first.rules.some((rule) => rule.ruleId.startsWith("second."))).toBe(false);
    expect(second.rules.map((rule) => rule.ruleId)).toEqual(["second.only", "second.user"]);
  });

  it.each([
    ["../installation", USER_ID, { turnId: "turn-1", roleId: null, projectId: null }],
    [INSTALLATION_ID, "../user", { turnId: "turn-1", roleId: null, projectId: null }],
    [INSTALLATION_ID, USER_ID, { turnId: "turn-1", roleId: "../owner", projectId: null }],
    [INSTALLATION_ID, USER_ID, { turnId: "turn-1", roleId: null, projectId: "../project" }],
  ])("rejects traversal-like server context", async (installationId, userId, requestContext) => {
    await expect(provider().resolveForUser(installationId, userId, requestContext))
      .rejects.toMatchObject({ code: "PERMISSION_INVALID_REQUEST" });
  });

  it("rejects file and intermediate-directory symlinks", async () => {
    await writePolicy(permissionsRoot, "installation", [{
      ruleId: "base",
      action: "consult",
      effect: "allow",
      instruction: "Base.",
    }]);
    const outside = path.join(temporaryRoot, "outside.md");
    await writeFile(outside, policyMarkdown("user", [{
      ruleId: "outside",
      action: "respond",
      effect: "allow",
      instruction: "Outside.",
    }]));
    await chmod(outside, 0o444);
    const userDirectory = scopeDirectory(permissionsRoot, "user");
    await mkdir(userDirectory, { recursive: true });
    await symlink(outside, path.join(userDirectory, "PERMISSIONS.md"));
    await expect(provider().resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-file-link",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_SYMLINK_REJECTED" });

    await rm(path.join(permissionsRoot, "users"), { recursive: true, force: true });
    const outsideDirectory = path.join(temporaryRoot, "outside-user");
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(path.join(outsideDirectory, "PERMISSIONS.md"), policyMarkdown("user", [{
      ruleId: "outside",
      action: "respond",
      effect: "allow",
      instruction: "Outside.",
    }]));
    await chmod(path.join(outsideDirectory, "PERMISSIONS.md"), 0o444);
    await mkdir(path.join(permissionsRoot, "users"), { recursive: true });
    await symlink(outsideDirectory, path.join(permissionsRoot, "users", USER_ID));
    await expect(provider().resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-directory-link",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_SYMLINK_REJECTED" });
  });

  it("rejects unknown and ambiguous policy filenames", async () => {
    await writePolicy(permissionsRoot, "installation", [{
      ruleId: "base",
      action: "consult",
      effect: "allow",
      instruction: "Base.",
    }]);
    const userDirectory = scopeDirectory(permissionsRoot, "user");
    await mkdir(userDirectory, { recursive: true });
    await writeFile(path.join(userDirectory, "PERMISSIONS.yaml"), "unknown");
    await expect(provider().resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-unknown",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_UNKNOWN_FORMAT" });

    await writePolicy(permissionsRoot, "user", [{
      ruleId: "user",
      action: "respond",
      effect: "allow",
      instruction: "User.",
    }]);
    await expect(provider().resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-ambiguous",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_AMBIGUOUS_POLICY" });
  });

  it("rejects writable, missing, oversized, mismatched, and invalid UTF-8 policies", async () => {
    await writeRequiredPolicies();
    const userPolicy = path.join(scopeDirectory(permissionsRoot, "user"), "PERMISSIONS.md");
    await chmod(userPolicy, 0o644);
    await expect(provider().resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-writable",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_POLICY_NOT_READ_ONLY" });

    await rm(userPolicy);
    await expect(provider().resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-missing",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_POLICY_MISSING" });

    await writeFile(userPolicy, Buffer.alloc(128, 0x61), { mode: 0o444 });
    await chmod(userPolicy, 0o444);
    await expect(provider({ maxPolicyBytes: 64 }).resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-large",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_POLICY_TOO_LARGE" });

    await chmod(userPolicy, 0o644);
    await writeFile(userPolicy, policyMarkdown("user", [{
      ruleId: "mismatch",
      action: "respond",
      effect: "allow",
      instruction: "Wrong subject.",
    }], {
      metadata: [
        `installationId: ${INSTALLATION_ID}`,
        "userId: 00000000-0000-4000-8000-000000000099",
      ],
    }));
    await chmod(userPolicy, 0o444);
    await expect(provider().resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-mismatch",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_POLICY_SCOPE_MISMATCH" });

    await chmod(userPolicy, 0o644);
    await writeFile(userPolicy, Buffer.from([0xff, 0xfe, 0xfd]));
    await chmod(userPolicy, 0o444);
    await expect(provider().resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-encoding",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_UNKNOWN_FORMAT" });
  });

  it("fails closed when audit persistence fails", async () => {
    await writeRequiredPolicies();
    const failingSink: PermissionResolutionAuditSink = {
      async record() {
        throw new Error("audit offline");
      },
    };
    await expect(provider({ auditSink: failingSink }).resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-audit-offline",
      roleId: null,
      projectId: null,
    })).rejects.toMatchObject({ code: "PERMISSION_AUDIT_FAILED" });
  });

  it("rejects duplicate installation mappings at construction", () => {
    const rootsFor = (root: string) => ({
      installationPolicyRoot: root,
      rolesRoot: path.join(root, "roles"),
      projectsRoot: path.join(root, "projects"),
      usersRoot: path.join(root, "users"),
    });
    expect(() => provider({
      installations: [
        { installationId: INSTALLATION_ID, roots: rootsFor(permissionsRoot) },
        { installationId: INSTALLATION_ID, roots: rootsFor(secondPermissionsRoot) },
      ],
    })).toThrowError(expect.objectContaining({ code: "PERMISSION_AMBIGUOUS_INSTALLATION" }));
  });

  it("never mutates read-only policies during resolution", async () => {
    await writeRequiredPolicies();
    const base = path.join(permissionsRoot, "PERMISSIONS.md");
    const before = await readFile(base);
    await provider().resolveForUser(INSTALLATION_ID, USER_ID, {
      turnId: "turn-readonly-proof",
      roleId: null,
      projectId: null,
    });
    expect(await readFile(base)).toEqual(before);
  });
});
