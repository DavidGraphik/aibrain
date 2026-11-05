import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
import type { ResolvedPermissions } from "@/permissions";

const USER_A = "0198b9f0-6631-7000-8000-000000000901";
const USER_B = "0198b9f0-6631-7000-8000-000000000902";
const INSTALLATION_ID = "local-document-workflow";
const auth = vi.hoisted(() => ({ session: null as AuthSession | null }));
const run = promisify(execFile);

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: vi.fn(async () => auth.session) }));

function executable(environmentName: string, candidates: readonly string[]) {
  const configured = process.env[environmentName]?.trim();
  return configured || candidates.find(existsSync) || candidates[0];
}

const tools = {
  soffice: executable("AIBRAIN_SOFFICE_BIN", [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/bin/soffice",
  ]),
  pdfinfo: executable("AIBRAIN_PDFINFO_BIN", ["/opt/homebrew/bin/pdfinfo", "/usr/bin/pdfinfo"]),
  pdftoppm: executable("AIBRAIN_PDFTOPPM_BIN", ["/opt/homebrew/bin/pdftoppm", "/usr/bin/pdftoppm"]),
  pdftotext: executable("AIBRAIN_PDFTOTEXT_BIN", ["/opt/homebrew/bin/pdftotext", "/usr/bin/pdftotext"]),
};
const enabled = process.env.AIBRAIN_REAL_DOCUMENT_MATRIX === "1" && Object.values(tools).every(existsSync);

function session(userId: string, tenantId = INSTALLATION_ID): AuthSession {
  return {
    provider: "local",
    user: { id: userId, name: `User ${userId.slice(-3)}`, email: `${userId.slice(-3)}@example.test` },
    tenant: { id: tenantId, name: "Local document workflow" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function permissions(userId: string, projectId: string): ResolvedPermissions {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    userId,
    roleId: null,
    projectId,
    turnId: "0198b9f0-6631-7000-8000-000000000911",
    resolvedAt: "2026-08-30T12:00:00.000Z",
    fingerprint: "a".repeat(64),
    sources: [],
    rules: [{
      ruleId: "tools.execute",
      action: "execute",
      effect: "allow",
      instruction: "Local document generation",
      sourceScope: "installation",
      sourcePolicyVersion: 1,
      precedence: 100,
    }],
    developerInstructions: `Policy fingerprint: ${"a".repeat(64)}`,
  };
}

async function extractedOfficeText(format: "docx" | "pptx" | "xlsx", data: Buffer) {
  const archive = await JSZip.loadAsync(data);
  const pattern = format === "docx"
    ? /^word\/document[.]xml$/u
    : format === "pptx"
      ? /^ppt\/slides\/slide[0-9]+[.]xml$/u
      : /^xl\/worksheets\/sheet[0-9]+[.]xml$/u;
  return (await Promise.all(Object.values(archive.files)
    .filter((entry) => !entry.dir && pattern.test(entry.name))
    .map(async (entry) => await entry.async("text")))).join("\n");
}

describe.skipIf(!enabled)("real private local document workflow", () => {
  let root: string;
  let projectId: string;
  let projectWorkspace: string;
  let receiptRoot: string;
  let installation: InstallationConfig;
  let route: typeof import("@/app/api/projects/[projectId]/files/route");
  const previousEnvironment = new Map<string, string | undefined>();
  const generated = new Map<string, { path: string; size: number; sha256: string }>();
  const evidence: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "aibrain-local-document-workflow-")));
    const dataRoot = path.join(root, "data");
    const configPath = path.join(root, "installation.json");
    const environment = {
      AIBRAIN_INSTALLATION_CONFIG: configPath,
      AIBRAIN_SOFFICE_BIN: tools.soffice,
      AIBRAIN_PDFINFO_BIN: tools.pdfinfo,
      AIBRAIN_PDFTOPPM_BIN: tools.pdftoppm,
      AIBRAIN_PDFTOTEXT_BIN: tools.pdftotext,
      AIBRAIN_MINIMUM_FREE_BYTES: "0",
      AIBRAIN_MINIMUM_FREE_RATIO: "0",
    };
    for (const [name, value] of Object.entries(environment)) {
      previousEnvironment.set(name, process.env[name]);
      process.env[name] = value;
    }
    await Promise.all([
      mkdir(dataRoot, { recursive: true, mode: 0o700 }),
      mkdir(path.join(root, "source-ro"), { recursive: true, mode: 0o500 }),
      mkdir(path.join(root, "publish-rw"), { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      companyName: "Local document workflow",
      companySlug: INSTALLATION_ID,
      publicUrl: "http://localhost:3000",
      branding: {
        productName: "Local documents",
        logoPath: "/brand/logo.svg",
        faviconPath: "/brand/favicon.svg",
        accentColor: "#315ee7",
      },
      paths: {
        dataRoot,
        companyContextRoot: path.join(dataRoot, "company"),
        usersRoot: path.join(dataRoot, "users"),
        sourceReadRoot: path.join(root, "source-ro"),
        publishWriteRoot: path.join(root, "publish-rw"),
        backupsRoot: path.join(dataRoot, "backups"),
      },
    }, null, 2)}\n`, "utf8");

    vi.resetModules();
    const [{ loadInstallationConfig }, { UserProvisioner }, workbench, workers] = await Promise.all([
      import("@/config/installation"),
      import("@/users/provisioner"),
      import("@/workbench/store"),
      import("@/runtime/workers/provisioner"),
    ]);
    installation = await loadInstallationConfig();
    const provisioner = new UserProvisioner(installation);
    await provisioner.provision({ userId: USER_A, email: session(USER_A).user.email, displayName: "User A" });
    await provisioner.provision({ userId: USER_B, email: session(USER_B).user.email, displayName: "User B" });
    projectId = (await workbench.createProject(session(USER_A), "Hello world documents")).id;
    const roots = workers.deriveWorkerRoots(installation, USER_A);
    projectWorkspace = await workers.resolveWorkerOwnedPath(roots.workspace, path.posix.join("projects", projectId));
    await mkdir(projectWorkspace, { recursive: true, mode: 0o700 });
    receiptRoot = path.join(roots.userRoot, "state", "document-generation-calls");
    route = await import("@/app/api/projects/[projectId]/files/route");
  }, 120_000);

  afterAll(async () => {
    auth.session = null;
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("generates PDF, DOCX, PPTX and XLSX locally without invoking Drive or another OAuth account", async () => {
    const { handleLocalDocumentDynamicToolCall } = await import("@/runtime/documents/dynamic-tools");
    const providerFetch = vi.spyOn(globalThis, "fetch");
    const result = await handleLocalDocumentDynamicToolCall({
      threadId: "runtime-thread",
      turnId: "runtime-turn",
      callId: "hello-world-all-formats",
      namespace: "aibrain_documents",
      tool: "create_batch",
      arguments: {
        files: (["pdf", "docx", "pptx", "xlsx"] as const).map((format) => ({
          format,
          fileName: `hello-world.${format}`,
          title: "Hello world",
          content: format === "xlsx" ? "Message\nHello world" : "Hello world",
          ...(format === "xlsx" ? { rows: [["Message"], ["Hello world"]] } : {}),
        })),
      },
    }, {
      installation,
      installationId: INSTALLATION_ID,
      userId: USER_A,
      projectId,
      projectWorkspace,
      receiptRoot,
      runtimeThreadId: "runtime-thread",
      runtimeTurnId: "runtime-turn",
      sourceThreadId: "0198b9f0-6631-7000-8000-000000000910",
      sourceTurnId: "0198b9f0-6631-7000-8000-000000000911",
      permissions: permissions(USER_A, projectId),
    });
    expect(
      result.response.success,
      (result.response.contentItems[0] as { text: string }).text,
    ).toBe(true);
    const payload = JSON.parse((result.response.contentItems[0] as { text: string }).text);
    expect(payload).toMatchObject({ status: "created", externalConnectorUsed: false });
    expect(payload.files).toHaveLength(4);
    expect(JSON.stringify(payload)).not.toContain(projectWorkspace);
    expect(JSON.stringify(payload)).not.toContain("/var/lib/");
    expect(result.artifacts).toHaveLength(4);
    expect(new Set(result.artifacts.map(({ id }) => id))).toHaveProperty("size", 4);
    for (const artifact of result.artifacts) {
      expect(artifact).toMatchObject({ status: "ready", targetLabel: null });
      const relativePath = `documents/${artifact.name}`;
      const file = payload.files.find((candidate: { fileName?: string }) => candidate.fileName === artifact.name);
      expect(file).toBeTruthy();
      generated.set(artifact.kind, { path: relativePath, size: file.size, sha256: file.sha256 });
    }
    expect(providerFetch).not.toHaveBeenCalled();
    providerFetch.mockRestore();
  }, 60_000);

  it("downloads and previews all four formats through authenticated same-origin routes", async () => {
    auth.session = session(USER_A);
    const [{ loadInstallationConfig }, { getProjectRuntimeContext }, workers, { readRegularFileWithin }] = await Promise.all([
      import("@/config/installation"),
      import("@/workbench/store"),
      import("@/runtime/workers/provisioner"),
      import("@/security/safe-file"),
    ]);
    const installation = await loadInstallationConfig();
    await expect(getProjectRuntimeContext(auth.session, projectId)).resolves.toMatchObject({ projectId });
    const routeWorkspace = await workers.resolveWorkerOwnedPath(
      workers.deriveWorkerRoots(installation, USER_A).workspace,
      path.posix.join("projects", projectId),
    );
    expect(routeWorkspace).toBe(projectWorkspace);
    await expect(readRegularFileWithin(routeWorkspace, generated.get("pdf")!.path, 50 * 1024 * 1024))
      .resolves.toHaveLength(generated.get("pdf")!.size);
    for (const format of ["pdf", "docx", "pptx", "xlsx"] as const) {
      const item = generated.get(format)!;
      const encoded = encodeURIComponent(item.path);
      const context = { params: Promise.resolve({ projectId }) };
      const download = await route.GET(new Request(
        `http://localhost/api/projects/${projectId}/files?path=${encoded}&raw=1&download=1`,
      ), context);
      expect(
        download.status,
        JSON.stringify(await download.clone().json().catch(() => null)),
      ).toBe(200);
      expect(download.headers.get("Cache-Control")).toBe("private, no-store");
      expect(download.headers.get("Content-Disposition")).toContain("attachment");
      const original = Buffer.from(await download.arrayBuffer());
      expect(original.length).toBe(item.size);

      if (format === "pdf") {
        const originalPath = path.join(root, "hello-world-original.pdf");
        const textPath = path.join(root, "hello-world-original.txt");
        await writeFile(originalPath, original, { mode: 0o600 });
        await run(tools.pdftotext, [originalPath, textPath], { timeout: 30_000 });
        expect(await readFile(textPath, "utf8")).toContain("Hello world");
      } else {
        expect(await extractedOfficeText(format, original)).toContain("Hello world");
      }

      const previewUrl = format === "pdf"
        ? `http://localhost/api/projects/${projectId}/files?path=${encoded}&raw=1`
        : `http://localhost/api/projects/${projectId}/files?path=${encoded}&representation=1`;
      const preview = await route.GET(new Request(previewUrl), context);
      expect(preview.status).toBe(200);
      expect(preview.headers.get("Content-Type")).toBe("application/pdf");
      expect(preview.headers.get("Cache-Control")).toBe("private, no-store");
      expect(preview.headers.get("X-Frame-Options")).toBe("DENY");
      expect(preview.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      const previewBytes = Buffer.from(await preview.arrayBuffer());
      expect(previewBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      const previewPath = path.join(root, `hello-world-${format}-preview.pdf`);
      const previewTextPath = path.join(root, `hello-world-${format}-preview.txt`);
      await writeFile(previewPath, previewBytes, { mode: 0o600 });
      await run(tools.pdftotext, [previewPath, previewTextPath], { timeout: 30_000 });
      expect(await readFile(previewTextPath, "utf8")).toContain("Hello world");
      evidence.push({
        format,
        generatedBytes: item.size,
        generatedSha256: item.sha256,
        downloadStatus: download.status,
        previewStatus: preview.status,
        previewTextVerified: true,
        cacheControl: preview.headers.get("Cache-Control"),
        framePolicy: preview.headers.get("X-Frame-Options"),
      });
    }
    const evidenceDirectory = path.resolve("test-results", "local-document-workflow");
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(evidenceDirectory, "evidence.json"),
      `${JSON.stringify({ schemaVersion: 1, phrase: "Hello world", externalConnectorUsed: false, formats: evidence }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }, 180_000);

  it.skipIf(!process.env.AIBRAIN_XLS_EDIT_TEST_PYTHON)("converts a legacy upload, edits its XLSX copy and downloads a durable owner-bound artifact", async () => {
    const [{ documentServicesForUser }, { prepareTurnDocumentWorkspaceInputs }, { validateUploadedDocument }, { handleLocalDocumentDynamicToolCall }, { FileWorkbenchStore }] = await Promise.all([
      import("@/documents/server-service"), import("@/documents/turn-attachments"), import("@/documents/upload-validation"),
      import("@/runtime/documents/dynamic-tools"), import("@/workbench/filesystem-store"),
    ]);
    const thread = await FileWorkbenchStore.fromInstallation(installation).createThread(USER_A, projectId, "Legacy workbook editing");
    const services = await documentServicesForUser(installation, USER_A);
    const original = await readFile(path.resolve("tests/infra/fixtures/knowledge-legacy.xls"));
    const document = await services.staging.stage({ threadId: thread.id, uploadId: "0198b9f0-6631-7000-8000-000000000919", data: original,
      validated: validateUploadedDocument({ fileName: "vendes.xls", declaredMimeType: "application/vnd.ms-excel", data: original }) });
    const prepared = await prepareTurnDocumentWorkspaceInputs({ documents: [{ document, absolutePath: path.join(services.manifest.roots.staging, document.relativePath), codexInputs: [] }],
      projectWorkspace, stagingRoot: services.manifest.roots.staging, legacyExcelConversion: { soffice: tools.soffice, conversionGate: services.conversionGate } });
    const finalPath = "documents/vendes-editades.xlsx";
    await mkdir(path.join(projectWorkspace, "documents"), { recursive: true, mode: 0o700 });
    await run(process.env.AIBRAIN_XLS_EDIT_TEST_PYTHON!, ["-c", `import sys,openpyxl
w=openpyxl.load_workbook(sys.argv[1]); w["Operación"]["B1"]=20; w.save(sys.argv[2])`, path.join(prepared.directory!, "input-1.xlsx"), path.join(projectWorkspace, finalPath)]);
    const edited = await readFile(path.join(projectWorkspace, finalPath));
    const result = await handleLocalDocumentDynamicToolCall({ threadId: "runtime-thread", turnId: "runtime-turn", callId: "legacy-xls-edit-delivery", namespace: "aibrain_documents", tool: "deliver", arguments: { relativePath: finalPath } }, {
      installation, installationId: INSTALLATION_ID, userId: USER_A, projectId, projectWorkspace, receiptRoot,
      runtimeThreadId: "runtime-thread", runtimeTurnId: "runtime-turn", sourceThreadId: thread.id, sourceTurnId: "0198b9f0-6631-7000-8000-000000000918", permissions: permissions(USER_A, projectId),
    });
    expect(result.response.success, JSON.stringify(result.response.contentItems)).toBe(true);
    const artifact = result.artifacts[0]!;
    expect(artifact.kind).toBe("xlsx");
    const artifactRoute = await import("@/app/api/threads/[threadId]/artifacts/[artifactId]/route");
    const context = { params: Promise.resolve({ threadId: thread.id, artifactId: artifact.id }) };
    auth.session = session(USER_A);
    const download = await artifactRoute.GET(new Request(`http://localhost${artifact.url}`), context);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(edited);
    // The durable artifact survives loss of the mutable output and turn copies.
    await rm(path.join(projectWorkspace, finalPath));
    await rm(prepared.directory!, { recursive: true });
    const again = await artifactRoute.GET(new Request(`http://localhost${artifact.url}`), context);
    expect(Buffer.from(await again.arrayBuffer())).toEqual(edited);
    auth.session = session(USER_B);
    expect((await artifactRoute.GET(new Request(`http://localhost${artifact.url}`), context)).status).toBe(404);
    expect(await readFile(path.join(services.manifest.roots.staging, document.relativePath))).toEqual(original);
  }, 90_000);

  it("reauthorizes every file request and hides User A documents from User B and another tenant", async () => {
    const item = generated.get("pdf")!;
    const request = new Request(
      `http://localhost/api/projects/${projectId}/files?path=${encodeURIComponent(item.path)}&raw=1&download=1`,
    );
    const context = { params: Promise.resolve({ projectId }) };
    auth.session = null;
    expect((await route.GET(request, context)).status).toBe(401);
    auth.session = session(USER_B);
    expect((await route.GET(request, context)).status).toBe(404);
    auth.session = session(USER_A, "another-tenant");
    expect((await route.GET(request, context)).status).toBe(403);
  });
});
