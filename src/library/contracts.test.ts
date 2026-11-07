import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@/memory/types";
import type { WorkbenchSnapshot } from "@/workbench/types";
import { buildGlobalSearchResults, buildLibraryItems } from "@/library/contracts";

const projectId = "0198b9f0-6631-7000-8000-000000000101";
const workspaceId = "0198b9f0-6631-7000-8000-000000000102";
const threadId = "0198b9f0-6631-7000-8000-000000000103";
const userMessageId = "0198b9f0-6631-7000-8000-000000000104";
const assistantMessageId = "0198b9f0-6631-7000-8000-000000000105";
const uploadId = "0198b9f0-6631-7000-8000-000000000106";
const artifactId = "0198b9f0-6631-7000-8000-000000000107";
const createdAt = "2026-08-28T08:00:00.000Z";

const snapshot: WorkbenchSnapshot = {
  persistence: "filesystem",
  projects: [{
    id: projectId,
    name: "Operaciones comerciales",
    slug: "operaciones-comerciales",
    status: "active",
    pinned: false,
    instructions: "",
    sources: [],
    memory: { enabled: true, notes: "", updatedAt: null },
    sharing: { visibility: "private", members: [] },
    workspace: { id: workspaceId, label: "Operaciones", hostType: "managed", status: "ready", isPrimary: true },
    createdAt,
    updatedAt: createdAt,
  }],
  threads: [{
    id: threadId,
    projectId,
    title: "Informe trimestral",
    status: "active",
    pinned: false,
    createdAt,
    updatedAt: createdAt,
    messages: [
      {
        id: userMessageId,
        role: "user",
        content: "Analiza el margen por región del contrato.",
        createdAt,
        status: "complete",
        activity: [], plan: [], approvals: [], diff: "", artifacts: [],
        attachments: [{ id: uploadId, name: "margen-regional.csv", mimeType: "text/csv", size: 48 }],
      },
      {
        id: assistantMessageId,
        role: "assistant",
        content: "El margen del norte mejora cinco puntos y requiere seguimiento.",
        createdAt: "2026-08-28T08:01:00.000Z",
        status: "complete",
        activity: [{ id: "analysis", kind: "tool", label: "Analizar margen regional", detail: "Hoja revisada", status: "complete" }],
        plan: [], approvals: [], diff: "", attachments: [],
        artifacts: [{
          id: artifactId,
          type: "image",
          name: "margen-regional.png",
          url: `/api/projects/${projectId}/artifacts/${artifactId}`,
          prompt: "Gráfico del margen regional",
        }],
      },
    ],
  }],
};

const memory: MemoryRecord = {
  schemaVersion: 1,
  memoryId: "0198b9f0-6631-7000-8000-000000000108",
  installationId: "library-test",
  subjectUserId: "0198b9f0-6631-7000-8000-000000000109",
  kind: "decision",
  content: "Revisar el margen regional cada viernes.",
  provenance: { sourceType: "thread", sourceId: threadId, sourceExcerpt: "margen regional", capturedAt: createdAt },
  explicit: true,
  createdBy: "0198b9f0-6631-7000-8000-000000000109",
  createdAt,
  status: "active",
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  idempotencyKey: "manual:test",
};

describe("library and global search indexes", () => {
  it("builds real downloadable entries for uploads, generated files and completed results", () => {
    const items = buildLibraryItems(snapshot);
    expect(items.map((item) => item.type)).toEqual(["image", "result", "upload"]);
    expect(items.find((item) => item.type === "upload")).toMatchObject({
      name: "margen-regional.csv",
      downloadUrl: `/api/library/uploads/${threadId}/${uploadId}`,
      previewUrl: `/api/threads/${threadId}/documents/${uploadId}/preview/preview.txt`,
    });
    expect(items.find((item) => item.type === "result")?.downloadUrl)
      .toBe(`/api/library/results/${threadId}/${assistantMessageId}`);
    expect(items.find((item) => item.type === "image")?.downloadUrl)
      .toBe(`/api/projects/${projectId}/artifacts/${artifactId}?download=1`);
  });

  it("routes Office uploads to their converted PDF representation", () => {
    const officeSnapshot: WorkbenchSnapshot = {
      ...snapshot,
      threads: snapshot.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) => message.id === userMessageId ? {
          ...message,
          attachments: [{
            id: uploadId,
            name: "margen-regional.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 4_096,
          }],
        } : message),
      })),
    };
    expect(buildLibraryItems(officeSnapshot).find((item) => item.type === "upload")?.previewUrl)
      .toBe(`/api/threads/${threadId}/documents/${uploadId}/preview/document.pdf`);
  });

  it("finds typed, navigable results across messages, files, artifacts, activity and memory", () => {
    const results = buildGlobalSearchResults(snapshot, "margen region", [memory]);
    expect(new Set(results.map((result) => result.type)))
      .toEqual(new Set(["message", "file", "artifact", "memory", "activity"]));
    expect(results.find((result) => result.type === "file")).toMatchObject({
      threadId,
      messageId: userMessageId,
      libraryItemId: `upload:${threadId}:${uploadId}`,
    });
    expect(results.find((result) => result.type === "memory")?.threadId).toBe(threadId);
  });

  it("normalizes accents and never returns unrelated content", () => {
    expect(buildGlobalSearchResults(snapshot, "region", []).some((result) => result.type === "message")).toBe(true);
    expect(buildGlobalSearchResults(snapshot, "presupuesto", [])).toEqual([]);
  });
});
