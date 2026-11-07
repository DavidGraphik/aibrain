import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { generatedPngFixture } from "../helpers/png-fixture";

const USER_A = "0198b9f0-6631-7000-8000-000000000401";
const USER_B = "0198b9f0-6631-7000-8000-000000000402";
const PROJECT_ID = "0198b9f0-6631-7000-8000-000000000411";
const ARTIFACT_ID = "0198b9f0-6631-7000-8000-000000000421";
const state = vi.hoisted(() => ({ session: null as AuthSession | null, root: "" }));
const artifactBytes = generatedPngFixture();
const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: vi.fn(async () => state.session) }));
vi.mock("@/config/installation", () => ({
  loadInstallationConfig: vi.fn(async () => ({
    installationId: "artifact-route-qa",
    paths: { dataRoot: path.join(state.root, "data") },
  })),
}));
vi.mock("@/workbench/store", () => ({
  getProjectRuntimeContext: vi.fn(async (session: AuthSession, projectId: string) => {
    if (session.user.id !== USER_A || projectId !== PROJECT_ID) throw new Error("Not found.");
    return { projectId };
  }),
}));
vi.mock("@/library/server-resource-access", () => ({
  LibraryResourceForbiddenError: class LibraryResourceForbiddenError extends Error {},
  resolveProjectLibraryResource: vi.fn(async (active: AuthSession, input: { projectId: string; resourceId: string }) => {
    if (active.user.id !== USER_A || input.projectId !== PROJECT_ID || input.resourceId !== ARTIFACT_ID) throw new Error("Not found.");
    return {
      installation: {
        installationId: "artifact-route-qa",
        paths: { dataRoot: path.join(state.root, "data") },
      },
      access: { project: { id: PROJECT_ID } },
      location: {
        storageOwnerId: USER_A,
        relativePath: `generated-image-artifacts/${ARTIFACT_ID}.png`,
        mediaType: "image/png",
        fileName: `imagen-${ARTIFACT_ID.slice(0, 8)}.png`,
        size: artifactBytes.length,
        sha256: artifactSha256,
      },
    };
  }),
}));
vi.mock("@/runtime/workers/provisioner", () => ({
  deriveWorkerRoots: vi.fn((_installation: unknown, userId: string) => ({
    workspace: path.join(state.root, "users", userId, "workspace"),
  })),
  resolveWorkerOwnedPath: vi.fn(async (root: string, relativePath: string) =>
    path.join(root, relativePath)),
}));

function session(userId: string): AuthSession {
  return {
    provider: "local",
    user: { id: userId, name: "Artifact user", email: `${userId}@example.test` },
    tenant: { id: "artifact-route-qa", name: "Artifact Route QA" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("private generated artifact route", () => {
  beforeAll(async () => {
    state.root = await mkdtemp(path.join(tmpdir(), "aibrain-artifact-route-"));
    const artifactRoot = path.join(state.root, "data", "generated-image-artifacts");
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(artifactRoot, `${ARTIFACT_ID}.png`), artifactBytes, { mode: 0o600 });
  });

  afterAll(async () => {
    state.session = null;
    await rm(state.root, { recursive: true, force: true });
  });

  it("never permits browser caching and reauthorizes the exact URL for every session", async () => {
    const route = await import("@/app/api/projects/[projectId]/artifacts/[artifactId]/route");
    const context = { params: Promise.resolve({ projectId: PROJECT_ID, artifactId: ARTIFACT_ID }) };

    state.session = session(USER_A);
    const first = await route.GET(new Request("http://localhost/artifact"), context);
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toBe("image/png");
    expect(first.headers.get("Content-Length")).toBe(String(artifactBytes.byteLength));
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    expect(first.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(first.headers.get("Content-Disposition")).toContain("inline");
    const firstBytes = Buffer.from(await first.arrayBuffer());
    expect(firstBytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(firstBytes.byteLength).toBeGreaterThan(1_000);
    expect(firstBytes).toEqual(artifactBytes);

    const download = await route.GET(new Request("http://localhost/artifact?download=1"), context);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("image/png");
    expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;.*filename="imagen-[0-9a-f]{8}\.png"/u);
    expect(download.headers.get("Content-Disposition")).not.toContain(".png.json");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(artifactBytes);
    expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");

    expect((await route.GET(new Request("http://localhost/artifact?path=/private/workspace/image.png"), context)).status).toBe(400);

    const workspaceFiles = await import("@/app/api/projects/[projectId]/files/route");
    const internalPath = encodeURIComponent(`.aibrain/artifacts/${ARTIFACT_ID}.png`);
    const internal = await workspaceFiles.GET(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/files?path=${internalPath}&raw=1`),
      { params: Promise.resolve({ projectId: PROJECT_ID }) },
    );
    expect(internal.status).toBe(404);

    state.session = null;
    expect((await route.GET(new Request("http://localhost/artifact"), context)).status).toBe(401);
    state.session = session(USER_B);
    const denied = await route.GET(new Request("http://localhost/artifact"), context);
    expect(denied.status).toBe(404);
    expect(denied.headers.get("Content-Type")).toContain("application/json");
    const deniedBody = Buffer.from(await denied.arrayBuffer());
    expect(deniedBody.byteLength).toBe(32);
    expect(deniedBody.toString("utf8")).toBe('{"error":"Artefacte no trobat."}');
  });
});
