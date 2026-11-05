import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import { EnterpriseDocumentNetwork } from "@/documents/enterprise-document-network";
import type { ResolvedPermissions } from "@/permissions";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const PROJECT = "00000000-0000-4000-8000-000000000010";
const DEPARTMENT = "00000000-0000-4000-8000-000000000011";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-enterprise-documents-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  return {
    root,
    config: parseInstallationConfig({
      schemaVersion: 1,
      installationId: "arnall-test",
      companyName: "Arnall Test",
      companySlug: "arnall-test",
      publicUrl: "https://arnall.test",
      branding: { productName: "Arnall AI", logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#123456" },
      paths: {
        dataRoot,
        companyContextRoot: path.join(dataRoot, "context"),
        usersRoot: path.join(dataRoot, "users"),
        sourceReadRoot: path.join(root, "source"),
        publishWriteRoot: path.join(root, "publish"),
        backupsRoot: path.join(dataRoot, "backups"),
      },
    }),
  };
}

function permissions(userId: string, rules: Array<{ ruleId: string; action: "consult" | "execute"; effect: "allow" | "deny" }>): ResolvedPermissions {
  return {
    schemaVersion: 1,
    installationId: "arnall-test",
    userId,
    roleId: null,
    projectId: PROJECT,
    turnId: "00000000-0000-4000-8000-000000000020",
    resolvedAt: "2026-08-30T00:00:00.000Z",
    fingerprint: "a".repeat(64),
    sources: [],
    rules: rules.map((rule) => ({ ...rule, instruction: "test", sourceScope: "installation" as const, sourcePolicyVersion: 1, precedence: 100 })),
    developerInstructions: "Policy fingerprint: " + "a".repeat(64),
  };
}

describe("EnterpriseDocumentNetwork", () => {
  it("provisions persistent company, project and private roots with scope provenance", async () => {
    const { config } = await fixture();
    const first = new EnterpriseDocumentNetwork(config);
    await first.provision({ userId: USER_A, projectId: PROJECT, departmentIds: [DEPARTMENT] });
    await writeFile(path.join(first.projectRoot(PROJECT), "brief.md"), "Precio y stock de Arnall", "utf8");

    const restarted = new EnterpriseDocumentNetwork(config);
    expect(await readFile(path.join(restarted.projectRoot(PROJECT), "brief.md"), "utf8")).toContain("Arnall");
    expect(JSON.parse(await readFile(path.join(restarted.companyRoot(), ".aibrain-document-scope.json"), "utf8")))
      .toMatchObject({ scope: "company", installationId: "arnall-test" });
  });

  it("gives each authorized worker only its shared scopes and its own private root", async () => {
    const { config } = await fixture();
    const network = new EnterpriseDocumentNetwork(config);
    const all = permissions(USER_A, [
      { ruleId: "documents.read", action: "consult", effect: "allow" },
      { ruleId: "documents.write", action: "execute", effect: "allow" },
    ]);
    const ownRoots = await network.rootsForTurn({ userId: USER_A, projectId: PROJECT, departmentIds: [DEPARTMENT], permissions: all });
    expect(ownRoots.map((root) => [root.scope, root.readOnly])).toEqual([
      ["company", false], ["department", false], ["project", false], ["private", false],
    ]);
    expect(ownRoots.map((root) => root.path)).not.toContain(network.privateRoot(USER_B));

    const reader = permissions(USER_B, [{ ruleId: "documents.project.read", action: "consult", effect: "allow" }]);
    const readerRoots = await network.rootsForTurn({ userId: USER_B, projectId: PROJECT, permissions: reader });
    expect(readerRoots).toEqual([{ scope: "project", scopeId: PROJECT, path: network.projectRoot(PROJECT), readOnly: true }]);
  });

  it("indexes matching documents with scope provenance and refuses symlink substitution", async () => {
    const { config, root } = await fixture();
    const network = new EnterpriseDocumentNetwork(config);
    const access = permissions(USER_A, [{ ruleId: "documents.read", action: "consult", effect: "allow" }]);
    const documentRoots = await network.rootsForTurn({ userId: USER_A, projectId: PROJECT, permissions: access });
    await writeFile(path.join(network.companyRoot(), "catalogo.md"), "Catálogo de muebles Arnall", "utf8");
    await expect(network.search({ roots: documentRoots, query: "muebles" })).resolves.toEqual([
      expect.objectContaining({ scope: "company", path: "catalogo.md", provenance: { installationId: "arnall-test", departmentId: null, projectId: null, userId: null } }),
    ]);

    const outside = path.join(root, "outside");
    await writeFile(outside, "muebles", "utf8");
    await symlink(outside, path.join(network.companyRoot(), "escape.md"));
    await expect(network.search({ roots: documentRoots, query: "muebles" }))
      .rejects.toMatchObject({ code: "DOCUMENT_NETWORK_SYMLINK_REJECTED" });
  });

  it("reads only turn-bound roots and blocks traversal, sibling users and credential-shaped files", async () => {
    const { config } = await fixture();
    const network = new EnterpriseDocumentNetwork(config);
    const access = permissions(USER_A, [{ ruleId: "documents.read", action: "consult", effect: "allow" }]);
    const documentRoots = await network.rootsForTurn({ userId: USER_A, projectId: PROJECT, permissions: access });
    await writeFile(path.join(network.privateRoot(USER_A), "notes.md"), "Resumen autorizado de ventas", "utf8");
    await writeFile(path.join(network.privateRoot(USER_A), "credentials.txt"), "password=abcdefghijklmnop", "utf8");
    await network.provision({ userId: USER_B, projectId: PROJECT });
    await writeFile(path.join(network.privateRoot(USER_B), "foreign.md"), "Otro usuario", "utf8");

    await expect(network.read({ roots: documentRoots, scope: "private", path: "notes.md" }))
      .resolves.toMatchObject({ content: "Resumen autorizado de ventas", provenance: { userId: USER_A } });
    await expect(network.read({ roots: documentRoots, scope: "private", path: "../foreign.md" }))
      .rejects.toMatchObject({ code: "DOCUMENT_NETWORK_SENSITIVE_PATH" });
    await expect(network.read({ roots: documentRoots, scope: "private", path: "credentials.txt" }))
      .rejects.toMatchObject({ code: "DOCUMENT_NETWORK_SENSITIVE_PATH" });
    await expect(network.search({
      roots: [{ scope: "private", scopeId: USER_B, path: network.privateRoot(USER_B), readOnly: true }],
      query: "otro",
    })).rejects.toMatchObject({ code: "DOCUMENT_NETWORK_ROOT_NOT_AUTHORIZED" });
  });
});
