import { PermissionResolutionError } from "@/permissions/errors";
import type {
  PermissionAction,
  PermissionEffect,
  PermissionPolicyDocument,
  PermissionRule,
  PermissionScope,
} from "@/permissions/types";

const RULE_PATTERN = /^- `([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)` \| (consult|respond|execute|publish) \| (allow|deny) \| (.+)$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TURN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPES = new Set<PermissionScope>([
  "installation",
  "role",
  "project",
  "user",
  "user-project",
]);

function invalid(message: string): never {
  throw new PermissionResolutionError("PERMISSION_POLICY_INVALID", message);
}

function parsePositiveInteger(value: string, key: string) {
  if (!/^[1-9][0-9]{0,8}$/.test(value)) invalid(`${key} must be a positive integer.`);
  return Number.parseInt(value, 10);
}

function parseMetadata(lines: string[]) {
  const metadata = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) invalid("Permission metadata must use 'key: value' lines.");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || value.length === 0) {
      invalid("Permission metadata contains an invalid key or empty value.");
    }
    if (metadata.has(key)) invalid(`Permission metadata repeats ${key}.`);
    metadata.set(key, value);
  }
  return metadata;
}

function expectedMetadataKeys(scope: PermissionScope) {
  const common = ["schemaVersion", "policyVersion", "scope", "installationId"];
  if (scope === "installation") return common;
  if (scope === "role") return [...common, "roleId"];
  if (scope === "project") return [...common, "projectId"];
  if (scope === "user") return [...common, "userId"];
  return [...common, "userId", "projectId"];
}

function assertExactMetadata(metadata: Map<string, string>, expected: readonly string[]) {
  const unexpected = [...metadata.keys()].filter((key) => !expected.includes(key)).sort();
  const missing = expected.filter((key) => !metadata.has(key));
  if (unexpected.length > 0) invalid(`Unknown permission metadata: ${unexpected.join(", ")}.`);
  if (missing.length > 0) invalid(`Missing permission metadata: ${missing.join(", ")}.`);
}

function assertIdentifier(value: string | undefined, key: string) {
  if (!value || !IDENTIFIER_PATTERN.test(value)) invalid(`${key} is not a canonical identifier.`);
  return value;
}

function assertUuid(value: string | undefined, key: string) {
  if (!value || !UUID_PATTERN.test(value)) invalid(`${key} is not a canonical UUID.`);
  return value;
}

export function isCanonicalInstallationId(value: string) {
  return IDENTIFIER_PATTERN.test(value);
}

export function isCanonicalRoleId(value: string) {
  return IDENTIFIER_PATTERN.test(value);
}

export function isCanonicalUuid(value: string) {
  return UUID_PATTERN.test(value);
}

export function isCanonicalTurnId(value: string) {
  return TURN_ID_PATTERN.test(value);
}

export function parsePermissionMarkdown(markdown: string): PermissionPolicyDocument {
  if (markdown.charCodeAt(0) === 0xfeff) invalid("UTF-8 BOM is not supported.");
  if (markdown.includes("\0")) invalid("NUL bytes are not supported.");
  if (/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/.test(markdown)) {
    invalid("Control characters are not supported.");
  }
  if (/\r(?!\n)/.test(markdown)) {
    invalid("Bare carriage returns are not supported.");
  }
  const normalized = markdown.replaceAll("\r\n", "\n");
  if (!normalized.endsWith("\n")) invalid("PERMISSIONS.md must end with a newline.");
  const lines = normalized.slice(0, -1).split("\n");
  if (lines[0] !== "---") invalid("PERMISSIONS.md must start with metadata front matter.");
  const closing = lines.indexOf("---", 1);
  if (closing < 2 || closing > 12) invalid("Permission metadata front matter is missing or too large.");

  const metadata = parseMetadata(lines.slice(1, closing));
  if (metadata.get("schemaVersion") !== "1") {
    throw new PermissionResolutionError(
      "PERMISSION_UNKNOWN_FORMAT",
      "Unsupported PERMISSIONS.md schemaVersion.",
    );
  }
  const scope = metadata.get("scope") as PermissionScope | undefined;
  if (!scope || !SCOPES.has(scope)) {
    throw new PermissionResolutionError(
      "PERMISSION_UNKNOWN_FORMAT",
      "Unsupported PERMISSIONS.md scope.",
    );
  }
  assertExactMetadata(metadata, expectedMetadataKeys(scope));

  const body = lines.slice(closing + 1);
  const expectedPrefix = ["", "# Permissions", "", "## Rules", ""];
  if (body.length < expectedPrefix.length ||
      expectedPrefix.some((line, index) => body[index] !== line)) {
    throw new PermissionResolutionError(
      "PERMISSION_UNKNOWN_FORMAT",
      "PERMISSIONS.md body must contain only '# Permissions' and '## Rules' in the v1 format.",
    );
  }

  const rules: PermissionRule[] = [];
  const ruleIds = new Set<string>();
  for (const line of body.slice(expectedPrefix.length)) {
    if (line.length > 700) invalid("Permission rule line exceeds 700 characters.");
    const match = RULE_PATTERN.exec(line);
    if (!match) {
      throw new PermissionResolutionError(
        "PERMISSION_UNKNOWN_FORMAT",
        "Unknown permission rule format.",
      );
    }
    const [, ruleId, action, effect, instruction] = match;
    if (ruleId.length > 80) invalid("Permission ruleId exceeds 80 characters.");
    if (ruleIds.has(ruleId)) invalid(`Permission rule ${ruleId} is duplicated.`);
    if (instruction.length > 500 || instruction.includes("|")) {
      invalid(`Permission rule ${ruleId} contains an invalid instruction.`);
    }
    ruleIds.add(ruleId);
    rules.push({
      ruleId,
      action: action as PermissionAction,
      effect: effect as PermissionEffect,
      instruction,
    });
  }
  if (rules.length === 0) invalid("PERMISSIONS.md must define at least one rule.");
  if (rules.length > 256) invalid("PERMISSIONS.md exceeds 256 rules.");

  const document: PermissionPolicyDocument = {
    schemaVersion: 1,
    policyVersion: parsePositiveInteger(metadata.get("policyVersion") ?? "", "policyVersion"),
    scope,
    installationId: assertIdentifier(metadata.get("installationId"), "installationId"),
    rules,
  };
  if (scope === "role") document.roleId = assertIdentifier(metadata.get("roleId"), "roleId");
  if (scope === "project" || scope === "user-project") {
    document.projectId = assertUuid(metadata.get("projectId"), "projectId");
  }
  if (scope === "user" || scope === "user-project") {
    document.userId = assertUuid(metadata.get("userId"), "userId");
  }
  return Object.freeze({
    ...document,
    rules: Object.freeze(rules.map((rule) => Object.freeze({ ...rule }))),
  });
}
