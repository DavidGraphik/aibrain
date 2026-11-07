import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { ChatMessage } from "@/lib/chat-contract";
import { generatedPngFixture } from "../helpers/png-fixture";

const OWNER = "0198b9f0-6631-7000-8000-000000000901";
const EDITOR = "0198b9f0-6631-7000-8000-000000000902";
const VIEWER = "0198b9f0-6631-7000-8000-000000000903";
const OUTSIDER = "0198b9f0-6631-7000-8000-000000000904";
const UPLOAD = "0198b9f0-6631-7000-8000-000000000905";
const LEGACY_UPLOAD = "0198b9f0-6631-7000-8000-000000000908";
const IMAGE = "0198b9f0-6631-7000-8000-000000000911";
const PDF = "0198b9f0-6631-7000-8000-000000000912";
const auth = vi.hoisted(() => ({ session: null as AuthSession | null }));

vi.mock("server-only", () => ({}));
// This suite verifies real authorization, ownership and source binding. Native
// PDF parsing/rendering is covered by document-preview.integration.test.ts;
// its synthetic provenance bytes deliberately aren't a complete PDF document.
const previewConversion = vi.hoisted(() => vi.fn(async ({ data }: { data: Buffer }) => ({ data, pages: 1 })));
vi.mock("@/documents/workspace-preview", () => ({ prepareWorkspaceDocumentPreview: previewConversion }));
vi.mock("@/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/auth/session")>();
  return { ...original, getSession: vi.fn(async () => auth.session) };
});

function session(userId: string, email: string, name: string): AuthSession {
  return {
    provider: "local",
    user: { id: userId, email, name },
    tenant: { id: "shared-library-qa", name: "Shared Library QA" },
    expiresAt: "2026-08-31T00:00:00.000Z",
  };
}

const ownerSession = session(OWNER, "owner@example.test", "Owner");
const editorSession = session(EDITOR, "editor@example.test", "Editor");
const viewerSession = session(VIEWER, "viewer@example.test", "Viewer");
const outsiderSession = session(OUTSIDER, "outsider@example.test", "Outsider");

function message(input: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return {
    content: input.role === "user" ? "Review the indexed file." : "Done.",
    createdAt: "2026-08-30T08:00:00.000Z",
    status: input.role === "user" ? "complete" : "streaming",
    activity: [],
    plan: [],
    approvals: [],
    diff: "",
    attachments: [],
    artifacts: [],
    ...input,
  };
}

describe("shared Library resource provenance", () => {
  let root = "";
  let previousConfig: string | undefined;
  let projectId = "";
  let threadId = "";
  let advancedArtifactId = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aibrain-shared-library-"));
    const dataRoot = path.join(root, "data");
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const configPath = path.join(root, "installation.json");
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 1,
      installationId: "shared-library-qa",
      companyName: "Shared Library QA",
      companySlug: "shared-library-qa",
      publicUrl: "http://localhost:3000",
      branding: {
        productName: "AiBrain",
        logoPath: "/logo.svg",
        faviconPath: "/favicon.ico",
        accentColor: "#334455",
      },
      paths: {
        dataRoot,
        companyContextRoot: path.join(dataRoot, "company"),
        usersRoot: path.join(dataRoot, "users"),
        sourceReadRoot: path.join(root, "source"),
        publishWriteRoot: path.join(root, "publish"),
        backupsRoot: path.join(dataRoot, "backups"),
      },
    }, null, 2)}\n`);
    previousConfig = process.env.AIBRAIN_INSTALLATION_CONFIG;
    process.env.AIBRAIN_INSTALLATION_CONFIG = configPath;

    const [
      { loadInstallationConfig },
      { UserProvisioner },
      { createProject, createThread, updateProject },
      { FileWorkbenchStore },
      { documentServicesForUser },
      { validateUploadedDocument },
      { resourceLocationIndexForInstallation },
    ] = await Promise.all([
      import("@/config/installation"),
      import("@/users/provisioner"),
      import("@/workbench/store"),
      import("@/workbench/filesystem-store"),
      import("@/documents/server-service"),
      import("@/documents/upload-validation"),
      import("@/library/server-resource-access"),
    ]);
    const installation = await loadInstallationConfig();
    const provisioner = new UserProvisioner(installation);
    await Promise.all([
      provisioner.provision({ userId: OWNER, email: ownerSession.user.email, displayName: ownerSession.user.name }),
      provisioner.provision({ userId: EDITOR, email: editorSession.user.email, displayName: editorSession.user.name }),
      provisioner.provision({ userId: VIEWER, email: viewerSession.user.email, displayName: viewerSession.user.name }),
      provisioner.provision({ userId: OUTSIDER, email: outsiderSession.user.email, displayName: outsiderSession.user.name }),
    ]);
    const project = await createProject(ownerSession, "Shared evidence");
    projectId = project.id;
    await updateProject(ownerSession, project.id, {
      sharing: {
        visibility: "shared",
        members: [{
          id: EDITOR,
          email: editorSession.user.email,
          name: editorSession.user.name,
          role: "editor",
          status: "active",
          addedAt: "2026-08-30T08:00:00.000Z",
        }, {
          id: VIEWER,
          email: viewerSession.user.email,
          name: viewerSession.user.name,
          role: "viewer",
          status: "active",
          addedAt: "2026-08-30T08:00:00.000Z",
        }],
      },
    });
    const thread = await createThread(ownerSession, project.id, "Shared file");
    threadId = thread.id;

    const editorBytes = Buffer.from("editor indexed bytes");
    const viewerBytes = Buffer.from("viewer same-path substitute");
    const editorServices = await documentServicesForUser(installation, EDITOR);
    const viewerServices = await documentServicesForUser(installation, VIEWER);
    const editorDocument = await editorServices.staging.stage({
      threadId,
      uploadId: UPLOAD,
      data: editorBytes,
      validated: validateUploadedDocument({
        fileName: "evidence.txt",
        declaredMimeType: "text/plain",
        data: editorBytes,
      }),
    });
    await viewerServices.staging.stage({
      threadId,
      uploadId: UPLOAD,
      data: viewerBytes,
      validated: validateUploadedDocument({
        fileName: "evidence.txt",
        declaredMimeType: "text/plain",
        data: viewerBytes,
      }),
    });
    await resourceLocationIndexForInstallation(installation).register({
      kind: "upload",
      resourceId: UPLOAD,
      projectId,
      threadId,
      messageId: null,
      storageOwnerId: EDITOR,
      relativePath: editorDocument.relativePath,
      fileName: editorDocument.fileName,
      mediaType: editorDocument.mediaType,
      size: editorDocument.size,
      sha256: editorDocument.sha256,
    });
    const editorImage = generatedPngFixture(32, 32);
    const viewerImage = generatedPngFixture(31, 33);
    const artifactRoot = path.join(dataRoot, "generated-image-artifacts");
    await mkdir(artifactRoot, { mode: 0o700 });
    await writeFile(path.join(artifactRoot, `${IMAGE}.png`), editorImage, { mode: 0o600 });
    const viewerSpoofRoot = path.join(
      viewerServices.manifest.roots.workspace,
      "projects",
      projectId,
      ".aibrain",
      "artifacts",
    );
    await mkdir(viewerSpoofRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(viewerSpoofRoot, `${IMAGE}.png`), viewerImage, { mode: 0o600 });
    await resourceLocationIndexForInstallation(installation).register({
      kind: "generated-image",
      resourceId: IMAGE,
      projectId,
      threadId,
      messageId: "0198b9f0-6631-7000-8000-000000000907",
      storageOwnerId: EDITOR,
      relativePath: `generated-image-artifacts/${IMAGE}.png`,
      fileName: `imatge-${IMAGE.slice(0, 8)}.png`,
      mediaType: "image/png",
      size: editorImage.length,
      sha256: createHash("sha256").update(editorImage).digest("hex"),
    });
    const editorPdf = Buffer.from("%PDF-1.7\neditor generated pdf\n%%EOF");
    const viewerPdf = Buffer.from("%PDF-1.7\nviewer same-path substitute\n%%EOF");
    for (const [workspace, bytes] of [
      [editorServices.manifest.roots.workspace, editorPdf],
      [viewerServices.manifest.roots.workspace, viewerPdf],
    ] as const) {
      const reportRoot = path.join(workspace, "projects", projectId, "reports");
      await mkdir(reportRoot, { recursive: true, mode: 0o700 });
      await writeFile(path.join(reportRoot, "shared.pdf"), bytes, { mode: 0o600 });
    }
    await resourceLocationIndexForInstallation(installation).register({
      kind: "workspace-file",
      resourceId: PDF,
      projectId,
      threadId,
      messageId: "0198b9f0-6631-7000-8000-000000000907",
      storageOwnerId: EDITOR,
      relativePath: "reports/shared.pdf",
      fileName: "shared.pdf",
      mediaType: "application/pdf",
      size: editorPdf.length,
      sha256: createHash("sha256").update(editorPdf).digest("hex"),
    });
    const workbench = FileWorkbenchStore.fromInstallation(installation);
    const assistantMessageId = "0198b9f0-6631-7000-8000-000000000907";
    await workbench.beginThreadTurn(
      OWNER,
      threadId,
      message({
        id: "0198b9f0-6631-7000-8000-000000000906",
        role: "user",
        attachments: [{ id: UPLOAD, name: "evidence.txt", mimeType: "text/plain", size: editorBytes.length }],
      }),
      message({ id: assistantMessageId, role: "assistant" }),
    );
    const completedAssistant = message({
      id: assistantMessageId,
      role: "assistant",
      status: "complete",
      content: "| Region | Margin |\n| --- | ---: |\n| North | 24 |",
    });
    await workbench.finishThreadTurn(OWNER, threadId, completedAssistant, null);
    const { createAdvancedArtifact } = await import("@/artifacts/server-service");
    advancedArtifactId = (await createAdvancedArtifact(editorSession, {
      kind: "visualization",
      title: "Shared margin",
      threadId,
      messageId: assistantMessageId,
    })).summary.id;
    const legacyAssistantId = "0198b9f0-6631-7000-8000-000000000910";
    await workbench.beginThreadTurn(
      OWNER,
      threadId,
      message({
        id: "0198b9f0-6631-7000-8000-000000000909",
        role: "user",
        attachments: [{ id: LEGACY_UPLOAD, name: "legacy.txt", mimeType: "text/plain", size: 12 }],
      }),
      message({ id: legacyAssistantId, role: "assistant" }),
    );
    await workbench.finishThreadTurn(OWNER, threadId, message({
      id: legacyAssistantId,
      role: "assistant",
      status: "complete",
      content: "Legacy resource recorded without trusted blob provenance.",
    }), null);
  });

  afterAll(async () => {
    auth.session = null;
    if (previousConfig === undefined) delete process.env.AIBRAIN_INSTALLATION_CONFIG;
    else process.env.AIBRAIN_INSTALLATION_CONFIG = previousConfig;
    await rm(root, { recursive: true, force: true });
  });

  it("streams the editor-owned indexed bytes to owner, editor and viewer, but not an outsider", async () => {
    const route = await import("@/app/api/library/uploads/[threadId]/[uploadId]/route");
    const context = { params: Promise.resolve({ threadId, uploadId: UPLOAD }) };
    for (const allowed of [ownerSession, editorSession, viewerSession]) {
      auth.session = allowed;
      const response = await route.GET(new Request("http://localhost/api/library/file"), context);
      expect(response.status, allowed.user.name).toBe(200);
      expect(await response.text()).toBe("editor indexed bytes");
    }
    auth.session = outsiderSession;
    expect((await route.GET(new Request("http://localhost/api/library/file"), context)).status).toBe(404);
  });

  it("streams the exact indexed editor image instead of a same-path collaborator substitute", async () => {
    const route = await import("@/app/api/projects/[projectId]/artifacts/[artifactId]/route");
    const context = { params: Promise.resolve({ projectId, artifactId: IMAGE }) };
    for (const allowed of [ownerSession, editorSession, viewerSession]) {
      auth.session = allowed;
      const response = await route.GET(new Request("http://localhost/api/image"), context);
      expect(response.status, allowed.user.name).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(generatedPngFixture(32, 32));
    }
    auth.session = outsiderSession;
    expect((await route.GET(new Request("http://localhost/api/image"), context)).status).toBe(404);
  });

  it("streams an indexed editor PDF only for its exact resource/path binding", async () => {
    previewConversion.mockClear();
    const route = await import("@/app/api/projects/[projectId]/files/route");
    const exactUrl = `http://localhost/api/projects/${projectId}/files?path=reports%2Fshared.pdf&raw=1&resourceId=${PDF}`;
    for (const allowed of [ownerSession, editorSession, viewerSession]) {
      auth.session = allowed;
      const response = await route.GET(new Request(exactUrl), { params: Promise.resolve({ projectId }) });
      expect(response.status, allowed.user.name).toBe(200);
      const contents = await response.text();
      expect(contents).toContain("editor generated pdf");
      expect(contents).not.toContain("viewer same-path substitute");
    }
    auth.session = viewerSession;
    const substituted = await route.GET(new Request(
      `http://localhost/api/projects/${projectId}/files?path=reports%2Fother.pdf&raw=1&resourceId=${PDF}`,
    ), { params: Promise.resolve({ projectId }) });
    expect(substituted.status).toBe(404);
    expect(previewConversion).toHaveBeenCalledTimes(3);
    for (const [input] of previewConversion.mock.calls) {
      expect(input.data.toString()).toContain("editor generated pdf");
      expect(input.data.toString()).not.toContain("viewer same-path substitute");
    }
  });

  it("reads an editor-created advanced artifact across roles and returns 403 for viewer publication", async () => {
    const [previewRoute, publishRoute] = await Promise.all([
      import("@/app/api/artifacts/[artifactId]/preview/route"),
      import("@/app/api/artifacts/[artifactId]/publish/route"),
    ]);
    const context = { params: Promise.resolve({ artifactId: advancedArtifactId }) };
    for (const allowed of [ownerSession, editorSession, viewerSession]) {
      auth.session = allowed;
      const response = await previewRoute.GET(
        new Request(`http://localhost/api/artifacts/${advancedArtifactId}/preview`),
        context,
      );
      expect(response.status, allowed.user.name).toBe(200);
      expect(await response.text()).toContain("<svg");
    }
    auth.session = outsiderSession;
    expect((await previewRoute.GET(
      new Request(`http://localhost/api/artifacts/${advancedArtifactId}/preview`),
      context,
    )).status).toBe(404);

    auth.session = viewerSession;
    const denied = await publishRoute.POST(new Request(
      `http://localhost/api/artifacts/${advancedArtifactId}/publish`,
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } },
    ), context);
    expect(denied.status).toBe(403);
  });

  it("lists only resolvable shared actions and advertises viewer capabilities honestly", async () => {
    const route = await import("@/app/api/library/route");
    auth.session = viewerSession;
    const response = await route.GET(new Request("http://localhost/api/library"));
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{
      id: string;
      previewUrl: string | null;
      downloadUrl: string | null;
      capabilities?: { preview: boolean; download: boolean; history: boolean; mutate: boolean };
    }> };
    expect(body.items.find((item) => item.id === `upload:${threadId}:${UPLOAD}`)).toMatchObject({
      downloadUrl: `/api/library/uploads/${threadId}/${UPLOAD}`,
      capabilities: { preview: true, download: true, history: true, mutate: false },
    });
    expect(body.items.find((item) => item.id === `advanced:${advancedArtifactId}`)).toMatchObject({
      previewUrl: `/api/artifacts/${advancedArtifactId}/preview`,
      capabilities: { preview: true, download: true, mutate: false },
    });
    expect(body.items.find((item) => item.id === `upload:${threadId}:${LEGACY_UPLOAD}`)).toMatchObject({
      previewUrl: null,
      downloadUrl: null,
      capabilities: { preview: false, download: false, history: false, mutate: false },
    });
  });

  it("permits mutations only to owner/editor and fails closed after viewer revocation", async () => {
    const { assertLibraryResourceWritable, resolveThreadLibraryResource } = await import("@/library/server-resource-access");
    for (const allowed of [ownerSession, editorSession]) {
      const resource = await resolveThreadLibraryResource(allowed, { kind: "upload", resourceId: UPLOAD, threadId });
      expect(() => assertLibraryResourceWritable(resource.access)).not.toThrow();
      expect(resource.location.storageOwnerId).toBe(EDITOR);
    }
    const viewerResource = await resolveThreadLibraryResource(viewerSession, { kind: "upload", resourceId: UPLOAD, threadId });
    expect(() => assertLibraryResourceWritable(viewerResource.access)).toThrow("solo lectura");

    const { updateProject } = await import("@/workbench/store");
    await updateProject(ownerSession, projectId, { sharing: { visibility: "shared", members: [{
      id: EDITOR,
      email: editorSession.user.email,
      name: editorSession.user.name,
      role: "editor",
      status: "active",
      addedAt: "2026-08-30T08:00:00.000Z",
    }] } });
    await expect(resolveThreadLibraryResource(viewerSession, { kind: "upload", resourceId: UPLOAD, threadId }))
      .rejects.toThrow("Fil no trobat");
  });
});
