import { describe, expect, it } from "vitest";
import { parsePermissionMarkdown } from "@/permissions/markdown-parser";

const INSTALLATION_ID = "example-lab";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";

function policy(
  metadata: readonly string[],
  rules: readonly string[] = [
    "- `documents.read` | consult | allow | Consult approved company documents.",
  ],
) {
  return [
    "---",
    "schemaVersion: 1",
    "policyVersion: 1",
    ...metadata,
    "---",
    "",
    "# Permissions",
    "",
    "## Rules",
    "",
    ...rules,
    "",
  ].join("\n");
}

describe("PERMISSIONS.md v1 parser", () => {
  it.each([
    [
      ["scope: installation", `installationId: ${INSTALLATION_ID}`],
      { scope: "installation", installationId: INSTALLATION_ID },
    ],
    [
      ["scope: role", `installationId: ${INSTALLATION_ID}`, "roleId: member"],
      { scope: "role", roleId: "member" },
    ],
    [
      ["scope: project", `installationId: ${INSTALLATION_ID}`, `projectId: ${PROJECT_ID}`],
      { scope: "project", projectId: PROJECT_ID },
    ],
    [
      ["scope: user", `installationId: ${INSTALLATION_ID}`, `userId: ${USER_ID}`],
      { scope: "user", userId: USER_ID },
    ],
    [
      [
        "scope: user-project",
        `installationId: ${INSTALLATION_ID}`,
        `userId: ${USER_ID}`,
        `projectId: ${PROJECT_ID}`,
      ],
      { scope: "user-project", userId: USER_ID, projectId: PROJECT_ID },
    ],
  ])("parses the strict %s scope", (metadata, expected) => {
    expect(parsePermissionMarkdown(policy(metadata))).toMatchObject({
      schemaVersion: 1,
      policyVersion: 1,
      installationId: INSTALLATION_ID,
      ...expected,
      rules: [{
        ruleId: "documents.read",
        action: "consult",
        effect: "allow",
        instruction: "Consult approved company documents.",
      }],
    });
  });

  it.each([
    [policy(["scope: installation", `installationId: ${INSTALLATION_ID}`, "secret: hidden"]), /Unknown permission metadata/],
    [policy(["scope: installation", `installationId: ${INSTALLATION_ID}`, `installationId: ${INSTALLATION_ID}`]), /repeats installationId/],
    [policy(["scope: user", `installationId: ${INSTALLATION_ID}`]), /Missing permission metadata: userId/],
    [policy(["scope: user", `installationId: ${INSTALLATION_ID}`, "userId: ../escape"]), /canonical UUID/],
    [policy(["scope: installation", `installationId: ${INSTALLATION_ID}`], [
      "- `same.rule` | consult | allow | First.",
      "- `same.rule` | consult | deny | Second.",
    ]), /duplicated/],
    [policy(["scope: installation", `installationId: ${INSTALLATION_ID}`], []), /at least one rule/],
  ])("rejects malformed policy metadata or rules", (markdown, message) => {
    expect(() => parsePermissionMarkdown(markdown)).toThrow(message);
  });

  it("rejects unknown schema versions, headings, actions, and trailing formats", () => {
    expect(() => parsePermissionMarkdown(
      policy(["scope: installation", `installationId: ${INSTALLATION_ID}`])
        .replace("schemaVersion: 1", "schemaVersion: 2"),
    )).toThrowError(expect.objectContaining({ code: "PERMISSION_UNKNOWN_FORMAT" }));

    expect(() => parsePermissionMarkdown(
      policy(["scope: installation", `installationId: ${INSTALLATION_ID}`])
        .replace("# Permissions", "# Access policy"),
    )).toThrowError(expect.objectContaining({ code: "PERMISSION_UNKNOWN_FORMAT" }));

    expect(() => parsePermissionMarkdown(
      policy(["scope: installation", `installationId: ${INSTALLATION_ID}`])
        .replace("consult | allow", "delete | allow"),
    )).toThrowError(expect.objectContaining({ code: "PERMISSION_UNKNOWN_FORMAT" }));

    expect(() => parsePermissionMarkdown(
      `${policy(["scope: installation", `installationId: ${INSTALLATION_ID}`])}## Extra\n`,
    )).toThrowError(expect.objectContaining({ code: "PERMISSION_UNKNOWN_FORMAT" }));
  });

  it("requires canonical UTF-8 line structure", () => {
    const valid = policy(["scope: installation", `installationId: ${INSTALLATION_ID}`]);
    expect(() => parsePermissionMarkdown(valid.slice(0, -1))).toThrow(/end with a newline/);
    expect(() => parsePermissionMarkdown(`\uFEFF${valid}`)).toThrow(/BOM/);
    expect(() => parsePermissionMarkdown(valid.replace("# Permissions", "# Permissions\rbroken")))
      .toThrow(/Bare carriage returns/);
  });
});
