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
import { afterEach, describe, expect, it } from "vitest";
import { parseInstallationConfig, type InstallationConfig } from "@/config/installation-schema";
import {
  LocalFileMemoryService,
  MemoryServiceError,
} from "@/memory/local-file-memory-service";
import type {
  MemoryContext,
  MemoryProvenance,
  RememberInput,
} from "@/memory/types";
import { UserProvisioner } from "@/users/provisioner";
import { FileMemoryProposalStore } from "@/memory/proposal-store";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const CAPTURED_AT = "2026-08-27T10:00:00.000Z";
const roots: string[] = [];

type Fixture = {
  root: string;
  config: InstallationConfig;
  service: LocalFileMemoryService;
  contextA: MemoryContext;
  contextB: MemoryContext;
};

function provenance(overrides: Partial<MemoryProvenance> = {}): MemoryProvenance {
  return {
    sourceType: "thread",
    sourceId: "thread-123",
    sourceExcerpt: "The employee explicitly asked AiBrain to retain this decision.",
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

function rememberInput(index: number, overrides: Partial<RememberInput> = {}): RememberInput {
  return {
    explicit: true,
    kind: "recollection",
    content: `Explicit memory ${index}`,
    provenance: provenance({ sourceId: `thread-${index}` }),
    idempotencyKey: `remember-${index}`,
    ...overrides,
  };
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-memory-v1-"));
  roots.push(root);
  const config = parseInstallationConfig({
    schemaVersion: 1,
    installationId: "memory-company-qa",
    companyName: "Memory Company QA",
    companySlug: "memory-company",
    publicUrl: "http://127.0.0.1:3000",
    branding: {
      productName: "Memory Brain",
      logoPath: "/branding/memory/logo.svg",
      faviconPath: "/branding/memory/favicon.svg",
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
  const provisioner = new UserProvisioner(config);
  await provisioner.provision({
    userId: USER_A,
    email: "employee-a@example.test",
    displayName: "Employee A",
  });
  await provisioner.provision({
    userId: USER_B,
    email: "employee-b@example.test",
    displayName: "Employee B",
  });
  return {
    root,
    config,
    service: new LocalFileMemoryService({ config }),
    contextA: { installationId: config.installationId, userId: USER_A },
    contextB: { installationId: config.installationId, userId: USER_B },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalFileMemoryService", () => {
  it("injects only active governed memory for the current project and honors deletion plus restoration", async () => {
    const { config, service, contextA, contextB } = await fixture();
    const projectId = "00000000-0000-4000-8000-000000000011";
    const governed = new FileMemoryProposalStore({ config });
    const context = { ...contextA, projectId };
    const proposal = (await governed.propose(context, { kind: "decision", content: "Use the confirmed Arnall handoff.", proposedScope: "project", threadId: "thread-1", turnId: "turn-1", callId: "call-1", toolNames: ["aibrain_browser.read"], sourceExcerpt: "Confirmed in this assisted chat." })).proposal;
    const memory = (await governed.confirm(context, { proposalId: proposal.proposalId, explicit: true, content: proposal.content, scope: "project", allowCompanyScope: false })).memory;
    const snapshot = await service.buildPromptSnapshot(context, { maxItems: 20, maxCharacters: 12_000 });
    expect(snapshot.memoryIds).toContain(memory.memoryId);
    expect(snapshot.text).toContain("Use the confirmed Arnall handoff");
    expect(snapshot.text).toContain('"scope":"project"');
    const otherProject = await service.buildPromptSnapshot({ ...context, projectId: "00000000-0000-4000-8000-000000000012" }, { maxItems: 20, maxCharacters: 12_000 });
    expect(otherProject.memoryIds).not.toContain(memory.memoryId);
    const companyProposal = (await governed.propose(context, { kind: "recollection", content: "Company-wide confirmed context.", proposedScope: "company", threadId: "thread-1", turnId: "turn-1", callId: "call-company", toolNames: [], sourceExcerpt: "Confirmed for the company." })).proposal;
    const companyMemory = (await governed.confirm(context, { proposalId: companyProposal.proposalId, explicit: true, content: companyProposal.content, scope: "company", allowCompanyScope: true })).memory;
    const employeeB = await service.buildPromptSnapshot({ ...contextB, projectId }, { maxItems: 20, maxCharacters: 12_000 });
    expect(employeeB.memoryIds).toContain(companyMemory.memoryId);
    expect(employeeB.memoryIds).not.toContain(memory.memoryId);
    const deleted = await governed.delete(context, { memoryId: memory.memoryId, explicit: true, expectedRevision: 1, allowCompanyScope: false });
    expect((await service.buildPromptSnapshot(context, { maxItems: 20, maxCharacters: 12_000 })).memoryIds).not.toContain(memory.memoryId);
    await governed.restore(context, { memoryId: memory.memoryId, explicit: true, expectedRevision: deleted.revision, allowCompanyScope: false });
    expect((await service.buildPromptSnapshot(context, { maxItems: 20, maxCharacters: 12_000 })).memoryIds).toContain(memory.memoryId);
  });

  it("reads stable company context, indexed knowledge and only the authenticated employee profile", async () => {
    const { config, service, contextA, contextB } = await fixture();
    const knowledgePath = path.join(config.paths.companyContextRoot, "knowledge", "procedures", "handoff.md");
    await writeFile(knowledgePath, "# Handoff\n\nSource-backed procedure.\n", { mode: 0o400 });

    const companyContext = await service.readCompanyContext(contextA);
    expect(companyContext.map(({ fileName }) => fileName)).toEqual([
      "00_SYSTEM.md",
      "10_IDENTITY.md",
      "20_COMPANY.md",
      "30_ORGANIZATION.md",
      "40_WORKFLOWS.md",
      "50_DOCUMENT_RULES.md",
    ]);
    expect(companyContext[1].content).toContain("Memory Company QA");
    expect(await service.readKnowledgeIndex(contextA)).toContain("knowledge/processes/PROCESSES.md");
    expect(await service.listKnowledge(contextA)).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "procedures/handoff.md" }),
    ]));
    expect(await service.readKnowledge(contextA, "procedures/handoff.md"))
      .toContain("Source-backed procedure");

    const employeeA = await service.readEmployeeContext(contextA);
    const employeeB = await service.readEmployeeContext(contextB);
    expect(employeeA.profile).toContain("Employee A");
    expect(employeeA.profile).not.toContain("Employee B");
    expect(employeeB.profile).toContain("Employee B");
    const snapshotA = await service.buildPromptSnapshot(contextA, {
      maxItems: 20,
      maxCharacters: 12_000,
    });
    const snapshotPayload = JSON.parse(snapshotA.text) as {
      companyContext: Array<{ fileName: string }>;
      knowledgeIndex: { fileName: string };
      employeeContext: { profile: string };
    };
    expect(snapshotA.text.length).toBeLessThanOrEqual(12_000);
    expect(snapshotPayload.companyContext.map(({ fileName }) => fileName)).toEqual([
      "00_SYSTEM.md",
      "10_IDENTITY.md",
      "20_COMPANY.md",
      "30_ORGANIZATION.md",
      "40_WORKFLOWS.md",
      "50_DOCUMENT_RULES.md",
    ]);
    expect(snapshotPayload.knowledgeIndex.fileName).toBe("KNOWLEDGE_INDEX.md");
    expect(snapshotPayload.employeeContext.profile).toContain("Employee A");
    expect(snapshotA.text).not.toContain("Employee B");
    expect(snapshotA.text).not.toContain("Source-backed procedure");
    await expect(service.readKnowledge(contextA, "../PROFILE.md"))
      .rejects.toMatchObject({ code: "MEMORY_KNOWLEDGE_PATH_INVALID" });
  });

  it("shares snapshot truncation across long documents instead of erasing one workflow", async () => {
    const { config, service, contextA } = await fixture();
    await chmod(path.join(config.paths.companyContextRoot, "40_WORKFLOWS.md"), 0o600);
    await chmod(path.join(config.paths.companyContextRoot, "20_COMPANY.md"), 0o600);
    await writeFile(path.join(config.paths.companyContextRoot, "40_WORKFLOWS.md"),
      "Use the verified order summary.\n" + "W".repeat(4_500));
    await writeFile(path.join(config.paths.companyContextRoot, "20_COMPANY.md"),
      "Company background.\n" + "C".repeat(4_000));
    const snapshot = await service.buildPromptSnapshot(contextA, { maxCharacters: 4_096 });
    const payload = JSON.parse(snapshot.text);
    const workflow = payload.companyContext.find((entry: { fileName: string }) => entry.fileName === "40_WORKFLOWS.md");
    const company = payload.companyContext.find((entry: { fileName: string }) => entry.fileName === "20_COMPANY.md");
    expect(snapshot.text.length).toBeLessThanOrEqual(4_096);
    expect(snapshot.truncated).toBe(true);
    expect(workflow.content).toContain("Use the verified order summary.");
    expect(workflow.content.length).toBeGreaterThan(500);
    expect(company.content.length).toBeGreaterThan(500);
    expect(workflow.contentTruncated).toBe(true);
    expect(company.contentTruncated).toBe(true);
    expect(snapshot.text).not.toContain("Employee B");
  });

  it("requires explicit writes, preserves provenance and is idempotent across restart", async () => {
    const { config, service, contextA } = await fixture();
    const implicit = { ...rememberInput(1), explicit: false } as unknown as RememberInput;
    await expect(service.remember(contextA, implicit)).rejects.toMatchObject({
      code: "STORAGE_SCHEMA_INVALID",
    });

    const input = rememberInput(2, { kind: "decision", content: "Use the approved delivery workflow." });
    const first = await service.remember(contextA, input);
    const duplicate = await service.remember(contextA, {
      ...input,
      provenance: { ...input.provenance, capturedAt: "2026-08-27T10:00:01.000Z" },
    });
    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ memory: first.memory, created: false });
    expect(first.memory).toMatchObject({
      schemaVersion: 1,
      installationId: config.installationId,
      subjectUserId: USER_A,
      explicit: true,
      kind: "decision",
      status: "active",
      provenance: { sourceType: "thread", sourceId: "thread-2" },
    });
    await expect(service.remember(contextA, { ...input, content: "Conflicting content" }))
      .rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_CONFLICT" });

    const restarted = new LocalFileMemoryService({ config });
    expect(await restarted.read(contextA, first.memory.memoryId)).toEqual(first.memory);
    expect(await restarted.list(contextA)).toEqual([first.memory]);
    const snapshot = await restarted.buildPromptSnapshot(contextA, {
      maxItems: 1,
      maxCharacters: 4_096,
    });
    expect(snapshot.memoryIds).toEqual([first.memory.memoryId]);
    expect(snapshot.text).toContain("untrusted-data-only");
    expect(snapshot.text).toContain("Use the approved delivery workflow");
    expect(snapshot.text).toContain("Memory Company QA");
    expect(snapshot.text).toContain("Employee A");
    expect(snapshot.text).not.toContain("Employee B");

    const revoked = await restarted.revoke(contextA, {
      explicit: true,
      memoryId: first.memory.memoryId,
      reason: "The employee explicitly replaced this decision.",
      idempotencyKey: "revoke-2",
    });
    expect(revoked.changed).toBe(true);
    expect(revoked.memory).toMatchObject({ status: "revoked", revokedBy: USER_A });
    expect((await restarted.revoke(contextA, {
      explicit: true,
      memoryId: first.memory.memoryId,
      reason: "The employee explicitly replaced this decision.",
      idempotencyKey: "revoke-2",
    })).changed).toBe(false);
    expect(await restarted.list(contextA)).toEqual([]);
    expect(await restarted.list(contextA, { status: "revoked" })).toEqual([revoked.memory]);
  });

  it("isolates installations and employee journals", async () => {
    const { config, service, contextA, contextB } = await fixture();
    const memoryA = (await service.remember(contextA, rememberInput(1))).memory;
    const memoryB = (await service.remember(contextB, rememberInput(1))).memory;
    expect(await service.read(contextA, memoryB.memoryId)).toBeNull();
    expect(await service.read(contextB, memoryA.memoryId)).toBeNull();
    expect((await service.list(contextA)).map(({ memoryId }) => memoryId)).toEqual([memoryA.memoryId]);
    expect((await service.list(contextB)).map(({ memoryId }) => memoryId)).toEqual([memoryB.memoryId]);
    await expect(service.list({ installationId: "other-company", userId: USER_A }))
      .rejects.toMatchObject({ code: "MEMORY_INSTALLATION_MISMATCH" });

    const otherConfig = { ...config, installationId: "other-company" };
    const otherService = new LocalFileMemoryService({ config: otherConfig });
    await expect(otherService.list({ installationId: "other-company", userId: USER_A }))
      .rejects.toBeInstanceOf(Error);
  });

  it("serializes concurrent writes and deduplicates a shared idempotency key", async () => {
    const { config, service, contextA } = await fixture();
    const input = rememberInput(1);
    const duplicates = await Promise.all(
      Array.from({ length: 25 }, () => service.remember(contextA, input)),
    );
    expect(duplicates.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(duplicates.map(({ memory }) => memory.memoryId))).toHaveLength(1);

    await Promise.all(Array.from({ length: 30 }, (_, index) => (
      new LocalFileMemoryService({ config }).remember(contextA, rememberInput(index + 2))
    )));
    expect(await service.list(contextA, { status: "all", limit: 100 })).toHaveLength(31);
    const journal = await readFile(
      path.join(config.paths.usersRoot, USER_A, "memory", "events.jsonl"),
      "utf8",
    );
    expect(journal.trim().split("\n")).toHaveLength(31);
  }, 20_000);

  it("repairs an incomplete journal tail, rebuilds a corrupt index and fails closed on complete corruption", async () => {
    const { config, service, contextA } = await fixture();
    const memory = (await service.remember(contextA, rememberInput(1))).memory;
    const memoryRoot = path.join(config.paths.usersRoot, USER_A, "memory");
    const journalPath = path.join(memoryRoot, "events.jsonl");
    const indexPath = path.join(memoryRoot, "index.json");
    await writeFile(journalPath, "{\"incomplete\":", { flag: "a" });
    await writeFile(indexPath, "not-json\n");

    const restarted = new LocalFileMemoryService({ config });
    expect(await restarted.list(contextA)).toEqual([memory]);
    expect(await readFile(journalPath, "utf8")).not.toContain("incomplete");
    expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      lastSequence: 1,
    });

    await writeFile(journalPath, "{}\n", { flag: "a" });
    await expect(new LocalFileMemoryService({ config }).list(contextA))
      .rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
  });

  it("rejects memory and knowledge symlink substitution", async () => {
    const { root, config, service, contextA } = await fixture();
    const memoryRoot = path.join(config.paths.usersRoot, USER_A, "memory");
    const outside = path.join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await rm(memoryRoot, { recursive: true });
    await symlink(outside, memoryRoot);
    await expect(service.list(contextA)).rejects.toMatchObject({ code: "MEMORY_PATH_UNSAFE" });

    await rm(memoryRoot);
    await mkdir(memoryRoot, { mode: 0o700 });
    const outsideFile = path.join(outside, "secret.md");
    await writeFile(outsideFile, "secret");
    const knowledgeLink = path.join(config.paths.companyContextRoot, "knowledge", "sources", "link.md");
    await symlink(outsideFile, knowledgeLink);
    await expect(service.listKnowledge(contextA)).rejects.toMatchObject({ code: "MEMORY_PATH_UNSAFE" });
    await expect(service.readKnowledge(contextA, "sources/link.md")).rejects.toBeInstanceOf(Error);

    const profilePath = path.join(config.paths.usersRoot, USER_A, "PROFILE.md");
    await rm(profilePath);
    await symlink(outsideFile, profilePath);
    await expect(service.buildPromptSnapshot(contextA, {
      maxItems: 20,
      maxCharacters: 12_000,
    })).rejects.toBeInstanceOf(Error);
  });

  it("returns typed service errors for malformed runtime inputs", async () => {
    const { config, service, contextA } = await fixture();
    await expect(service.read(contextA, "not-a-memory-id")).rejects.toBeInstanceOf(MemoryServiceError);
    await expect(service.remember(contextA, {
      ...rememberInput(1),
      idempotencyKey: "contains spaces",
    })).rejects.toMatchObject({ code: "MEMORY_IDEMPOTENCY_KEY_INVALID" });
    await expect(service.buildPromptSnapshot(contextA, { maxCharacters: 10 }))
      .rejects.toMatchObject({ code: "MEMORY_SNAPSHOT_INVALID" });

    await service.remember(contextA, rememberInput(2, { content: "x".repeat(8_000) }));
    const bounded = await service.buildPromptSnapshot(contextA, {
      maxItems: 1,
      maxCharacters: 4_096,
    });
    expect(bounded.text.length).toBeLessThanOrEqual(4_096);
    expect(bounded.truncated).toBe(true);

    await writeFile(
      path.join(config.paths.usersRoot, USER_A, "PREFERENCES.md"),
      Buffer.from([0xff, 0xfe]),
    );
    await expect(service.buildPromptSnapshot(contextA, {
      maxItems: 20,
      maxCharacters: 12_000,
    })).rejects.toMatchObject({ code: "MEMORY_MARKDOWN_INVALID" });
  });
});
