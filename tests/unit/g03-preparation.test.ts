import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import { parsePermissionMarkdown } from "@/permissions/markdown-parser";
import { UserProvisioner, type UserProvisioningInput } from "@/users/provisioner";
import { LocalFileMemoryService } from "@/memory/local-file-memory-service";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "g03-installation-contract-"));
  temporaryRoots.push(root);
  const template = JSON.parse(await readFile("config/installations/development.example.json", "utf8"));
  const config = parseInstallationConfig({ ...template, paths: {
    dataRoot: path.join(root, "data"), companyContextRoot: path.join(root, "data/company"),
    usersRoot: path.join(root, "data/users"), sourceReadRoot: path.join(root, "source-ro"),
    publishWriteRoot: path.join(root, "publish-rw"), backupsRoot: path.join(root, "data/backups"),
  } });
  const users: UserProvisioningInput[] = Array.from({ length: 6 }, (_, index) => ({
    userId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    email: `person-${index + 1}@example.test`, displayName: `Synthetic employee ${index + 1}`,
  }));
  const seed = path.join(root, "synthetic-company-seed");
  await mkdir(path.join(seed, "knowledge/pending"), { recursive: true });
  await writeFile(path.join(seed, "10_IDENTITY.md"), "# Synthetic company\n");
  await writeFile(path.join(seed, "knowledge/pending/OPEN_QUESTIONS.md"), "# Pending\nFixture contact: synthetic operator\n");
  const provisioner = new UserProvisioner(config, { companyContextSeedRoot: seed });
  return { config, users, provisioner };
}

describe("G03 preparation: synthetic local installation, no provider acceptance", () => {
  it("provisions six isolated synthetic workers and replays without creating duplicates", async () => {
    const { config, users, provisioner } = await fixture();
    const first = [];
    for (const input of users) first.push(await provisioner.provision(input));
    expect(first.every(item => item.created)).toBe(true);
    expect(new Set(first.map(item => item.userRoot)).size).toBe(6);
    expect(new Set(first.map(item => item.workerId)).size).toBe(6);
    for (const input of users) {
      const replay = await provisioner.provision(input);
      expect(replay.created).toBe(false);
      expect((await lstat(replay.userRoot)).mode & 0o777).toBe(0o700);
      const policy = parsePermissionMarkdown(await readFile(path.join(replay.userRoot, "PERMISSIONS.md"), "utf8"));
      expect(policy.installationId).toBe(config.installationId);
      expect(policy.userId).toBe(input.userId);
      expect(policy.rules.find(rule => rule.ruleId === "documents.publish")?.effect).toBe("deny");
    }
  });

  it("preserves edited company context and rejects foreign context reads", async () => {
    const { config, users, provisioner } = await fixture();
    await provisioner.provision(users[0]);
    const identity = path.join(config.paths.companyContextRoot, "10_IDENTITY.md");
    await chmod(identity, 0o600);
    await writeFile(identity, "# Operator-reviewed synthetic identity\n", "utf8");
    await provisioner.ensureInstallationPolicy();
    expect(await readFile(identity, "utf8")).toContain("Operator-reviewed synthetic identity");
    const service = new LocalFileMemoryService({ config });
    const context = { installationId: config.installationId, userId: users[0].userId };
    expect(await service.readKnowledge(context, "pending/OPEN_QUESTIONS.md")).toContain("Fixture contact");
    await expect(service.readKnowledge({ ...context, installationId: "foreign" }, "pending/OPEN_QUESTIONS.md")).rejects.toThrow();
    await expect(service.readKnowledge(context, "../../PERMISSIONS.md")).rejects.toThrow();
  });

});
