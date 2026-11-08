import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileMemoryProposalStore } from "@/memory/proposal-store";

const USER_A = "00000000-0000-4000-8000-000000000001"; const USER_B = "00000000-0000-4000-8000-000000000002"; const PROJECT_A = "00000000-0000-4000-8000-000000000011"; const PROJECT_B = "00000000-0000-4000-8000-000000000012"; const roots: string[] = [];
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "aibrain-memory-proposals-")); roots.push(root); const dataRoot = path.join(root, "data"); const usersRoot = path.join(dataRoot, "users"); for (const user of [USER_A, USER_B]) await mkdir(path.join(usersRoot, user), { recursive: true, mode: 0o700 }); const config = { schemaVersion: 1, installationId: "arnall-qa", companyName: "Arnall", companySlug: "arnall", publicUrl: "https://arnall.example", branding: { productName: "Arnall AI", logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#315ee7" }, paths: { dataRoot, usersRoot, companyContextRoot: path.join(dataRoot, "company"), sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(dataRoot, "backups") } } satisfies InstallationConfig; let tick = 0; const store = new FileMemoryProposalStore({ config, now: () => Date.parse("2026-08-30T10:00:00.000Z") + tick++ }); return { root, config, store, a: { installationId: config.installationId, userId: USER_A, projectId: PROJECT_A }, b: { installationId: config.installationId, userId: USER_B, projectId: PROJECT_A } }; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const proposal = (callId: string, scope: "private" | "project" | "company" = "private") => ({ kind: "decision" as const, content: `Contenido ${callId}`, proposedScope: scope, threadId: "thread-1", turnId: "turn-1", callId, toolNames: ["aibrain_browser.read"], sourceExcerpt: "El usuario pidió conservar una decisión confirmada." });

describe("memory proposals with explicit confirmation", () => {
  it("does not persist rejected proposals and confirms idempotently only after explicit review", async () => { const { store, a } = await fixture(); const rejected = (await store.propose(a, proposal("call-1"))).proposal; expect(await store.listRecords(a)).toEqual([]); await store.reject(a, { proposalId: rejected.proposalId, explicit: true, reason: "No guardar." }); expect(await store.listRecords(a)).toEqual([]); await expect(store.confirm(a, { proposalId: rejected.proposalId, explicit: true, content: rejected.content, scope: "private", allowCompanyScope: false })).rejects.toMatchObject({ code: "MEMORY_PROPOSAL_REJECTED" }); const pending = (await store.propose(a, proposal("call-2"))).proposal; const first = await store.confirm(a, { proposalId: pending.proposalId, explicit: true, content: "Contenido revisado", scope: "private", allowCompanyScope: false }); const retry = await store.confirm(a, { proposalId: pending.proposalId, explicit: true, content: "Contenido revisado", scope: "private", allowCompanyScope: false }); expect(first.created).toBe(true); expect(retry).toEqual({ memory: first.memory, created: false }); expect((await store.auditLog(a)).map(({ action }) => action)).toEqual(["memory.confirmed", "memory.proposed", "memory.rejected", "memory.proposed"]); });
  it("rejects credential-shaped proposal and edit content", async () => { const { store, a } = await fixture(); await expect(store.propose(a, { ...proposal("secret"), content: "password=abcdefghijklmnop" })).rejects.toMatchObject({ code: "MEMORY_SECRET_REJECTED" }); expect(await store.listProposals(a, "all")).toEqual([]); });
  it("enforces private, project and company scopes across users and projects", async () => { const { store, a, b } = await fixture(); const privateProposal = (await store.propose(a, proposal("private"))).proposal; await store.confirm(a, { proposalId: privateProposal.proposalId, explicit: true, content: privateProposal.content, scope: "private", allowCompanyScope: false }); expect(await store.listRecords(b)).toEqual([]); const projectProposal = (await store.propose(a, proposal("project", "project"))).proposal; const projectMemory = (await store.confirm(a, { proposalId: projectProposal.proposalId, explicit: true, content: projectProposal.content, scope: "project", allowCompanyScope: false })).memory; expect((await store.listRecords(a)).map(({ memoryId }) => memoryId)).toContain(projectMemory.memoryId); expect((await store.listRecords({ ...a, projectId: PROJECT_B })).map(({ memoryId }) => memoryId)).not.toContain(projectMemory.memoryId); const companyProposal = (await store.propose(a, proposal("company", "company"))).proposal; await expect(store.confirm(a, { proposalId: companyProposal.proposalId, explicit: true, content: companyProposal.content, scope: "company", allowCompanyScope: false })).rejects.toMatchObject({ code: "MEMORY_COMPANY_SCOPE_FORBIDDEN" }); const company = (await store.confirm(a, { proposalId: companyProposal.proposalId, explicit: true, content: companyProposal.content, scope: "company", allowCompanyScope: true })).memory; expect((await store.listRecords(b)).map(({ memoryId }) => memoryId)).toContain(company.memoryId); });
  it("keeps edits, deletion and restart durable and rejects unsafe paths", async () => { const { root, config, store, a } = await fixture(); const pending = (await store.propose(a, proposal("edit"))).proposal; const memory = (await store.confirm(a, { proposalId: pending.proposalId, explicit: true, content: pending.content, scope: "private", allowCompanyScope: false })).memory; const updated = await store.update(a, { memoryId: memory.memoryId, explicit: true, expectedRevision: 1, content: "Contenido editado", allowCompanyScope: false }); expect(updated.revision).toBe(2); const restarted = new FileMemoryProposalStore({ config }); expect((await restarted.listRecords(a))[0].content).toBe("Contenido editado"); await restarted.delete(a, { memoryId: memory.memoryId, explicit: true, expectedRevision: 2, allowCompanyScope: false }); expect(await restarted.listRecords(a)).toEqual([]); const userRoot = path.join(config.paths.usersRoot, USER_B); await rm(userRoot, { recursive: true }); await symlink(path.join(root, "outside"), userRoot); await expect(restarted.listRecords({ ...a, userId: USER_B })).rejects.toBeInstanceOf(Error); });
  it("restores a soft-deleted memory durably without widening its user or project scope", async () => {
    const { config, store, a, b } = await fixture();
    const pending = (await store.propose(a, proposal("restore", "project"))).proposal;
    const memory = (await store.confirm(a, {
      proposalId: pending.proposalId,
      explicit: true,
      content: pending.content,
      scope: "project",
      allowCompanyScope: false,
    })).memory;
    const deleted = await store.delete(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 1,
      allowCompanyScope: false,
    });

    expect(deleted).toMatchObject({ status: "deleted", revision: 2 });
    expect(await store.listRecords(a)).toEqual([]);
    await expect(store.restore(b, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 2,
      allowCompanyScope: false,
    })).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
    await expect(store.restore({ ...a, projectId: PROJECT_B }, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 2,
      allowCompanyScope: false,
    })).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
    await expect(store.restore(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 1,
      allowCompanyScope: false,
    })).rejects.toMatchObject({ code: "MEMORY_REVISION_CONFLICT" });

    const restored = await store.restore(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 2,
      allowCompanyScope: false,
    });
    expect(restored).toMatchObject({ status: "active", revision: 3, deletedAt: null, deletedBy: null });
    expect((await new FileMemoryProposalStore({ config }).listRecords(a))[0]).toMatchObject({
      memoryId: memory.memoryId,
      status: "active",
      revision: 3,
    });
    expect((await store.auditLog(a)).map(({ action }) => action)).toContain("memory.restored");
  });

  it("keeps update, deletion and restoration state unchanged when their durable audit append fails, then retries after restart", async () => {
    const { config, store, a } = await fixture();
    const pending = (await store.propose(a, proposal("audited-transitions"))).proposal;
    const memory = (await store.confirm(a, {
      proposalId: pending.proposalId,
      explicit: true,
      content: pending.content,
      scope: "private",
      allowCompanyScope: false,
    })).memory;
    const appendFailure = () => { throw new Error("injected audit append failure"); };

    const failingUpdate = new FileMemoryProposalStore({ config, beforeAuditAppend: appendFailure });
    await expect(failingUpdate.update(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 1,
      content: "Contenido actualizado con auditoría durable",
      allowCompanyScope: false,
    })).rejects.toThrow("injected audit append failure");
    let restarted = new FileMemoryProposalStore({ config });
    expect((await restarted.listRecords(a))[0]).toMatchObject({ content: memory.content, revision: 1, status: "active" });
    const updated = await restarted.update(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 1,
      content: "Contenido actualizado con auditoría durable",
      allowCompanyScope: false,
    });
    expect(updated).toMatchObject({ revision: 2, status: "active" });
    await expect(new FileMemoryProposalStore({ config, beforeAuditAppend: appendFailure }).update(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 1,
      content: "Contenido actualizado con auditoría durable",
      allowCompanyScope: false,
    })).resolves.toMatchObject({ revision: 2, status: "active" });

    const failingDelete = new FileMemoryProposalStore({ config, beforeAuditAppend: appendFailure });
    await expect(failingDelete.delete(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 2,
      allowCompanyScope: false,
    })).rejects.toThrow("injected audit append failure");
    restarted = new FileMemoryProposalStore({ config });
    expect((await restarted.listRecords(a))[0]).toMatchObject({ revision: 2, status: "active" });
    const deleted = await restarted.delete(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 2,
      allowCompanyScope: false,
    });
    expect(deleted).toMatchObject({ revision: 3, status: "deleted" });
    await expect(new FileMemoryProposalStore({ config, beforeAuditAppend: appendFailure }).delete(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 2,
      allowCompanyScope: false,
    })).resolves.toMatchObject({ revision: 3, status: "deleted" });

    const failingRestore = new FileMemoryProposalStore({ config, beforeAuditAppend: appendFailure });
    await expect(failingRestore.restore(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 3,
      allowCompanyScope: false,
    })).rejects.toThrow("injected audit append failure");
    restarted = new FileMemoryProposalStore({ config });
    expect((await restarted.listRecords(a, true))[0]).toMatchObject({ revision: 3, status: "deleted" });
    const restored = await restarted.restore(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 3,
      allowCompanyScope: false,
    });
    expect(restored).toMatchObject({ revision: 4, status: "active" });
    await expect(new FileMemoryProposalStore({ config, beforeAuditAppend: appendFailure }).restore(a, {
      memoryId: memory.memoryId,
      explicit: true,
      expectedRevision: 3,
      allowCompanyScope: false,
    })).resolves.toMatchObject({ revision: 4, status: "active" });

    const transitionActions = (await restarted.auditLog(a)).map(({ action }) => action)
      .filter((action) => action === "memory.updated" || action === "memory.deleted" || action === "memory.restored");
    expect(transitionActions).toEqual(["memory.restored", "memory.deleted", "memory.updated"]);
  });

  it("does not disclose deleted company memories to members without company-management permission", async () => {
    const { store, a, b } = await fixture();
    const pending = (await store.propose(a, proposal("deleted-company", "company"))).proposal;
    const companyMemory = (await store.confirm(a, {
      proposalId: pending.proposalId,
      explicit: true,
      content: pending.content,
      scope: "company",
      allowCompanyScope: true,
    })).memory;
    await store.delete(a, {
      memoryId: companyMemory.memoryId,
      explicit: true,
      expectedRevision: 1,
      allowCompanyScope: true,
    });

    expect((await store.listRecords(b, true, false)).map(({ memoryId }) => memoryId)).not.toContain(companyMemory.memoryId);
    expect((await store.listRecords(a, true, true)).map(({ memoryId }) => memoryId)).toContain(companyMemory.memoryId);
  });
});
