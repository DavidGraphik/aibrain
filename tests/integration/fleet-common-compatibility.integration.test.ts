import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import { ensureInstallationCatalog } from "@/catalog/baseline";
import { FileCatalogStore } from "@/catalog/store";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { WorkbenchNotFoundError } from "@/workbench/errors";
import { approvalResolutionForItem, isApprovalItem, type ApprovalItem, type ChatMessage } from "@/lib/chat-contract";

vi.mock("server-only", () => ({}));

const installationIds = ["trinalum-production", "g03-production", "insijets-demo", "modtime", "company-qa"];
const actor = "10000000-0000-4000-8000-000000000001";
const otherActor = "10000000-0000-4000-8000-000000000002";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("one product across isolated client installations", () => {
  it("persists and resumes independent conversations for the same actor UUID without sharing files or permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-fleet-"));
    roots.push(root);
    const fixture = JSON.parse(await readFile("config/installations/qa.example.json", "utf8"));
    const installations = await Promise.all(installationIds.map(async installationId => {
      const dataRoot = path.join(root, installationId, "data");
      const config = parseInstallationConfig({ ...fixture, installationId,
        paths: { dataRoot, companyContextRoot: path.join(dataRoot, "context"),
          usersRoot: path.join(dataRoot, "users"), backupsRoot: path.join(dataRoot, "backups"),
          sourceReadRoot: path.join(root, installationId, "source"),
          publishWriteRoot: path.join(root, installationId, "published") } });
      await mkdir(path.join(config.paths.usersRoot, actor), { recursive: true, mode: 0o700 });
      await mkdir(path.join(config.paths.usersRoot, otherActor), { recursive: true, mode: 0o700 });
      const store = new FileWorkbenchStore({ installationId, usersRoot: config.paths.usersRoot });
      const project = await store.createProject(actor, `Synthetic private project ${installationId}`);
      const thread = await store.createThread(actor, project.id, "Synthetic compatibility check");
      const message = (role: ChatMessage["role"], status: ChatMessage["status"]): ChatMessage => ({
        id: randomUUID(), role, status, content: role === "user" ? "Synthetic request" : `Synthetic answer ${installationId}`,
        createdAt: new Date().toISOString(), activity: [], plan: [], approvals: [],
        diff: "", attachments: [], artifacts: [],
      });
      const prompt = message("user", "complete");
      const answer = message("assistant", "streaming");
      await store.beginThreadTurn(actor, thread.id, prompt, answer);
      await store.finishThreadTurn(actor, thread.id, { ...answer, status: "complete" }, null);
      return { config, project, thread };
    }));
    for (const own of installations) {
      const restarted = new FileWorkbenchStore({ installationId: own.config.installationId, usersRoot: own.config.paths.usersRoot });
      expect((await restarted.getThread(actor, own.thread.id)).messages.at(-1)?.content).toBe(`Synthetic answer ${own.config.installationId}`);
      await expect(restarted.getThread(otherActor, own.thread.id)).rejects.toBeInstanceOf(WorkbenchNotFoundError);
      for (const foreign of installations.filter(candidate => candidate !== own)) {
        await expect(restarted.getThread(actor, foreign.thread.id)).rejects.toBeInstanceOf(WorkbenchNotFoundError);
      }
    }
  });

  it("does not enable another customer's optional connectors when loading the common catalog", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-fleet-catalog-"));
    roots.push(root);
    const fixture = JSON.parse(await readFile("config/installations/qa.example.json", "utf8"));
    for (const installationId of installationIds) {
      const dataRoot = path.join(root, installationId, "data");
      const config = parseInstallationConfig({ ...fixture, installationId,
        ...(installationId === "company-qa" ? { connectors: { companyMail: { enabled: true,
          host: "mail.example.test", emailDomain: "example.test" } } } : {}),
        paths: { dataRoot, companyContextRoot: path.join(dataRoot, "context"),
          usersRoot: path.join(dataRoot, "users"), backupsRoot: path.join(dataRoot, "backups"),
          sourceReadRoot: path.join(root, installationId, "source"), publishWriteRoot: path.join(root, installationId, "published") } });
      const catalog = await ensureInstallationCatalog(new FileCatalogStore(installationId, dataRoot), config);
      expect(catalog.resources.some(resource => resource.id === "company-mail")).toBe(installationId === "company-qa");
      expect(catalog.resources.some(resource => resource.id === "g03-sage")).toBe(installationId === "g03-production");
      expect(catalog.resources.some(resource => resource.connectorId?.startsWith("composio-"))).toBe(false);
    }
  });
});

describe("connector approvals retained across client branches", () => {
  const base: ApprovalItem = { id: "approval", threadId: "thread", turnId: "turn", itemId: "item",
    kind: "file", title: "Synthetic exact action", detail: "Synthetic review", status: "pending" };
  it.each(["authorizationFingerprint", "connectorAuthorizationFingerprint"] as const)("keeps %s bound to the original decision", field => {
    const item = { ...base, [field]: "a".repeat(64) };
    expect(isApprovalItem(item)).toBe(true);
    expect(approvalResolutionForItem(item, "accept")).toMatchObject({ authorizationFingerprint: "a".repeat(64) });
  });
  it("rejects ambiguous approval identities before sending a connector decision", () => {
    const item = { ...base, authorizationFingerprint: "a".repeat(64), connectorAuthorizationFingerprint: "b".repeat(64) };
    expect(isApprovalItem(item)).toBe(false);
    expect(() => approvalResolutionForItem(item, "accept")).toThrow("Conflicting connector authorization fingerprints");
  });
});
