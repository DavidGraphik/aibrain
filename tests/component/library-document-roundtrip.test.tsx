// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryPanel } from "@/components/library-panel";
import type { WorkbenchProject, WorkbenchThread } from "@/workbench/types";

const PROJECT_ID = "0198b9f0-6631-7000-8000-000000000701";
const WORKSPACE_ID = "0198b9f0-6631-7000-8000-000000000702";
const THREAD_ID = "0198b9f0-6631-7000-8000-000000000703";
const MESSAGE_ID = "0198b9f0-6631-7000-8000-000000000704";
const DOCUMENT_ID = "0198b9f0-6631-7000-8000-000000000705";
const USER_ID = "0198b9f0-6631-7000-8000-000000000706";
const createdAt = "2026-08-30T08:00:00.000Z";

const project: WorkbenchProject = {
  id: PROJECT_ID,
  name: "Operaciones",
  slug: "operaciones",
  status: "active",
  pinned: false,
  instructions: "",
  sources: [],
  memory: { enabled: true, notes: "", updatedAt: null },
  sharing: { visibility: "private", members: [] },
  workspace: { id: WORKSPACE_ID, label: "Operaciones", hostType: "managed", status: "ready", isPrimary: true },
  createdAt,
  updatedAt: createdAt,
};

const thread: WorkbenchThread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Brief",
  status: "active",
  pinned: false,
  createdAt,
  updatedAt: createdAt,
  messages: [{
    id: MESSAGE_ID,
    role: "user",
    content: "Revisa el brief",
    createdAt,
    status: "complete",
    activity: [],
    plan: [],
    approvals: [],
    diff: "",
    artifacts: [],
    attachments: [{
      id: DOCUMENT_ID,
      name: "brief.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 4_096,
    }],
  }],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Library document roundtrip", () => {
  it("uses the Office PDF representation and exposes immutable history and re-upload", async () => {
    const previewUrl = `/api/threads/${THREAD_ID}/documents/${DOCUMENT_ID}/versions/${DOCUMENT_ID}/preview/document.pdf`;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/library") return Response.json({ items: [] }, { status: 503 });
      if (url === `/api/threads/${THREAD_ID}/documents/${DOCUMENT_ID}`) {
        return Response.json({ document: {
          documentId: DOCUMENT_ID,
          threadId: THREAD_ID,
          title: "brief.docx",
          scope: { kind: "project", id: PROJECT_ID },
          originalVersionId: DOCUMENT_ID,
          latestVersionId: DOCUMENT_ID,
          versions: [{
            versionId: DOCUMENT_ID,
            number: 1,
            etag: "a".repeat(64),
            fileName: "brief.docx",
            kind: "docx",
            mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: 4_096,
            author: { userId: USER_ID, name: "David" },
            createdAt,
            provenance: { type: "original_upload", sourceVersionId: null },
            downloadUrl: `/api/threads/${THREAD_ID}/documents/${DOCUMENT_ID}/versions/${DOCUMENT_ID}`,
            previewUrl,
          }],
        } });
      }
      if (url === previewUrl) {
        return new Response("%PDF-1.7\nfixture", { headers: { "Content-Type": "application/pdf", "Content-Length": "16" } });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    }));
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:https://brain.example/office"), revokeObjectURL: vi.fn() });

    render(<LibraryPanel
      open
      projects={[project]}
      threads={[thread]}
      onClose={vi.fn()}
      onOpenConversation={vi.fn()}
    />);

    expect(await screen.findByTitle("Vista previa de brief.docx")).toHaveAttribute("src", "blob:https://brain.example/office");
    expect(screen.getByLabelText("Historial de versiones del documento")).toHaveTextContent("v1 · brief.docx · actual");
    expect(screen.getByRole("button", { name: "Subir versión editada" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Descargar versión actual" })).toHaveAttribute(
      "href",
      `/api/threads/${THREAD_ID}/documents/${DOCUMENT_ID}/versions/${DOCUMENT_ID}`,
    );
  });

  it("keeps shared viewer resources readable without exposing any Library mutation", async () => {
    const viewerProject: WorkbenchProject = {
      ...project,
      access: { role: "viewer", canEdit: false, canManage: false },
    };
    const versionTwoId = "0198b9f0-6631-7000-8000-000000000707";
    const advancedId = "0198b9f0-6631-7000-8000-000000000708";
    const previewUrl = `/api/threads/${THREAD_ID}/documents/${DOCUMENT_ID}/versions/${versionTwoId}/preview/preview.txt`;
    const mutatingRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method !== "GET") mutatingRequests.push(`${method} ${url}`);
      if (url === "/api/library") return Response.json({ items: [{
        id: `upload:${THREAD_ID}:${DOCUMENT_ID}`,
        type: "upload",
        name: "brief.txt",
        mimeType: "text/plain",
        size: 4_096,
        createdAt,
        projectId: PROJECT_ID,
        projectName: project.name,
        threadId: THREAD_ID,
        threadTitle: thread.title,
        messageId: MESSAGE_ID,
        previewUrl,
        downloadUrl: `/api/library/uploads/${THREAD_ID}/${DOCUMENT_ID}`,
        status: "ready",
        capabilities: { preview: true, download: true, history: true, mutate: false },
      }, {
        id: `result:${THREAD_ID}:${MESSAGE_ID}`,
        type: "result",
        name: "Respuesta compartida.md",
        mimeType: "text/markdown",
        size: 128,
        createdAt,
        projectId: PROJECT_ID,
        projectName: project.name,
        threadId: THREAD_ID,
        threadTitle: thread.title,
        messageId: MESSAGE_ID,
        previewUrl: null,
        downloadUrl: `/api/library/results/${THREAD_ID}/${MESSAGE_ID}`,
        status: "ready",
        capabilities: { preview: false, download: true, history: false, mutate: false },
      }, {
        id: `advanced:${advancedId}`,
        type: "internal-site",
        name: "Panel compartido",
        mimeType: "text/html",
        size: null,
        createdAt,
        projectId: PROJECT_ID,
        projectName: project.name,
        threadId: THREAD_ID,
        threadTitle: thread.title,
        messageId: MESSAGE_ID,
        previewUrl: `/api/artifacts/${advancedId}/preview`,
        downloadUrl: `/api/artifacts/${advancedId}/download?format=html`,
        status: "ready",
        artifactId: advancedId,
        downloadZipUrl: `/api/artifacts/${advancedId}/download?format=zip`,
        internalSiteUrl: `/api/artifacts/${advancedId}/published/1`,
        latestVersion: 1,
        capabilities: { preview: true, download: true, history: false, mutate: false },
      }] });
      if (url === `/api/threads/${THREAD_ID}/documents/${DOCUMENT_ID}`) {
        return Response.json({ document: {
          documentId: DOCUMENT_ID,
          threadId: THREAD_ID,
          title: "brief.txt",
          scope: { kind: "project", id: PROJECT_ID },
          originalVersionId: DOCUMENT_ID,
          latestVersionId: versionTwoId,
          versions: [{
            versionId: DOCUMENT_ID,
            number: 1,
            etag: "a".repeat(64),
            fileName: "brief.txt",
            kind: "text",
            mediaType: "text/plain",
            size: 4_096,
            author: { userId: USER_ID, name: "David" },
            createdAt,
            provenance: { type: "original_upload", sourceVersionId: null },
            downloadUrl: `/api/threads/${THREAD_ID}/documents/${DOCUMENT_ID}/versions/${DOCUMENT_ID}`,
            previewUrl: `/api/threads/${THREAD_ID}/documents/${DOCUMENT_ID}/versions/${DOCUMENT_ID}/preview/preview.txt`,
          }, {
            versionId: versionTwoId,
            number: 2,
            etag: "b".repeat(64),
            fileName: "brief.txt",
            kind: "text",
            mediaType: "text/plain",
            size: 4_120,
            author: { userId: USER_ID, name: "David" },
            createdAt: "2026-08-30T08:01:00.000Z",
            provenance: { type: "roundtrip_upload", sourceVersionId: DOCUMENT_ID },
            downloadUrl: `/api/threads/${THREAD_ID}/documents/${DOCUMENT_ID}/versions/${versionTwoId}`,
            previewUrl,
          }],
        } });
      }
      if (url === previewUrl) return new Response("contenido compartido", { headers: { "Content-Type": "text/plain" } });
      if (url === `/api/artifacts/${advancedId}/preview`) {
        return new Response("<p>panel</p>", { headers: { "Content-Type": "text/html" } });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    }));

    render(<LibraryPanel
      open
      projects={[viewerProject]}
      threads={[thread]}
      onClose={vi.fn()}
      onOpenConversation={vi.fn()}
    />);

    expect(await screen.findByLabelText("Historial de versiones del documento")).toHaveTextContent("v2 · brief.txt · actual");
    expect(screen.getByText(/Solo lectura/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Descargar versión actual" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subir versión editada" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restaurar" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Respuesta compartida\.md/ }));
    expect(screen.queryByRole("button", { name: "Crear visualización" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crear sitio interno" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Panel compartido/ }));
    expect(screen.getByRole("link", { name: "Ver sitio interno" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Actualizar sitio interno|Publicar sitio interno/ })).not.toBeInTheDocument();
    expect(mutatingRequests).toEqual([]);
  });
});
