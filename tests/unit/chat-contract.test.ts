import { describe, expect, it } from "vitest";
import {
  applyChatStreamEvent,
  isChatAttachment,
  isChatInputAttachment,
  isGeneratedArtifact,
  projectChatStreamEvent,
  isTurnOptions,
  type ChatMessage,
} from "@/lib/chat-contract";

const attachment = {
  id: "018f5f68-4a6e-7abc-8def-0123456789ab",
  name: "synthetic.png",
  mimeType: "image/png",
  size: 8,
};

const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDataUrl(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set(pngSignature);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

describe("chat contract", () => {
  it("accepts the bounded synthetic image attachment", () => {
    expect(isChatAttachment(attachment)).toBe(true);
    expect(isChatInputAttachment({
      ...attachment,
      dataUrl: pngDataUrl(attachment.size),
    })).toBe(true);
  });

  it("keeps persisted document metadata outside the inline image-input boundary", () => {
    const document = { ...attachment, mimeType: "application/pdf" };
    expect(isChatAttachment(document)).toBe(true);
    expect(isChatInputAttachment({
      ...document,
      dataUrl: "data:application/pdf;base64,JVBERg==",
    })).toBe(false);
    expect(isChatAttachment({ ...attachment, size: (50 * 1024 * 1024) + 1 })).toBe(false);
  });

  it("rejects aggregate attachment payloads above the server limit", () => {
    const size = 1_700_000;
    const large = {
      ...attachment,
      size,
      dataUrl: pngDataUrl(size),
    };
    expect(isTurnOptions({
      mode: "agent",
      model: null,
      effort: null,
      webSearch: false,
      imageGeneration: false,
      skill: null,
      attachments: [large, { ...large, id: "018f5f68-4a6e-7abc-8def-0123456789ac" }, { ...large, id: "018f5f68-4a6e-7abc-8def-0123456789ad" }],
    })).toBe(false);
  });

  it("accepts only a boolean automatic approval preference", () => {
    const options = {
      mode: "agent",
      model: null,
      effort: null,
      webSearch: false,
      imageGeneration: false,
      skill: null,
      attachments: [],
    } as const;

    expect(isTurnOptions({ ...options, autoApprove: true })).toBe(true);
    expect(isTurnOptions({ ...options, autoApprove: "true" })).toBe(false);
  });

  it("accepts bounded document and browser view models without widening upload input", () => {
    expect(isGeneratedArtifact({
      id: "018f5f68-4a6e-7abc-8def-0123456789ae",
      type: "document",
      name: "informe.pdf",
      url: "/api/projects/018f5f68-4a6e-7abc-8def-0123456789ab/artifacts/018f5f68-4a6e-7abc-8def-0123456789ae",
      kind: "pdf",
      mimeType: "application/pdf",
      size: 1024,
      status: "ready",
      pages: 3,
      previewUrl: "/api/projects/018f5f68-4a6e-7abc-8def-0123456789ab/artifacts/018f5f68-4a6e-7abc-8def-0123456789ae/preview/1",
      publicationStatus: "awaiting_confirmation",
      publicationError: null,
      targetLabel: "Informes/informe.pdf",
      error: null,
    })).toBe(true);
    expect(isGeneratedArtifact({
      id: "018f5f68-4a6e-7abc-8def-0123456789af",
      type: "browser",
      name: "Comprobación web",
      status: "active",
      control: "agent",
      viewerUrl: "/api/browser/sessions/018f5f68-4a6e-7abc-8def-0123456789af/viewer",
      captureUrl: null,
      downloadUrl: null,
      error: null,
    })).toBe(true);
    expect(isChatAttachment({ ...attachment, mimeType: "application/pdf" })).toBe(true);
    expect(isChatInputAttachment({
      ...attachment,
      mimeType: "application/pdf",
      dataUrl: "data:application/pdf;base64,JVBERg==",
    })).toBe(false);
  });

  it("updates an artifact by id instead of duplicating a status transition", () => {
    const message: ChatMessage = {
      id: "message-1",
      role: "assistant",
      content: "",
      createdAt: "2026-08-27T00:00:00.000Z",
      status: "streaming",
      activity: [],
      plan: [],
      approvals: [],
      diff: "",
      attachments: [],
      artifacts: [],
    };
    const processing = {
      id: "018f5f68-4a6e-7abc-8def-0123456789ae",
      type: "document" as const,
      name: "informe.pdf",
      url: "/api/projects/p/artifacts/a",
      kind: "pdf" as const,
      mimeType: "application/pdf",
      size: 1024,
      status: "processing" as const,
      pages: null,
      previewUrl: null,
      publicationStatus: null,
      publicationError: null,
      targetLabel: null,
      error: null,
    };
    const first = applyChatStreamEvent(message, { type: "artifact", item: processing });
    const ready = applyChatStreamEvent(first, {
      type: "artifact",
      item: { ...processing, status: "ready", pages: 2 },
    });
    expect(ready.artifacts).toHaveLength(1);
    expect(ready.artifacts[0]).toMatchObject({ status: "ready", pages: 2 });
  });

  it("projects transport order once and records a real terminal duration", () => {
    const message: ChatMessage = {
      id: "message-ordered",
      role: "assistant",
      content: "",
      createdAt: "2026-08-30T10:00:00.000Z",
      status: "streaming",
      activity: [],
      plan: [],
      approvals: [],
      diff: "",
      attachments: [],
      artifacts: [],
    };
    const started = projectChatStreamEvent({
      type: "activity",
      item: { id: "web-1", kind: "web", label: "Buscando", status: "running" },
    }, { sequence: 7 });
    const completed = projectChatStreamEvent({
      type: "activity",
      item: { id: "web-1", kind: "web", label: "Completado", status: "complete" },
    }, { sequence: 9 });
    const withStarted = applyChatStreamEvent(message, started);
    const withCompleted = applyChatStreamEvent(withStarted, completed);
    const terminal = projectChatStreamEvent({ type: "done" }, { terminalDurationMs: 12_345 });
    const done = applyChatStreamEvent(withCompleted, terminal);

    expect(done.activity).toEqual([expect.objectContaining({ id: "web-1", sequence: 7, status: "complete" })]);
    expect(done).toMatchObject({ status: "complete", durationMs: 12_345 });
  });
});
