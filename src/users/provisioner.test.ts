import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { parseInstallationConfig } from "@/config/installation-schema";
import { parsePermissionMarkdown } from "@/permissions/markdown-parser";
import { UserProvisioner } from "@/users/provisioner";
import { LocalFileMemoryService } from "@/memory/local-file-memory-service";
import { COMPANY_KNOWLEDGE_AREAS, standardCompanyContextTemplates } from "@/users/company-context-standard";
import { companyContextFiles } from "@/users/provisioner";

const roots: string[] = [];

function userId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function fixture(companyContextSeedRoot?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-user-provisioning-"));
  roots.push(root);
  const config = parseInstallationConfig({
    schemaVersion: 1,
    installationId: "synthetic-company-qa",
    companyName: "Synthetic Company QA",
    companySlug: "synthetic-company",
    publicUrl: "http://127.0.0.1:3000",
    branding: {
      productName: "Synthetic Brain",
      logoPath: "/branding/synthetic/logo.svg",
      faviconPath: "/branding/synthetic/favicon.svg",
      accentColor: "#315ee7",
    },
    paths: {
      dataRoot: path.join(root, "data"),
      companyContextRoot: path.join(root, "data", "company"),
      usersRoot: path.join(root, "data", "users"),
      sourceReadRoot: path.join(root, "documents", "source-ro"),
      publishWriteRoot: path.join(root, "documents", "publish-rw"),
      backupsRoot: path.join(root, "data", "backups"),
    },
  });
  return { root, config, provisioner: new UserProvisioner(config, { companyContextSeedRoot }) };
}

async function mode(filePath: string) {
  return (await lstat(filePath)).mode & 0o777;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("UserProvisioner", () => {
  it("uses one layout for unrelated companies and keeps detailed context outside the automatic snapshot", async () => {
    const { config, provisioner } = await fixture();
    const second = { ...config, companyName: "Unrelated Example", companySlug: "unrelated-example",
      installationId: "unrelated-installation", branding: { ...config.branding, productName: "Unrelated Assistant" } };
    const firstFiles = standardCompanyContextTemplates(config);
    const secondFiles = standardCompanyContextTemplates(second);
    expect([...firstFiles.keys()]).toEqual([...secondFiles.keys()]);
    expect([...secondFiles.values()].join("\n")).not.toMatch(/Arnall|Synthetic Company/);
    expect([...secondFiles.values()].join("\n")).toContain("Unrelated Example");
    const arnallFiles = await companyContextFiles(config, path.join(process.cwd(), "config/company-context/arnall"));
    expect([...arnallFiles.keys()].sort()).toEqual([...firstFiles.keys()].sort());
    await provisioner.provision({ userId: userId(1), email: "standard@example.test", displayName: "Standard Employee" });
    for (const area of COMPANY_KNOWLEDGE_AREAS) {
      expect((await lstat(path.join(config.paths.companyContextRoot, "knowledge", area))).isDirectory()).toBe(true);
    }
    const service = new LocalFileMemoryService({ config });
    const context = { installationId: config.installationId, userId: userId(1) };
    const snapshot = await service.buildPromptSnapshot(context);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.text.length).toBeLessThan(12_000);
    expect(snapshot.text).not.toContain("## Recuperación y ajustes");
    expect(await service.readKnowledge(context, "app/APP_GUIDE.md")).toContain("## Recuperación y ajustes");
    await expect(service.readKnowledge({ ...context, installationId: second.installationId }, "app/APP_GUIDE.md"))
      .rejects.toThrow();
    await expect(service.readKnowledge(context, "../../PERMISSIONS.md")).rejects.toThrow();
  });

  it("provisions twenty complete employee roots without code or configuration changes", async () => {
    const { config, provisioner } = await fixture();
    const inputs = Array.from({ length: 20 }, (_, index) => ({
      userId: userId(index + 1),
      email: `employee-${index + 1}@example.test`,
      displayName: `Synthetic Employee ${index + 1}`,
    }));

    const results = [];
    for (const input of inputs) results.push(await provisioner.provision(input));
    expect(results.every(({ created }) => created)).toBe(true);
    expect(new Set(results.map(({ userRoot }) => userRoot))).toHaveLength(20);
    expect(new Set(results.map(({ workerId }) => workerId))).toHaveLength(20);

    const users = new FileLocalUserStore(config.paths.usersRoot);
    for (const input of inputs) {
      const root = path.join(config.paths.usersRoot, input.userId);
      expect(await users.read(input.userId)).toMatchObject({
        email: input.email,
        enabled: true,
        workerId: `worker-${input.userId}`,
      });
      expect(await mode(root)).toBe(0o700);
      expect(await mode(path.join(root, "user.json"))).toBe(0o600);
      expect(await mode(path.join(root, "PROFILE.md"))).toBe(0o400);
      expect(await mode(path.join(root, "PERMISSIONS.md"))).toBe(0o400);
      expect(await mode(path.join(root, "PREFERENCES.md"))).toBe(0o600);
      expect(await mode(path.join(root, "memory"))).toBe(0o700);
      expect(await mode(path.join(root, "password-change-required"))).toBe(0o600);
      expect(await lstat(path.join(root, "worker.json"))).toBeTruthy();
    }

    const installationPolicy = parsePermissionMarkdown(
      await readFile(path.join(config.paths.companyContextRoot, "PERMISSIONS.md"), "utf8"),
    );
    expect(installationPolicy).toMatchObject({
      installationId: config.installationId,
      scope: "installation",
    });
    expect(await mode(path.join(config.paths.companyContextRoot, "PERMISSIONS.md"))).toBe(0o400);
    for (const fileName of [
      "00_SYSTEM.md",
      "10_IDENTITY.md",
      "20_COMPANY.md",
      "30_ORGANIZATION.md",
      "40_WORKFLOWS.md",
      "50_DOCUMENT_RULES.md",
      "KNOWLEDGE_INDEX.md",
    ]) {
      expect(await mode(path.join(config.paths.companyContextRoot, fileName))).toBe(0o400);
    }
    for (const directory of ["departments", "procedures", "glossary", "sources"]) {
      expect(await mode(path.join(config.paths.companyContextRoot, "knowledge", directory))).toBe(0o700);
    }
  }, 120_000);

  it("is idempotent and never recreates a consumed initial-password marker", async () => {
    const { config, provisioner } = await fixture();
    const input = {
      userId: userId(1),
      email: "employee@example.test",
      displayName: "Synthetic Employee",
    };
    const first = await provisioner.provision(input);
    const marker = path.join(first.userRoot, "password-change-required");
    const companyContext = path.join(config.paths.companyContextRoot, "20_COMPANY.md");
    await unlink(marker);
    await chmod(companyContext, 0o600);
    await writeFile(companyContext, "# Company context\n\nExplicit tenant content.\n");

    const second = await provisioner.provision(input);
    expect(second.created).toBe(false);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(config.paths.usersRoot, input.userId, "user.json"), "utf8"))
      .toContain("employee@example.test");
    expect(await readFile(companyContext, "utf8")).toContain("Explicit tenant content");
    expect(await mode(companyContext)).toBe(0o600);
  });

  it("seeds the synthetic context network once and leaves edited files byte-for-byte untouched", async () => {
    const seedRoot = path.join(process.cwd(), "config", "company-context", "arnall");
    const { config, provisioner } = await fixture(seedRoot);
    await provisioner.ensureInstallationPolicy();

    await provisioner.provision({
      userId: userId(1),
      email: "arnall-employee@example.test",
      displayName: "Arnall Employee",
    });
    const snapshot = await new LocalFileMemoryService({ config }).buildPromptSnapshot({
      installationId: config.installationId,
      userId: userId(1),
      projectId: "00000000-0000-4000-8000-000000000010",
    }, { maxCharacters: 64_000 });
    const prompt = JSON.parse(snapshot.text) as {
      companyContext: Array<{ fileName: string; content: string }>;
    };
    // Detailed documents are deliberately not pushed into every turn.
    expect(prompt.companyContext.map(({ fileName }) => fileName)).not.toEqual(
      expect.arrayContaining(["knowledge/company/COMPANY.md"]));
    const service = new LocalFileMemoryService({ config });
    const context = { installationId: config.installationId, userId: userId(1) };
    expect(await service.readKnowledge(context, "company/COMPANY.md")).toContain("Synthetic Example Company");
    expect(await service.readKnowledge(context, "organization/PEOPLE.md")).toContain("Synthetic employee one and synthetic employee two");
    expect(await service.readKnowledge(context, "processes/PROCESSES.md")).toContain("No internal process has been supplied");

    for (const relativePath of [
      "knowledge/company/COMPANY.md",
      "knowledge/organization/PEOPLE.md",
      "knowledge/organization/DEPARTMENTS.md",
      "knowledge/communication/PREFERENCES.md",
      "knowledge/projects/PROJECTS.md",
      "knowledge/processes/PROCESSES.md",
      "knowledge/goals/GOALS.md",
      "knowledge/communication/BRAND.md",
      "knowledge/tools/TOOLS.md",
      "knowledge/automations/AUTOMATIONS.md",
      "knowledge/support/SUPPORT.md",
      "knowledge/sources/SOURCES.md",
      "knowledge/pending/OPEN_QUESTIONS.md",
    ]) {
      expect(await readFile(path.join(config.paths.companyContextRoot, relativePath), "utf8"))
        .toEqual(await readFile(path.join(seedRoot, relativePath), "utf8"));
    }

    const edited = path.join(config.paths.companyContextRoot, "knowledge", "tools", "TOOLS.md");
    const custom = "# Approved production edit\n\nKeep this exact content.\n";
    await chmod(edited, 0o600);
    await writeFile(edited, custom);
    const before = await lstat(edited);

    await provisioner.ensureInstallationPolicy();

    const after = await lstat(edited);
    expect(await readFile(edited, "utf8")).toBe(custom);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }, 120_000);

  it("fails closed for identity drift and symlink substitution", async () => {
    const { root, config, provisioner } = await fixture();
    const input = {
      userId: userId(1),
      email: "employee@example.test",
      displayName: "Synthetic Employee",
    };
    await provisioner.provision(input);
    await expect(provisioner.provision({ ...input, displayName: "Changed identity" }))
      .rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });

    const outside = path.join(root, "outside");
    await mkdir(outside);
    await chmod(outside, 0o700);
    await symlink(outside, path.join(config.paths.usersRoot, userId(2)));
    await expect(provisioner.provision({
      userId: userId(2),
      email: "other@example.test",
      displayName: "Other Employee",
    })).rejects.toMatchObject({ code: "USER_PATH_UNSAFE" });
  });
});
