import { afterEach, describe, expect, it, vi } from "vitest";
import { assertUiContract, uiContractErrors } from "../helpers/ui-contract";
import {
  parseDocumentUploadResponse,
  stageDocument,
} from "@/ui/document-ui-adapter";
import {
  isSafePublicationTarget,
  parsePublicationDecisionReceipt,
  parsePublicationFreezeReceipt,
  recoverDocumentPublications,
  decideDocumentPublication,
} from "@/ui/publication-ui-adapter";
import {
  createExplicitMemory,
  listExplicitMemories,
  revokeExplicitMemory,
} from "@/ui/memory-ui-adapter";

const threadId = "0198b9f0-6631-7000-8000-000000000302";
const uploadId = "0198b9f0-6631-7000-8000-000000000511";
const operationId = "0198b9f0-6631-7000-8000-000000000615";
const turnId = "0198b9f0-6631-7000-8000-000000000612";

const documentResponse = {
  document: {
    schemaVersion: 1,
    uploadId,
    threadId,
    fileName: "notes.md",
    relativePath: "opaque/server/path",
    kind: "text",
    mediaType: "text/markdown",
    size: 17,
    sha256: "a".repeat(64),
    status: "staged",
    createdAt: "2026-08-27T10:00:00.000Z",
  },
  preview: {
    schemaVersion: 2,
    uploadId,
    threadId,
    sourceSha256: "a".repeat(64),
    status: "ready",
    kind: "text",
    files: [{
      name: "preview.txt",
      url: `/api/threads/${threadId}/documents/${uploadId}/preview/preview.txt`,
    }],
    artifacts: [{ fileName: "preview.txt", size: 17, sha256: "a".repeat(64) }],
    pages: null,
    createdAt: "2026-08-27T10:00:01.000Z",
  },
};

describe("passive XLS UI metadata", () => {
  const provenance = {
    policy: "values-only-v1", originalFileName: "fixture.xls", originalSha256: "a".repeat(64), originalSize: 9728,
    sheetCount: 1, cellCount: 9, formulaCount: 3, missingFormulaCaches: 3, undecodedFormulas: 0, omittedSheets: 0, omittedStreams: 1,
  };
  const response = () => ({
    document: { ...documentResponse.document, kind: "xlsx", fileName: "fixture.passive.xlsx", legacyExcel: { ...provenance } },
    preview: { ...documentResponse.preview, kind: "xlsx" },
  });
  it("retains validated provenance so the composer can show the passive warning", () => {
    expect(parseDocumentUploadResponse(response())?.document.legacyExcel).toEqual(provenance);
  });
  it("rejects forged policy, paths, counts and a mismatched derivative type", () => {
    for (const mutation of [
      { policy: "verified" }, { originalFileName: "../original.xls" }, { originalSha256: "invalid" },
      { missingFormulaCaches: 4 }, { originalSize: -1 }, { originalPath: "/private/original.xls" },
    ]) {
      const value = response(); Object.assign(value.document.legacyExcel, mutation);
      expect(parseDocumentUploadResponse(value)).toBeNull();
    }
    const value = response(); value.document.fileName = "ordinary.xlsx";
    expect(parseDocumentUploadResponse(value)).toBeNull();
  });
});

const publicationOperation = {
  schemaVersion: 1,
  operationId,
  installationId: "example-lab-playwright",
  userId: "0198b9f0-6631-7000-8000-000000000600",
  threadId,
  turnId,
  targetRelativePath: "knowledge/notes.md",
  status: "awaiting_confirmation",
  candidate: { fileName: "notes.md", size: 17, sha256: "a".repeat(64) },
  preview: {
    schemaVersion: 1,
    previewId: uploadId,
    threadId,
    turnId,
    candidateSha256: "a".repeat(64),
    status: "ready",
    artifacts: ["preview.txt"],
    createdAt: "2026-08-27T10:00:00.000Z",
  },
  original: { exists: false, size: null, sha256: null, mtimeMs: null },
  confirmationExpiresAt: "2026-08-27T10:10:00.000Z",
  version: null,
  result: null,
  createdAt: "2026-08-27T10:00:00.000Z",
  updatedAt: "2026-08-27T10:00:00.000Z",
};

const memory = {
  schemaVersion: 1,
  memoryId: "0198b9f0-6631-7000-8000-000000000724",
  installationId: "example-lab-playwright",
  subjectUserId: "0198b9f0-6631-7000-8000-000000000600",
  kind: "decision",
  content: "Use the approved handoff.",
  provenance: {
    sourceType: "manual",
    sourceId: "0198b9f0-6631-7000-8000-000000000725",
    sourceExcerpt: "Use the approved handoff.",
    capturedAt: "2026-08-27T10:00:00.000Z",
  },
  explicit: true,
  createdBy: "0198b9f0-6631-7000-8000-000000000600",
  createdAt: "2026-08-27T10:00:00.000Z",
  status: "active",
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  idempotencyKey: "manual:0198b9f0-6631-7000-8000-000000000725",
};

afterEach(() => vi.unstubAllGlobals());

describe("document UI adapter", () => {
  it("accepts only authoritative preview URLs and never returns server paths", () => {
    const parsed = parseDocumentUploadResponse(documentResponse);
    expect(parsed?.document).not.toHaveProperty("relativePath");
    expect(parsed?.preview.files[0]?.url).toBe(`/api/threads/${threadId}/documents/${uploadId}/preview/preview.txt`);
    expect(parseDocumentUploadResponse({
      ...documentResponse,
      preview: { ...documentResponse.preview, files: [{ name: "preview.txt", url: "https://attacker.test/file" }] },
    })).toBeNull();
  });

  it("stages multipart with the client UUID and honors typed retry errors", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get("uploadId")).toBe(uploadId);
      return Response.json(documentResponse, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(stageDocument(threadId, new File(["Private document\n"], "notes.md", { type: "text/markdown" }), uploadId))
      .resolves.toMatchObject({ document: { uploadId, threadId } });
  });
});

describe("publication UI adapter", () => {
  it("recovers a G03 uncertain operation and rechecks the same id after refresh", async () => {
    const operation = { ...publicationOperation, installationId: "g03-qa", status: "publishing",
      targetRelativePath: "server-g03/M/G03/PRODUCCIO/notes.md" };
    assertUiContract("PublicationRecoveryResponse", { publications: [{ operation, confirmationToken: "c".repeat(64) }] });
    expect(uiContractErrors("PublicationRecoveryResponse", { publications: [{ operation, confirmationToken: "invalid" }] })).not.toBeNull();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ operation, permissionFingerprint: "b".repeat(64) })
      : Response.json({ publications: [{ operation, confirmationToken: "c".repeat(64) }] }));
    vi.stubGlobal("fetch", fetchMock);
    const [draft] = await recoverDocumentPublications(threadId);
    expect(draft.phase).toBe("uncertain"); expect(draft.uploadId).toBe(uploadId);
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe("no-store");
    await decideDocumentPublication(draft, "confirm");
    await decideDocumentPublication(draft, "confirm");
    const bodies = fetchMock.mock.calls.slice(1).map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0].clientRequestId).toBe(`confirm:${operationId}`);
  });

  it("rejects cross-thread, duplicate and malformed recovered confirmations", async () => {
    const operation = { ...publicationOperation, installationId: "g03-qa",
      targetRelativePath: "server-g03/M/G03/PRODUCCIO/notes.md" };
    const entry = { operation, confirmationToken: "c".repeat(64) };
    for (const publications of [
      [entry, entry], [{ ...entry, confirmationToken: "not-a-token" }],
      [{ ...entry, operation: { ...operation, threadId: uploadId } }],
      [{ ...entry, operation: { ...operation, targetRelativePath: "server-g03/C/Windows/file.txt" } }],
      [{ ...entry, secret: "unexpected" }],
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ publications })));
      await expect(recoverDocumentPublications(threadId)).rejects.toThrow();
    }
  });

  it("accepts the public receipt without exposing publisher paths or token hashes", () => {
    const parsed = parsePublicationFreezeReceipt({
      operation: publicationOperation,
      confirmationToken: "v1.synthetic-confirmation-token",
      permissionFingerprint: "b".repeat(64),
    });
    expect(parsed?.operation).toMatchObject({ operationId, targetRelativePath: "knowledge/notes.md" });
    expect(JSON.stringify(parsed)).not.toContain("snapshotRelativePath");
    expect(parsePublicationFreezeReceipt({
      operation: { ...publicationOperation, candidate: { ...publicationOperation.candidate, snapshotRelativePath: "private/candidate" } },
      confirmationToken: "v1.synthetic-confirmation-token",
      permissionFingerprint: "b".repeat(64),
    })).toBeNull();
  });

  it("fails closed on unsafe destinations and malformed terminal receipts", () => {
    expect(isSafePublicationTarget("knowledge/notes.md")).toBe(true);
    expect(isSafePublicationTarget("../notes.md")).toBe(false);
    expect(parsePublicationDecisionReceipt({
      operation: { ...publicationOperation, status: "published", result: { size: 17, sha256: "a".repeat(64), publishedAt: "invalid", recoveredAfterInterruption: false } },
      permissionFingerprint: "b".repeat(64),
    })).toBeNull();
  });

  it("rejects preview metadata that drifts from the frozen candidate", () => {
    expect(parsePublicationFreezeReceipt({
      operation: {
        ...publicationOperation,
        preview: { ...publicationOperation.preview, candidateSha256: "c".repeat(64) },
      },
      confirmationToken: "v1.synthetic-confirmation-token",
      permissionFingerprint: "b".repeat(64),
    })).toBeNull();
    expect(parsePublicationFreezeReceipt({
      operation: {
        ...publicationOperation,
        preview: { ...publicationOperation.preview, artifacts: ["preview.txt", "../private"] },
      },
      confirmationToken: "v1.synthetic-confirmation-token",
      permissionFingerprint: "b".repeat(64),
    })).toBeNull();
  });
});

describe("memory UI adapter", () => {
  it("uses only the explicit-memory routes and client generated request ids", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/revoke")) return Response.json({ memory: { ...memory, status: "revoked" } });
      if (init?.method === "POST") return Response.json({ memory }, { status: 201 });
      return Response.json({ memories: [memory] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listExplicitMemories()).resolves.toEqual([memory]);
    await expect(createExplicitMemory({ kind: "decision", content: memory.content })).resolves.toEqual(memory);
    await expect(revokeExplicitMemory(memory.memoryId, "Replaced by a newer decision.")).resolves.toMatchObject({ status: "revoked" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/memory?status=all&limit=100");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/memory");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/memory/${memory.memoryId}/revoke`);
    const createBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(createBody).toMatchObject({ explicit: true, kind: "decision", content: memory.content });
    expect(createBody.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("fails closed when a memory response is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ memories: [{ memoryId: memory.memoryId }] })));
    await expect(listExplicitMemories()).rejects.toThrow("respuesta de memoria no es válida");
  });
});
