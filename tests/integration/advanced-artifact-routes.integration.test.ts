import { describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { AdvancedArtifactSnapshot, AdvancedArtifactSummary } from "@/artifacts/contracts";

const userA = "0198b9f0-6631-7000-8000-000000000601";
const userB = "0198b9f0-6631-7000-8000-000000000602";
const artifactId = "0198b9f0-6631-7000-8000-000000000603";
const state = vi.hoisted(() => ({ session: null as AuthSession | null }));

function session(userId: string): AuthSession {
  return {
    provider: "local",
    user: { id: userId, name: "Artifact route user", email: `${userId}@example.test` },
    tenant: { id: "advanced-artifact-routes", name: "Advanced Artifact Routes" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

const snapshot: AdvancedArtifactSnapshot = {
  schemaVersion: 1,
  artifactId,
  version: 1,
  title: "Margen regional",
  source: {
    projectId: "0198b9f0-6631-7000-8000-000000000604",
    threadId: "0198b9f0-6631-7000-8000-000000000605",
    messageId: "0198b9f0-6631-7000-8000-000000000606",
    messageSha256: "e".repeat(64),
  },
  createdAt: "2026-08-28T08:00:00.000Z",
  content: {
    kind: "visualization",
    spec: {
      chartType: "bar", title: "Margen regional", xLabel: "Región", yLabel: "%",
      series: [{ name: "Margen", color: null }], rows: [{ label: "Norte", values: [24.5] }],
    },
  },
  contentSha256: "f".repeat(64),
};

const summary: AdvancedArtifactSummary = {
  id: artifactId,
  kind: "visualization",
  title: snapshot.title,
  projectId: snapshot.source.projectId,
  threadId: snapshot.source.threadId,
  messageId: snapshot.source.messageId,
  createdAt: snapshot.createdAt,
  updatedAt: snapshot.createdAt,
  latestVersion: 1,
  publishedVersions: [],
  previewUrl: `/api/artifacts/${artifactId}/preview`,
  downloadHtmlUrl: `/api/artifacts/${artifactId}/download?format=html`,
  downloadZipUrl: `/api/artifacts/${artifactId}/download?format=zip`,
  internalSiteUrl: null,
};

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: vi.fn(async () => state.session) }));
vi.mock("@/artifacts/server-service", () => ({
  getAdvancedArtifactForSession: vi.fn(async (active: AuthSession, requestedId: string) => {
    if (active.user.id !== userA || requestedId !== artifactId) {
      const { AdvancedArtifactNotFoundError } = await import("@/artifacts/store");
      throw new AdvancedArtifactNotFoundError("Artefacto no encontrado.");
    }
    return { summary, snapshot };
  }),
}));

describe("advanced artifact preview route", () => {
  it("requires a session, reauthorizes ownership and emits a script-free CSP", async () => {
    const route = await import("@/app/api/artifacts/[artifactId]/preview/route");
    const context = { params: Promise.resolve({ artifactId }) };
    state.session = null;
    expect((await route.GET(new Request(`http://localhost/api/artifacts/${artifactId}/preview`), context)).status).toBe(401);

    state.session = session(userA);
    const response = await route.GET(new Request(`http://localhost/api/artifacts/${artifactId}/preview`), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toContain("<svg");

    state.session = session(userB);
    expect((await route.GET(new Request(`http://localhost/api/artifacts/${artifactId}/preview`), context)).status).toBe(404);
  });
});
