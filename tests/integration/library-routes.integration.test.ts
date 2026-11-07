import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { WorkbenchThread } from "@/workbench/types";

const userA = "0198b9f0-6631-7000-8000-000000000201";
const userB = "0198b9f0-6631-7000-8000-000000000202";
const projectId = "0198b9f0-6631-7000-8000-000000000203";
const threadId = "0198b9f0-6631-7000-8000-000000000204";
const uploadId = "0198b9f0-6631-7000-8000-000000000205";
const messageId = "0198b9f0-6631-7000-8000-000000000206";
const auth = vi.hoisted(() => ({ session: null as AuthSession | null }));
const privateBytes = Buffer.from("contenido privado");
const privateSha256 = createHash("sha256").update(privateBytes).digest("hex");

function session(userId: string): AuthSession {
  return {
    provider: "local",
    user: { id: userId, name: "Library user", email: `${userId}@example.test` },
    tenant: { id: "library-routes", name: "Library Routes" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

const thread: WorkbenchThread = {
  id: threadId,
  projectId,
  title: "Informe de dirección",
  status: "active",
  pinned: false,
  createdAt: "2026-08-28T08:00:00.000Z",
  updatedAt: "2026-08-28T08:01:00.000Z",
  messages: [
    {
      id: "0198b9f0-6631-7000-8000-000000000207",
      role: "user",
      content: "Revisa el archivo.",
      createdAt: "2026-08-28T08:00:00.000Z",
      status: "complete",
      activity: [], plan: [], approvals: [], diff: "", artifacts: [],
      attachments: [{ id: uploadId, name: "dirección.txt", mimeType: "text/plain", size: privateBytes.length }],
    },
    {
      id: messageId,
      role: "assistant",
      content: "La recomendación es revisar el margen antes del viernes.",
      createdAt: "2026-08-28T08:01:00.000Z",
      status: "complete",
      activity: [], plan: [], approvals: [], diff: "", artifacts: [], attachments: [],
    },
  ],
};

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: vi.fn(async () => auth.session) }));
vi.mock("@/config/installation", () => ({
  loadInstallationConfig: vi.fn(async () => ({ installationId: "library-routes" })),
}));
vi.mock("@/workbench/store", () => ({
  getThread: vi.fn(async (active: AuthSession, requested: string) => {
    if (active.user.id !== userA || requested !== threadId) throw new Error("Not found");
    return thread;
  }),
}));
vi.mock("@/library/server-resource-access", () => ({
  LibraryResourceForbiddenError: class LibraryResourceForbiddenError extends Error {},
  resolveThreadLibraryResource: vi.fn(async (active: AuthSession, input: { threadId: string; resourceId: string }) => {
    if (active.user.id !== userA || input.threadId !== threadId || input.resourceId !== uploadId) throw new Error("Not found");
    return {
      installation: { installationId: "library-routes" },
      access: { thread },
      location: {
        storageOwnerId: userA,
        fileName: "dirección.txt",
        mediaType: "text/plain",
        size: privateBytes.length,
        sha256: privateSha256,
        relativePath: `threads/${threadId}/uploads/${uploadId}/dirección.txt`,
      },
    };
  }),
}));
vi.mock("@/documents/server-service", () => ({
  documentServicesForUser: vi.fn(async () => ({
    staging: {
      rootDirectory: "/private/staging",
      resolveContentById: vi.fn(async () => ({
        document: {
          fileName: "dirección.txt",
          mediaType: "text/plain",
          size: privateBytes.length,
          sha256: privateSha256,
          relativePath: `threads/${threadId}/uploads/${uploadId}/dirección.txt`,
        },
      })),
    },
  })),
}));
vi.mock("@/security/safe-file", () => ({
  readRegularFileWithin: vi.fn(async () => privateBytes),
}));

describe("private library downloads", () => {
  it("reauthorizes uploaded files and forces safe download headers", async () => {
    const route = await import("@/app/api/library/uploads/[threadId]/[uploadId]/route");
    const context = { params: Promise.resolve({ threadId, uploadId }) };
    auth.session = session(userA);
    const response = await route.GET(new Request("http://localhost/api/library/upload"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Disposition")).toContain("filename*=UTF-8''direcci%C3%B3n.txt");
    expect(await response.text()).toBe("contenido privado");

    const inline = await route.GET(new Request("http://localhost/api/library/upload?inline=1"), context);
    expect(inline.headers.get("Content-Disposition")).toContain("inline");
    expect(inline.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(inline.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(inline.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(inline.headers.get("Referrer-Policy")).toBe("no-referrer");

    auth.session = session(userB);
    expect((await route.GET(new Request("http://localhost/api/library/upload"), context)).status).toBe(404);
  });

  it("exports only an owned completed assistant result", async () => {
    const route = await import("@/app/api/library/results/[threadId]/[messageId]/route");
    const context = { params: Promise.resolve({ threadId, messageId }) };
    auth.session = session(userA);
    const response = await route.GET(new Request("http://localhost/api/library/result"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(await response.text()).toContain("La recomendación es revisar el margen");

    auth.session = session(userB);
    expect((await route.GET(new Request("http://localhost/api/library/result"), context)).status).toBe(404);
  });
});
