import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import {
  drainAutomaticMemoryJobs,
  enqueueAutomaticMemoryExtraction,
  extractAutomaticMemoryCandidates,
  runAutomaticMemoryExtraction,
} from "@/memory/automatic-extraction";
import { LocalFileMemoryService } from "@/memory/local-file-memory-service";
import { FileMemoryProposalStore } from "@/memory/proposal-store";
import { UserProvisioner } from "@/users/provisioner";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const PROJECT = "00000000-0000-4000-8000-000000000011";
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-automatic-memory-"));
  roots.push(root);
  const config = parseInstallationConfig({
    schemaVersion: 1,
    installationId: "automatic-memory-qa",
    companyName: "Automatic Memory QA",
    companySlug: "automatic-memory",
    publicUrl: "http://127.0.0.1:3000",
    branding: { productName: "Memory QA", logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#315ee7" },
    paths: {
      dataRoot: path.join(root, "data"),
      companyContextRoot: path.join(root, "data", "company"),
      usersRoot: path.join(root, "data", "users"),
      sourceReadRoot: path.join(root, "source"),
      publishWriteRoot: path.join(root, "publish"),
      backupsRoot: path.join(root, "data", "backups"),
    },
  });
  const provisioner = new UserProvisioner(config);
  await provisioner.provision({ userId: USER_A, email: "a@example.test", displayName: "Employee A" });
  await provisioner.provision({ userId: USER_B, email: "b@example.test", displayName: "Employee B" });
  const store = new FileMemoryProposalStore({ config });
  return {
    config,
    store,
    a: { installationId: config.installationId, userId: USER_A, projectId: PROJECT },
    b: { installationId: config.installationId, userId: USER_B, projectId: PROJECT },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("automatic private conversation memory", () => {
  it("extracts stable facts but rejects secrets and ephemeral instructions", () => {
    expect(extractAutomaticMemoryCandidates("Prefiero recibir los informes semanales en PDF.")).toEqual([
      expect.objectContaining({ kind: "recollection", scope: "private", semanticKey: "recollection-recibir-los-informes" }),
    ]);
    expect(extractAutomaticMemoryCandidates("Recuerda que password=supersecret123456789.")).toEqual([]);
    expect(extractAutomaticMemoryCandidates("Hoy prefiero recibir el informe a las cinco.")).toEqual([]);
  });

  it("creates, deduplicates, versions and deletes without crossing user boundaries", async () => {
    const { config, store, a, b } = await fixture();
    const run = (turnId: string, message: string) => runAutomaticMemoryExtraction({ config, context: a, threadId: "thread-private", turnId, message, store });
    const first = await run("turn-1", "Prefiero recibir los informes semanales en PDF.");
    expect(first[0]).toMatchObject({ outcome: "created", memory: { revision: 1, scope: "private" } });
    const duplicate = await run("turn-2", "Prefiero recibir los informes semanales en PDF.");
    expect(duplicate[0]).toMatchObject({ outcome: "deduplicated", memory: { memoryId: first[0].memory.memoryId, revision: 1 } });
    const changed = await run("turn-3", "Prefiero recibir los informes semanales en DOCX.");
    expect(changed[0]).toMatchObject({ outcome: "versioned", memory: { memoryId: first[0].memory.memoryId, revision: 2 } });
    expect((await store.listRecords(a))[0].content).toContain("DOCX");
    expect(await store.listRecords(b)).toEqual([]);

    const projectDecision = await run("turn-project", "Hemos decidido que el proyecto Atlas se entrega en PDF.");
    expect(projectDecision[0]).toMatchObject({ outcome: "created", memory: { scope: "project", projectId: PROJECT } });
    expect((await store.listRecords({ ...a, projectId: "00000000-0000-4000-8000-000000000012" })).map(({ memoryId }) => memoryId))
      .not.toContain(projectDecision[0].memory.memoryId);

    const deleted = await store.delete(a, { memoryId: first[0].memory.memoryId, explicit: true, expectedRevision: 2, allowCompanyScope: false });
    expect(deleted.status).toBe("deleted");
    const suppressed = await run("turn-4", "Prefiero recibir los informes semanales en XLSX.");
    expect(suppressed[0].outcome).toBe("suppressed");
    expect((await store.listRecords(a)).map(({ memoryId }) => memoryId)).not.toContain(first[0].memory.memoryId);
  });

  it("returns the relevant automatic memory in the next turn", async () => {
    const { config, store, a } = await fixture();
    await runAutomaticMemoryExtraction({ config, context: a, threadId: "thread-1", turnId: "turn-name", message: "Mi nombre es David Liria y trabajo en GraphikAI.", store });
    const preferred = await runAutomaticMemoryExtraction({ config, context: a, threadId: "thread-1", turnId: "turn-report", message: "Prefiero recibir los informes semanales en PDF.", store });
    const service = new LocalFileMemoryService({ config });
    const snapshot = await service.buildPromptSnapshot(a, { maxItems: 1, maxCharacters: 12_000, query: "¿En qué formato preparo el informe semanal?" });
    expect(snapshot.memoryIds).toEqual([preferred[0].memory.memoryId]);
    expect(snapshot.text).toContain("informes semanales en PDF");
    expect(snapshot.text).not.toContain("David Liria");
  });

  it("persists the job before background extraction and resumes it after restart", async () => {
    const { config, store, a } = await fixture();
    const job = await enqueueAutomaticMemoryExtraction({
      config,
      context: a,
      threadId: "thread-1",
      turnId: "turn-background",
      message: "Prefiero recibir los informes semanales en PDF.",
    });
    expect(job).not.toBeNull();
    expect(await readdir(path.join(config.paths.usersRoot, USER_A, "memory", "automatic-jobs")))
      .toEqual([`${job!.jobId}.json`]);

    const resumed = await drainAutomaticMemoryJobs(config, { userIds: [USER_A], store });
    expect(resumed).toEqual([{ status: "completed", jobId: job!.jobId }]);
    expect((await store.listRecords(a))[0].content).toContain("PDF");
    expect(await readdir(path.join(config.paths.usersRoot, USER_A, "memory", "automatic-jobs"))).toEqual([]);
  });

  it("retries idempotently when the process falls after memory is written but before job deletion", async () => {
    const { config, store, a } = await fixture();
    const job = await enqueueAutomaticMemoryExtraction({
      config,
      context: a,
      threadId: "thread-crash",
      turnId: "turn-crash",
      message: "Prefiero recibir los informes semanales en PDF.",
    });
    const interrupted = await drainAutomaticMemoryJobs(config, {
      userIds: [USER_A],
      store,
      onStage: vi.fn(async () => { throw new Error("simulated-crash-window"); }),
    });
    expect(interrupted).toEqual([{ status: "pending", jobId: job!.jobId, errorCode: "MEMORY_JOB_FAILED" }]);
    expect(await store.listRecords(a)).toHaveLength(1);

    const recovered = await drainAutomaticMemoryJobs(config, { userIds: [USER_A], store });
    expect(recovered).toEqual([{ status: "completed", jobId: job!.jobId }]);
    expect(await store.listRecords(a)).toHaveLength(1);
  });
});
