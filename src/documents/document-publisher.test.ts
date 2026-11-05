import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileDocumentPublisher,
  type FileDocumentPublisherOptions,
} from "@/documents/document-publisher";
import { FilePublicationCapacityGate } from "@/documents/publication-capacity";
import type { PublicationPreviewMetadata } from "@/documents/publication-contract";
import { ResourceLockManager } from "@/storage/resource-lock";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const THREAD_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_THREAD_ID = "44444444-4444-4444-8444-444444444444";
const TURN_ID = "55555555-5555-4555-8555-555555555555";
const OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const SECOND_OPERATION_ID = "77777777-7777-4777-8777-777777777777";
const PREVIEW_ID = "88888888-8888-4888-8888-888888888888";
const SECRET = "publication-test-secret-that-is-at-least-32-bytes";

function sha256(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

describe("server-side document publisher", () => {
  let root: string;
  let stagingRoot: string;
  let publishRoot: string;
  let stateRoot: string;
  let workerRoot: string;
  let lockManager: ResourceLockManager;
  let now: number;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aibrain-publisher-"));
    stagingRoot = path.join(root, "staging-user-one");
    publishRoot = path.join(root, "publish-rw");
    stateRoot = path.join(root, "publisher-state");
    workerRoot = path.join(root, "worker-home");
    await Promise.all([
      mkdir(stagingRoot, { recursive: true, mode: 0o700 }),
      mkdir(path.join(publishRoot, "knowledge"), { recursive: true, mode: 0o700 }),
      mkdir(stateRoot, { recursive: true, mode: 0o700 }),
      mkdir(workerRoot, { recursive: true, mode: 0o700 }),
    ]);
    lockManager = new ResourceLockManager({
      rootDirectory: path.join(root, "locks"),
      retryDelayMs: 1,
      maxRetryDelayMs: 4,
      jitterRatio: 0,
    });
    now = Date.parse("2026-08-27T09:00:00.000Z");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function publisher(overrides: Partial<FileDocumentPublisherOptions> = {}) {
    return new FileDocumentPublisher({
      installationId: "qa-company",
      userId: USER_ID,
      stagingRoot,
      publishWriteRoot: publishRoot,
      stateRoot,
      workerVisibleRoots: [stagingRoot, workerRoot],
      lockManager,
      confirmationSecret: SECRET,
      capacityGate: { run: async (_requiredBytes, operation) => operation() },
      now: () => now,
      ...overrides,
    });
  }

  function preview(content: Buffer, overrides: Partial<PublicationPreviewMetadata> = {}): PublicationPreviewMetadata {
    return {
      schemaVersion: 1,
      previewId: PREVIEW_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      candidateSha256: sha256(content),
      status: "ready",
      artifacts: ["preview.pdf", "page-1.png"],
      createdAt: new Date(now).toISOString(),
      ...overrides,
    };
  }

  async function stagedCandidate(
    content: string,
    relativePath = `threads/${THREAD_ID}/candidate.txt`,
  ) {
    const absolutePath = path.join(stagingRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    const data = Buffer.from(content);
    await writeFile(absolutePath, data, { mode: 0o600 });
    return { data, relativePath, absolutePath };
  }

  async function freeze(options: {
    service?: FileDocumentPublisher;
    operationId?: string;
    clientRequestId?: string;
    content?: string;
    candidateRelativePath?: string;
    targetRelativePath?: string;
  } = {}) {
    const service = options.service ?? publisher();
    const staged = await stagedCandidate(
      options.content ?? "approved candidate",
      options.candidateRelativePath,
    );
    const input = {
      operationId: options.operationId ?? OPERATION_ID,
      clientRequestId: options.clientRequestId ?? "freeze-request-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      candidateRelativePath: staged.relativePath,
      targetRelativePath: options.targetRelativePath ?? "knowledge/report.txt",
      preview: preview(staged.data),
    };
    return { service, staged, input, frozen: await service.freezeCandidate(input) };
  }

  it("requires preview attestation and publishes the immutable frozen bytes, not later staging edits", async () => {
    const service = publisher();
    const staged = await stagedCandidate("frozen version");
    await expect(service.freezeCandidate({
      operationId: OPERATION_ID,
      clientRequestId: "bad-preview-request",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      candidateRelativePath: staged.relativePath,
      targetRelativePath: "knowledge/report.txt",
      preview: { ...preview(staged.data), artifacts: [] },
    })).rejects.toMatchObject({ code: "STORAGE_SCHEMA_INVALID" });

    const frozen = await service.freezeCandidate({
      operationId: OPERATION_ID,
      clientRequestId: "freeze-request-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      candidateRelativePath: staged.relativePath,
      targetRelativePath: "knowledge/report.txt",
      preview: preview(staged.data),
    });
    await writeFile(staged.absolutePath, "tampered after preview");
    const result = await service.confirm({
      operationId: OPERATION_ID,
      clientRequestId: "confirm-request-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      confirmationToken: frozen.confirmationToken,
    });

    expect(result.status).toBe("published");
    expect(await readFile(path.join(publishRoot, "knowledge/report.txt"), "utf8")).toBe("frozen version");
  });

  it("declines without touching the official file and makes the decision idempotent", async () => {
    const target = path.join(publishRoot, "knowledge/report.txt");
    await writeFile(target, "official original");
    const { service, frozen } = await freeze();
    const decision = {
      operationId: OPERATION_ID,
      clientRequestId: "decline-request-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      confirmationToken: frozen.confirmationToken,
    };

    const first = await service.decline(decision);
    const repeated = await service.decline(decision);

    expect(first).toEqual(repeated);
    expect(first.status).toBe("declined");
    expect(first.version).toBeNull();
    expect(await readFile(target, "utf8")).toBe("official original");
    expect((await service.readAudit()).map((event) => event.eventType)).toEqual(["frozen", "declined"]);
    await expect(service.confirm({ ...decision, clientRequestId: "confirm-after-decline" }))
      .rejects.toMatchObject({ code: "PUBLICATION_ALREADY_DECIDED" });
  });

  it("rejects low publication-volume capacity before changing durable operation or target state", async () => {
    const target = path.join(publishRoot, "knowledge/report.txt");
    await writeFile(target, "official original");
    const stages: string[] = [];
    const capacityGate = new FilePublicationCapacityGate({
      rootDirectory: path.join(root, "publication-capacity-locks"),
      capacityRoot: publishRoot,
      minimumFreeBytes: 1_000,
      minimumFreeRatioPpm: 0,
      readCapacity: async () => ({ bavail: 999n, bsize: 1n, blocks: 10_000n }),
    });
    const service = publisher({
      capacityGate,
      onStage: async (stage) => { stages.push(stage); },
    });
    const { frozen } = await freeze({ service });
    stages.length = 0;

    await expect(service.confirm({
      operationId: OPERATION_ID,
      clientRequestId: "confirm-with-full-volume",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      confirmationToken: frozen.confirmationToken,
    })).rejects.toMatchObject({
      code: "PUBLICATION_STORAGE_BACKPRESSURE",
      retryable: true,
    });

    expect(stages).toEqual([]);
    await expect(service.getOperation({
      operationId: OPERATION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    })).resolves.toMatchObject({ status: "awaiting_confirmation", version: null, result: null });
    await expect(readFile(target, "utf8")).resolves.toBe("official original");
  });

  it("reconciles confirmation expiry durably at the exact TTL and rejects confirmation", async () => {
    const target = path.join(publishRoot, "knowledge/report.txt");
    await writeFile(target, "official original");
    const service = publisher({ confirmationTtlMs: 60_000 });
    const { frozen } = await freeze({ service });
    const expiresAt = frozen.operation.confirmationExpiresAt;
    now = Date.parse(expiresAt);

    const expired = await service.getOperation({
      operationId: OPERATION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(expired).toMatchObject({
      status: "expired",
      updatedAt: expiresAt,
      version: null,
      result: null,
    });
    await expect(service.confirm({
      operationId: OPERATION_ID,
      clientRequestId: "confirm-expired-request",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      confirmationToken: frozen.confirmationToken,
    })).rejects.toMatchObject({ code: "PUBLICATION_TOKEN_EXPIRED" });
    expect(await readFile(target, "utf8")).toBe("official original");

    const audit = await service.readAudit();
    expect(audit.map((event) => event.eventType)).toEqual(["frozen", "expired"]);
    expect(audit[1]).toMatchObject({
      eventType: "expired",
      occurredAt: expiresAt,
      resultSha256: null,
      recoveredAfterInterruption: false,
    });

    const restarted = publisher({ confirmationTtlMs: 60_000 });
    expect((await restarted.getOperation({
      operationId: OPERATION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    })).status).toBe("expired");
    expect((await restarted.readAudit()).filter((event) => event.eventType === "expired"))
      .toHaveLength(1);
  });

  it("treats decline after automatic expiry as an idempotent close acknowledgement", async () => {
    const service = publisher({ confirmationTtlMs: 1_000 });
    const { frozen } = await freeze({ service });
    now = Date.parse(frozen.operation.confirmationExpiresAt) + 10_000;
    const decision = {
      operationId: OPERATION_ID,
      clientRequestId: "decline-expired-request",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      confirmationToken: frozen.confirmationToken,
    };

    const first = await service.decline(decision);
    const replay = await service.decline(decision);
    const laterAcknowledgement = await service.decline({
      ...decision,
      clientRequestId: "decline-expired-request-later",
    });

    expect(first).toEqual(replay);
    expect(laterAcknowledgement).toEqual(first);
    expect(first.status).toBe("expired");
    expect(first.updatedAt).toBe(frozen.operation.confirmationExpiresAt);
    expect((await service.readAudit()).filter((event) => event.eventType === "expired"))
      .toHaveLength(1);
  });

  it("confirms exactly once, is idempotent for the same request and retains a verified recovery version", async () => {
    const target = path.join(publishRoot, "knowledge/report.txt");
    await writeFile(target, "official original");
    const { service, frozen } = await freeze();
    const decision = {
      operationId: OPERATION_ID,
      clientRequestId: "confirm-request-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      confirmationToken: frozen.confirmationToken,
    };

    const first = await service.confirm(decision);
    const repeated = await service.confirm(decision);

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      status: "published",
      result: { sha256: frozen.operation.candidate.sha256, recoveredAfterInterruption: false },
      version: { sha256: sha256("official original") },
    });
    expect((await service.readRecoveryVersion({
      operationId: OPERATION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    })).toString("utf8")).toBe("official original");
    expect((await service.readAudit()).filter((event) => event.eventType === "published")).toHaveLength(1);
    await expect(service.confirm({ ...decision, clientRequestId: "another-confirm-request" }))
      .rejects.toMatchObject({ code: "PUBLICATION_ALREADY_DECIDED" });

    const exposed = JSON.stringify({ frozen: frozen.operation, published: first });
    expect(exposed).not.toContain(publishRoot);
    expect(exposed).not.toContain(stateRoot);
    expect(exposed).not.toContain(frozen.confirmationToken);
    expect(exposed).not.toContain("snapshotRelativePath");
    expect(exposed).not.toContain("versionRelativePath");
  });

  it("detects an original changed after preview and never publishes the candidate", async () => {
    const target = path.join(publishRoot, "knowledge/report.txt");
    await writeFile(target, "original at preview");
    const { service, frozen } = await freeze();
    now += 1_000;
    await writeFile(target, "changed by another editor");

    const result = await service.confirm({
      operationId: OPERATION_ID,
      clientRequestId: "confirm-request-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      confirmationToken: frozen.confirmationToken,
    });

    expect(result.status).toBe("conflict");
    expect(result.version).toBeNull();
    expect(await readFile(target, "utf8")).toBe("changed by another editor");
    expect((await service.readAudit()).map((event) => event.eventType)).toEqual(["frozen", "conflict"]);
  });

  it("recovers after a crash immediately after the atomic target write without duplicating publication", async () => {
    const target = path.join(publishRoot, "knowledge/report.txt");
    await writeFile(target, "recoverable original");
    let crashOnce = true;
    const crashing = publisher({
      onStage(stage) {
        if (stage === "target-written" && crashOnce) {
          crashOnce = false;
          throw new Error("simulated process crash after target rename");
        }
      },
    });
    const { frozen } = await freeze({ service: crashing });
    const decision = {
      operationId: OPERATION_ID,
      clientRequestId: "confirm-request-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      confirmationToken: frozen.confirmationToken,
    };

    await expect(crashing.confirm(decision)).rejects.toThrow("simulated process crash");
    expect((await crashing.getOperation({
      operationId: OPERATION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    })).status).toBe("publishing");
    expect(await readFile(target, "utf8")).toBe("approved candidate");

    const restarted = publisher();
    const recovered = await restarted.confirm(decision);
    expect(recovered).toMatchObject({
      status: "published",
      result: { recoveredAfterInterruption: true },
    });
    expect((await restarted.readRecoveryVersion({
      operationId: OPERATION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    })).toString("utf8")).toBe("recoverable original");
    expect((await restarted.readAudit()).filter((event) => event.eventType === "published")).toHaveLength(1);
  });

  it("deduplicates a durable published audit event when the process dies before terminal state", async () => {
    let failPublishedAuditOnce = false;
    const crashing = publisher({
      onStage(stage) {
        if (stage === "audit-recorded" && failPublishedAuditOnce) {
          failPublishedAuditOnce = false;
          throw new Error("simulated crash after durable audit append");
        }
      },
    });
    const { frozen } = await freeze({ service: crashing });
    failPublishedAuditOnce = true;
    const decision = {
      operationId: OPERATION_ID,
      clientRequestId: "confirm-request-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      confirmationToken: frozen.confirmationToken,
    };

    await expect(crashing.confirm(decision)).rejects.toThrow("simulated crash after durable audit append");
    expect((await crashing.readAudit()).filter((event) => event.eventType === "published")).toHaveLength(1);

    const restarted = publisher();
    expect((await restarted.confirm(decision)).status).toBe("published");
    expect((await restarted.readAudit()).filter((event) => event.eventType === "published")).toHaveLength(1);
  });

  it("isolates operations by bound user plus thread and rejects reused request ids with different intent", async () => {
    const { service, input } = await freeze();
    await expect(service.getOperation({
      operationId: OPERATION_ID,
      threadId: OTHER_THREAD_ID,
      turnId: TURN_ID,
    })).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_MISMATCH" });

    const otherStaging = path.join(root, "staging-user-two");
    await mkdir(otherStaging, { mode: 0o700 });
    const otherUser = publisher({ userId: OTHER_USER_ID, stagingRoot: otherStaging });
    await expect(otherUser.getOperation({
      operationId: OPERATION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    })).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });

    await expect(service.freezeCandidate({
      ...input,
      operationId: SECOND_OPERATION_ID,
      targetRelativePath: "knowledge/other.txt",
    })).rejects.toMatchObject({ code: "PUBLICATION_REQUEST_CONFLICT" });
  });

  it("serializes publications for one target so only one candidate can win", async () => {
    const target = path.join(publishRoot, "knowledge/report.txt");
    await writeFile(target, "shared original");
    const service = publisher();
    const first = await freeze({
      service,
      operationId: OPERATION_ID,
      clientRequestId: "freeze-first",
      content: "first candidate",
      candidateRelativePath: `threads/${THREAD_ID}/first.txt`,
    });
    const second = await freeze({
      service,
      operationId: SECOND_OPERATION_ID,
      clientRequestId: "freeze-second",
      content: "second candidate",
      candidateRelativePath: `threads/${THREAD_ID}/second.txt`,
    });

    const [firstResult, secondResult] = await Promise.all([
      service.confirm({
        operationId: OPERATION_ID,
        clientRequestId: "confirm-first",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        confirmationToken: first.frozen.confirmationToken,
      }),
      service.confirm({
        operationId: SECOND_OPERATION_ID,
        clientRequestId: "confirm-second",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        confirmationToken: second.frozen.confirmationToken,
      }),
    ]);

    expect([firstResult.status, secondResult.status].sort()).toEqual(["conflict", "published"]);
    expect(["first candidate", "second candidate"]).toContain(await readFile(target, "utf8"));
    expect((await service.readAudit()).filter((event) => event.eventType === "published")).toHaveLength(1);
  });

  it("serializes one official target across two users with separate private state and lock roots", async () => {
    const target = path.join(publishRoot, "knowledge/report.txt");
    await writeFile(target, "shared original");
    const otherStaging = path.join(root, "staging-user-two");
    const otherState = path.join(root, "publisher-state-user-two");
    await Promise.all([
      mkdir(otherStaging, { recursive: true, mode: 0o700 }),
      mkdir(otherState, { recursive: true, mode: 0o700 }),
    ]);
    const otherLocks = new ResourceLockManager({
      rootDirectory: path.join(root, "locks-user-two"),
      retryDelayMs: 1,
      maxRetryDelayMs: 4,
      jitterRatio: 0,
    });
    const sharedTargetLockRoot = path.join(root, "global-publication-target-locks");
    const first = publisher({
      targetLockManager: new ResourceLockManager({
        rootDirectory: sharedTargetLockRoot,
        retryDelayMs: 1,
        maxRetryDelayMs: 4,
        jitterRatio: 0,
      }),
    });
    const second = publisher({
      userId: OTHER_USER_ID,
      stagingRoot: otherStaging,
      stateRoot: otherState,
      lockManager: otherLocks,
      targetLockManager: new ResourceLockManager({
        rootDirectory: sharedTargetLockRoot,
        retryDelayMs: 1,
        maxRetryDelayMs: 4,
        jitterRatio: 0,
      }),
      workerVisibleRoots: [otherStaging, workerRoot],
    });
    const firstCandidate = await stagedCandidate("first user candidate", `threads/${THREAD_ID}/first-user.txt`);
    const secondRelativePath = `threads/${THREAD_ID}/second-user.txt`;
    const secondAbsolutePath = path.join(otherStaging, secondRelativePath);
    await mkdir(path.dirname(secondAbsolutePath), { recursive: true, mode: 0o700 });
    const secondData = Buffer.from("second user candidate");
    await writeFile(secondAbsolutePath, secondData, { mode: 0o600 });
    const firstFrozen = await first.freezeCandidate({
      operationId: OPERATION_ID,
      clientRequestId: "freeze-user-one",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      candidateRelativePath: firstCandidate.relativePath,
      targetRelativePath: "knowledge/report.txt",
      preview: preview(firstCandidate.data),
    });
    const secondFrozen = await second.freezeCandidate({
      operationId: SECOND_OPERATION_ID,
      clientRequestId: "freeze-user-two",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      candidateRelativePath: secondRelativePath,
      targetRelativePath: "knowledge/report.txt",
      preview: preview(secondData, { previewId: "99999999-9999-4999-8999-999999999999" }),
    });

    const [firstResult, secondResult] = await Promise.all([
      first.confirm({
        operationId: OPERATION_ID,
        clientRequestId: "confirm-user-one",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        confirmationToken: firstFrozen.confirmationToken,
      }),
      second.confirm({
        operationId: SECOND_OPERATION_ID,
        clientRequestId: "confirm-user-two",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        confirmationToken: secondFrozen.confirmationToken,
      }),
    ]);

    expect([firstResult.status, secondResult.status].sort()).toEqual(["conflict", "published"]);
    expect(["first user candidate", "second user candidate"]).toContain(await readFile(target, "utf8"));
  });

  it("rejects traversal and symbolic links in staging and publication paths", async () => {
    const service = publisher();
    const candidate = await stagedCandidate("candidate");
    await expect(service.freezeCandidate({
      operationId: OPERATION_ID,
      clientRequestId: "traversal-request",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      candidateRelativePath: candidate.relativePath,
      targetRelativePath: "../outside.txt",
      preview: preview(candidate.data),
    })).rejects.toMatchObject({ code: "PUBLICATION_PATH_INVALID" });

    const outsideCandidate = path.join(root, "outside-candidate.txt");
    await writeFile(outsideCandidate, "outside");
    const linkedCandidate = `threads/${THREAD_ID}/linked.txt`;
    await symlink(outsideCandidate, path.join(stagingRoot, linkedCandidate));
    await expect(service.freezeCandidate({
      operationId: OPERATION_ID,
      clientRequestId: "candidate-link-request",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      candidateRelativePath: linkedCandidate,
      targetRelativePath: "knowledge/report.txt",
      preview: preview(Buffer.from("outside")),
    })).rejects.toMatchObject({ code: "PUBLICATION_CANDIDATE_UNSAFE" });

    const outsideTarget = path.join(root, "outside-target.txt");
    await writeFile(outsideTarget, "must remain unchanged");
    await symlink(outsideTarget, path.join(publishRoot, "knowledge/linked.txt"));
    const safeCandidate = await stagedCandidate("safe", `threads/${THREAD_ID}/safe.txt`);
    await expect(service.freezeCandidate({
      operationId: SECOND_OPERATION_ID,
      clientRequestId: "target-link-request",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      candidateRelativePath: safeCandidate.relativePath,
      targetRelativePath: "knowledge/linked.txt",
      preview: preview(safeCandidate.data),
    })).rejects.toMatchObject({ code: "PUBLICATION_TARGET_UNSAFE" });
    expect(await readFile(outsideTarget, "utf8")).toBe("must remain unchanged");
  });

  it("refuses configurations that expose publish-rw to the worker boundary", () => {
    expect(() => publisher({ workerVisibleRoots: [stagingRoot, publishRoot] }))
      .toThrowError(expect.objectContaining({ code: "PUBLICATION_WORKER_BOUNDARY_INVALID" }));
    expect(() => publisher({ workerVisibleRoots: [root] }))
      .toThrowError(expect.objectContaining({ code: "PUBLICATION_WORKER_BOUNDARY_INVALID" }));
  });
});
