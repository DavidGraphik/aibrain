import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import type { CatalogPrincipal, CatalogState } from "@/catalog/contracts";
import { FileCompanySkillPackageStore, synchronizeEffectiveSkills, readVersionedSkillPackage } from "@/catalog/skill-packages";

import { ensureInstallationCatalog } from "@/catalog/baseline";
import { FileCatalogStore } from "@/catalog/store";
import { designSkillDeveloperInstructions } from "@/catalog/design-skill-policy";
import { DESIGN_COPY_SKILLS, managedSkillsForInstallation } from "@/catalog/managed-skills";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const GROUP = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-skill-sync-")); roots.push(root);
  const dataRoot = path.join(root, "data"); const usersRoot = path.join(dataRoot, "users");
  await mkdir(usersRoot, { recursive: true, mode: 0o700 });
  for (const userId of [USER_A, USER_B]) await mkdir(path.join(usersRoot, userId, "runtime", "codex-home"), { recursive: true, mode: 0o700 });
  const config = {
    schemaVersion: 1, installationId: "arnall-qa", companyName: "Arnall", companySlug: "arnall", publicUrl: "https://arnall.example",
    branding: { productName: "Arnall AI", logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#315ee7" },
    paths: { dataRoot, usersRoot, companyContextRoot: path.join(dataRoot, "company"), sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(dataRoot, "backups") },
    catalog: { graphikAIManagedSkills: [{ id: "graphikai-business-work", label: "Trabajo empresarial GraphikAI" }, { id: "arnall-company-brief", label: "Contexto confirmado de Arnall" }] },
  } satisfies InstallationConfig;
  const resources = ["graphikai-business-work", "arnall-company-brief"].map((id) => ({ id, kind: "skill" as const, label: id, credentialMode: "none" as const, managedBy: "graphikai" as const, sharedResource: false, appId: null, connectorId: null, mcp: null }));
  const state: CatalogState = { schemaVersion: 1, installationId: config.installationId, revision: 1, resources, rules: resources.map(({ id }) => ({ id: `install-${id}`, scope: "installation" as const, subjectId: null, resourceId: id, effect: "allow" as const, operations: ["read" as const] })) };
  const principal = (userId: string, groupIds: string[] = []): CatalogPrincipal => ({ installationId: config.installationId, userId, roleId: "workspace-member", groupIds, workspaceCanExecute: true });
  return { root, config, state, principal, packagesRoot: path.join(process.cwd(), "skills") };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("managed skill packages", () => {
  it("synchronizes the Arnall shared seed into two separate private CODEX_HOME roots", async () => {
    const { config, state, principal, packagesRoot } = await fixture();
    const first = await synchronizeEffectiveSkills({ config, userId: USER_A, state, principal: principal(USER_A), packagesRoot });
    const second = await synchronizeEffectiveSkills({ config, userId: USER_B, state, principal: principal(USER_B), packagesRoot });
    expect(first.installed.sort()).toEqual(["arnall-company-brief", "graphikai-business-work"]);
    expect(second.installed.sort()).toEqual(first.installed.sort());
    expect(first.skills[0].path).not.toBe(second.skills[0].path);
    expect(await readFile(path.join(config.paths.usersRoot, USER_A, "runtime", "codex-home", "skills", "arnall-company-brief", "SKILL.md"), "utf8")).toContain("Never invent stock");
    expect((await synchronizeEffectiveSkills({ config, userId: USER_A, state, principal: principal(USER_A), packagesRoot })).unchanged).toHaveLength(2);
  });

  it("adds full Impeccable to existing Arnall configs, isolates copies and honors a user denial", async () => {
    const { config, principal, packagesRoot } = await fixture();
    const store = new FileCatalogStore(config.installationId, config.paths.dataRoot);
    const state = await ensureInstallationCatalog(store, config);
    expect(state.resources.filter(({ id }) => id === "impeccable")).toHaveLength(1);
    expect((await ensureInstallationCatalog(store, config)).revision).toBe(state.revision);
    const first = await synchronizeEffectiveSkills({ config, userId: USER_A, state, principal: principal(USER_A), packagesRoot });
    const second = await synchronizeEffectiveSkills({ config, userId: USER_B, state, principal: principal(USER_B), packagesRoot });
    for (const { id } of DESIGN_COPY_SKILLS) {
      expect(state.resources.filter((resource) => resource.id === id)).toHaveLength(1);
      const own = first.skills.find((skill) => skill.id === id)!;
      const otherCopy = second.skills.find((skill) => skill.id === id)!;
      expect(own.path).not.toBe(otherCopy.path);
      expect(own.digest).toBe(otherCopy.digest);
      const bundle = await readVersionedSkillPackage(packagesRoot, id);
      for (const file of bundle.manifest.files) {
        expect(await readFile(path.join(own.path, file), "utf8")).toBe(bundle.files[file]);
      }
    }
    const a = first.skills.find(({ id }) => id === "impeccable")!;
    const b = second.skills.find(({ id }) => id === "impeccable")!;
    expect(a.version).toBe("4.1.1");
    expect(a.path).not.toBe(b.path);
    expect(a.digest).toBe(b.digest);
    const pkg = await readVersionedSkillPackage(packagesRoot, "impeccable");
    for (const file of pkg.manifest.files) {
      expect(await readFile(path.join(a.path, file), "utf8")).toBe(pkg.files[file]);
    }
    const instructions = designSkillDeveloperInstructions(config, first);
    expect(instructions).toContain(path.join(a.path, "SKILL.md"));
    expect(instructions).toContain("MUST use the impeccable skill");
    expect(instructions).toContain("full conversation");
    expect(instructions).toContain("A different selected skill complements");
    expect(instructions).not.toContain(b.path);
    expect(instructions).toContain("MUST use presentation-craft together with impeccable");
    expect(instructions).toContain("inspect every final rendered page");
    expect(instructions).toContain("Use human-writing for slide copy");
    expect(instructions).toContain("Writing-only work does not activate visual design skills");
    expect(instructions).toContain("Apply relevant skills silently");
    expect(instructions).not.toContain("Briefly tell the user");
    expect(instructions).toContain("Never invent causes, metrics, testimonials");
    expect(instructions).toContain("ogilvy-copywriting only for persuasive or commercial copy");
    state.rules.push({ id: "deny-design-a", scope: "user", subjectId: USER_A, resourceId: "impeccable", effect: "deny", operations: ["read"] });
    state.revision += 1;
    const denied = await synchronizeEffectiveSkills({ config, userId: USER_A, state, principal: principal(USER_A), packagesRoot });
    expect(denied.revoked).toContain("impeccable");
    expect(designSkillDeveloperInstructions(config, denied)).toContain("ux-writing@");
    state.rules.push({ id: "deny-copy-a", scope: "user", subjectId: USER_A, resourceId: "ux-writing", effect: "deny", operations: ["read"] });
    state.revision += 1;
    const deniedCopy = await synchronizeEffectiveSkills({ config, userId: USER_A, state, principal: principal(USER_A), packagesRoot });
    expect(deniedCopy.revoked).toContain("ux-writing");
    expect(designSkillDeveloperInstructions(config, deniedCopy)).not.toContain("ux-writing@");
    expect(await readFile(path.join(second.skills.find(({ id }) => id === "ux-writing")!.path, "SKILL.md"), "utf8")).toContain("name: ux-writing");
    await expect(readFile(path.join(a.path, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(designSkillDeveloperInstructions(config, denied)).toContain("required skill is unavailable");
    expect(designSkillDeveloperInstructions(config, denied)).not.toContain(a.path);
    expect(await readFile(path.join(b.path, "SKILL.md"), "utf8")).toContain("name: impeccable");
    const other = { ...config, companySlug: "another-company" };
    expect(managedSkillsForInstallation(other).some(({ id }) => id === "impeccable")).toBe(true);
    expect(designSkillDeveloperInstructions(other, second)).toContain("Apply relevant skills silently");
    expect(managedSkillsForInstallation({ ...config, catalog: { graphikAIManagedSkills: [{ id: "impeccable", label: "Impeccable" }] } })).toHaveLength(DESIGN_COPY_SKILLS.length);
  });

  it("still rejects executable and oversized administrative skill uploads", async () => {
    const { config } = await fixture();
    const store = new FileCompanySkillPackageStore(config.installationId, config.paths.dataRoot);
    const input = {
      id: "company-design", label: "Design", version: "1.0.0", category: "company" as const, provenance: "Company upload",
      files: [
        { path: "SKILL.md", content: "---\nname: company-design\ndescription: Design guidance.\n---\n" },
        { path: "scripts/context.mjs", content: "export const test = true;" },
      ],
    };
    await expect(store.upsert(USER_A, input)).rejects.toThrow();
    await expect(store.upsert(USER_A, { ...input, files: [input.files[0], { path: "resources/large.md", content: "x".repeat(65 * 1024) }] })).rejects.toThrow();
  });

  it("adds, updates and revokes a group skill idempotently as membership changes", async () => {
    const { config, state, principal, packagesRoot } = await fixture();
    const store = new FileCompanySkillPackageStore(config.installationId, config.paths.dataRoot, () => Date.parse("2026-08-30T10:00:00.000Z"));
    const input = (version: string, body: string) => ({ id: "arnall-sales-check", label: "Comprobación comercial", version, category: "company" as const, provenance: "Procedimiento confirmado por administración el 2026-08-30.", files: [{ path: "SKILL.md", content: `---\nname: arnall-sales-check\ndescription: Check confirmed sales inputs.\n---\n\n${body}` }] });
    expect((await store.upsert(USER_A, input("1.0.0", "Versión uno"))).changed).toBe(true);
    await expect(store.upsert(USER_A, input("1.0.1", "password=abcdefghijklmnop"))).rejects.toMatchObject({ code: "SKILL_PACKAGE_SECRET_REJECTED" });
    expect((await store.upsert(USER_A, input("1.0.0", "Versión uno"))).changed).toBe(false);
    state.resources.push({ id: "arnall-sales-check", kind: "skill", label: "Comprobación comercial", credentialMode: "none", managedBy: "company", sharedResource: false, appId: null, connectorId: null, mcp: null });
    state.rules.push({ id: "group-sales", scope: "group", subjectId: GROUP, resourceId: "arnall-sales-check", effect: "allow", operations: ["read"] }); state.revision += 1;
    const added = await synchronizeEffectiveSkills({ config, userId: USER_A, state, principal: principal(USER_A, [GROUP]), packagesRoot });
    expect(added.installed).toContain("arnall-sales-check");
    await store.upsert(USER_A, input("1.1.0", "Versión dos"));
    expect((await synchronizeEffectiveSkills({ config, userId: USER_A, state, principal: principal(USER_A, [GROUP]), packagesRoot })).updated).toEqual(["arnall-sales-check"]);
    expect((await synchronizeEffectiveSkills({ config, userId: USER_A, state, principal: principal(USER_A), packagesRoot })).revoked).toEqual(["arnall-sales-check"]);
    await store.revoke(USER_A, "arnall-sales-check");
    expect((await synchronizeEffectiveSkills({ config, userId: USER_B, state, principal: principal(USER_B, [GROUP]), packagesRoot })).skills.map(({ id }) => id)).not.toContain("arnall-sales-check");
    expect((await store.auditLog()).map(({ action }) => action)).toEqual(["skill-package.revoked", "skill-package.updated", "skill-package.updated"]);
  });

  it("fails closed on tenant mismatch and a symlinked employee CODEX_HOME", async () => {
    const { root, config, state, principal, packagesRoot } = await fixture();
    await expect(synchronizeEffectiveSkills({ config, userId: USER_A, state, principal: { ...principal(USER_A), installationId: "other-tenant" }, packagesRoot })).rejects.toMatchObject({ code: "SKILL_SYNC_IDENTITY_MISMATCH" });
    const codexHome = path.join(config.paths.usersRoot, USER_A, "runtime", "codex-home"); await rm(codexHome, { recursive: true }); await symlink(path.join(root, "outside"), codexHome);
    await expect(synchronizeEffectiveSkills({ config, userId: USER_A, state, principal: principal(USER_A), packagesRoot })).rejects.toBeInstanceOf(Error);
  });
});
