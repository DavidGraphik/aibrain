import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { oggOpusFixture } from "../helpers/ogg-opus-fixture";
import { generatedPngFixture } from "../helpers/png-fixture";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { assertUiContract } from "../helpers/ui-contract";

const USER_A = "0198b9f0-6631-7000-8000-000000000501";
const USER_B = "0198b9f0-6631-7000-8000-000000000502";
const UPLOAD_ID = "0198b9f0-6631-7000-8000-000000000511";
const BAD_UPLOAD_ID = "0198b9f0-6631-7000-8000-000000000512";
const auth = vi.hoisted(() => ({ session: null as AuthSession | null }));
const capacityFault = vi.hoisted(() => ({ mode: null as "low" | "unknown" | null }));
const storageFault = vi.hoisted(() => ({ code: null as "ENOSPC" | "EDQUOT" | null, phase: "write" as "write" | "open" }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const { Writable } = await import("node:stream");
  return { ...fs, createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
    const code = storageFault.code;
    if (!code || storageFault.phase !== "write") return fs.createWriteStream(...args);
    storageFault.code = null;
    const fd = (args[1] as { fd: number }).fd;
    return new Writable({ write(chunk: Buffer, _encoding, callback) {
      fs.writeSync(fd, chunk.subarray(0, 8));
      callback(Object.assign(new Error("synthetic write failure"), { code }));
    } });
  } };
});

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, statfs: (...args: Parameters<typeof fs.statfs>) => {
    if (capacityFault.mode === "unknown") return Promise.reject(Object.assign(new Error("synthetic statfs denial"), { code: "EACCES" }));
    if (capacityFault.mode === "low") return Promise.resolve({ bavail: 999_999_999n, bsize: 1n });
    return fs.statfs(...args);
  }, open: (...args: Parameters<typeof fs.open>) => {
    if (storageFault.code && storageFault.phase === "open" && String(args[0]).endsWith(".upload")) {
      const code = storageFault.code;
      storageFault.code = null;
      return Promise.reject(Object.assign(new Error("synthetic inode exhaustion"), { code }));
    }
    return fs.open(...args);
  } };
});

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({
  getSession: vi.fn(async () => auth.session),
  isVercelPreviewDemoEnabled: () => false,
}));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: vi.fn(async () => true) }));

function session(userId: string): AuthSession {
  return {
    provider: "local",
    user: {
      id: userId,
      name: `User ${userId.slice(-3)}`,
      email: `${userId.slice(-3)}@example.test`,
    },
    tenant: { id: "documents-lab", name: "Documents Lab" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function uploadRequest(uploadId: string, file: File) {
  const body = new FormData();
  body.set("uploadId", uploadId);
  body.set("file", file);
  return new Request("http://localhost/api/threads/thread/documents", {
    method: "POST",
    body,
  });
}

describe("authenticated document routes", () => {
  let root: string;
  let dataRoot: string;
  let previousConfig: string | undefined;
  let previousMinimumFreeBytes: string | undefined;
  let previousMinimumFreeRatio: string | undefined;
  let previousMaximumActiveUploads: string | undefined;
  let previousWorstCaseActiveBytes: string | undefined;
  let threadId: string;

  beforeAll(async () => {
    previousConfig = process.env.AIBRAIN_INSTALLATION_CONFIG;
    previousMinimumFreeBytes = process.env.AIBRAIN_MINIMUM_FREE_BYTES;
    previousMinimumFreeRatio = process.env.AIBRAIN_MINIMUM_FREE_RATIO;
    previousMaximumActiveUploads = process.env.AIBRAIN_DOCUMENT_MAX_ACTIVE_UPLOADS;
    previousWorstCaseActiveBytes = process.env.AIBRAIN_DOCUMENT_WORST_CASE_ACTIVE_BYTES;
    process.env.AIBRAIN_MINIMUM_FREE_BYTES = "0";
    process.env.AIBRAIN_MINIMUM_FREE_RATIO = "0";
    process.env.AIBRAIN_DOCUMENT_MAX_ACTIVE_UPLOADS = "1";
    process.env.AIBRAIN_DOCUMENT_WORST_CASE_ACTIVE_BYTES = "134217728";
    root = await mkdtemp(path.join(tmpdir(), "aibrain-document-routes-"));
    dataRoot = path.join(root, "data");
    const configPath = path.join(root, "installation.json");
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 1,
      installationId: "documents-lab",
      companyName: "Documents Lab",
      companySlug: "documents-lab",
      publicUrl: "http://localhost:3000",
      branding: {
        productName: "Documents Brain",
        logoPath: "/brand/logo.svg",
        faviconPath: "/brand/favicon.svg",
        accentColor: "#334455",
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
    process.env.AIBRAIN_INSTALLATION_CONFIG = configPath;

    const [{ loadInstallationConfig }, { UserProvisioner }, { FileWorkbenchStore }] = await Promise.all([
      import("@/config/installation"),
      import("@/users/provisioner"),
      import("@/workbench/filesystem-store"),
    ]);
    const installation = await loadInstallationConfig();
    const provisioner = new UserProvisioner(installation);
    await provisioner.provision({ userId: USER_A, email: `${USER_A.slice(-3)}@example.test`, displayName: "User A" });
    await provisioner.provision({ userId: USER_B, email: `${USER_B.slice(-3)}@example.test`, displayName: "User B" });
    const workbench = FileWorkbenchStore.fromInstallation(installation);
    const project = await workbench.createProject(USER_A, "Document Operations");
    threadId = (await workbench.createThread(USER_A, project.id, "Private upload")).id;
  });

  afterAll(async () => {
    auth.session = null;
    if (previousConfig === undefined) delete process.env.AIBRAIN_INSTALLATION_CONFIG;
    else process.env.AIBRAIN_INSTALLATION_CONFIG = previousConfig;
    if (previousMinimumFreeBytes === undefined) delete process.env.AIBRAIN_MINIMUM_FREE_BYTES;
    else process.env.AIBRAIN_MINIMUM_FREE_BYTES = previousMinimumFreeBytes;
    if (previousMinimumFreeRatio === undefined) delete process.env.AIBRAIN_MINIMUM_FREE_RATIO;
    else process.env.AIBRAIN_MINIMUM_FREE_RATIO = previousMinimumFreeRatio;
    if (previousMaximumActiveUploads === undefined) delete process.env.AIBRAIN_DOCUMENT_MAX_ACTIVE_UPLOADS;
    else process.env.AIBRAIN_DOCUMENT_MAX_ACTIVE_UPLOADS = previousMaximumActiveUploads;
    if (previousWorstCaseActiveBytes === undefined) delete process.env.AIBRAIN_DOCUMENT_WORST_CASE_ACTIVE_BYTES;
    else process.env.AIBRAIN_DOCUMENT_WORST_CASE_ACTIVE_BYTES = previousWorstCaseActiveBytes;
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    { mode: "low", status: 507, code: "DOCUMENT_STORAGE_CAPACITY_LOW" },
    { mode: "unknown", status: 503, code: "DOCUMENT_STORAGE_CAPACITY_UNAVAILABLE" },
  ] as const)("rejects $mode capacity before intake and releases the slot", async ({ mode, status, code }) => {
    const route = await import("@/app/api/threads/[threadId]/documents/route");
    const { documentServicesForUser } = await import("@/documents/server-service");
    const { loadInstallationConfig } = await import("@/config/installation");
    const services = await documentServicesForUser(await loadInstallationConfig(), USER_A);
    const failedId = "0198b9f0-6631-7000-8000-000000000590";
    auth.session = session(USER_A);
    capacityFault.mode = mode;
    try {
      const response = await route.POST(uploadRequest(failedId, new File(["never intake"], "capacity.txt", { type: "text/plain" })), { params: Promise.resolve({ threadId }) });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      await expect(services.staging.readById(threadId, failedId)).rejects.toThrow();
    } finally { capacityFault.mode = null; }
    await expect(services.storageGate.run(() => "slot released")).resolves.toBe("slot released");
  });

  it.each([
    { code: "ENOSPC", phase: "write", suffix: "531" },
    { code: "EDQUOT", phase: "write", suffix: "532" },
    { code: "ENOSPC", phase: "open", suffix: "533" },
  ] as const)("returns 507 for $code at $phase and cleans intake without recording a document", async ({ code, phase, suffix }) => {
    const uploadRoute = await import("@/app/api/threads/[threadId]/documents/route");
    const { documentServicesForUser } = await import("@/documents/server-service");
    const { loadInstallationConfig } = await import("@/config/installation");
    const failedId = `0198b9f0-6631-7000-8000-000000000${suffix}`;
    const services = await documentServicesForUser(await loadInstallationConfig(), USER_A);
    auth.session = session(USER_A);
    storageFault.code = code;
    storageFault.phase = phase;
    try {
      const response = await uploadRoute.POST(uploadRequest(failedId, new File(["partial must disappear"], "failed.txt", { type: "text/plain" })), { params: Promise.resolve({ threadId }) });
      expect(response.status).toBe(507);
      expect(await response.json()).toMatchObject({ code: "DOCUMENT_STORAGE_FULL" });
      expect(await readdir(path.join(services.staging.rootDirectory, ".incoming"))).toEqual([]);
      await expect(services.staging.readById(threadId, failedId)).rejects.toThrow();
      await expect(services.versions.read(threadId, failedId)).rejects.toThrow();
      const { resourceLocationIndexForInstallation } = await import("@/library/server-resource-access");
      expect(await resourceLocationIndexForInstallation(await loadInstallationConfig()).binding("upload", failedId)).toBeNull();
      // A fresh gate must acquire the exact shared slot after the failed write.
      const { FileDocumentStorageGate } = await import("@/documents/storage-gate");
      await expect(new FileDocumentStorageGate({ rootDirectory: path.join(dataRoot, "locks", "document-storage"), capacityDirectories: [dataRoot], maxActiveUploads: 1 }).run(() => "released")).resolves.toBe("released");
      const retry = await uploadRoute.POST(uploadRequest(failedId, new File(["retry succeeds"], "failed.txt", { type: "text/plain" })), { params: Promise.resolve({ threadId }) });
      expect(retry.status).toBe(201);
    } finally { storageFault.code = null; }
  });

  it("stages, previews and serves a text document only to the owning user", async () => {
    const uploadRoute = await import("@/app/api/threads/[threadId]/documents/route");
    const previewRoute = await import(
      "@/app/api/threads/[threadId]/documents/[uploadId]/preview/[fileName]/route"
    );
    auth.session = null;
    expect((await uploadRoute.POST(
      uploadRequest(UPLOAD_ID, new File(["private"], "notes.md", { type: "text/markdown" })),
      { params: Promise.resolve({ threadId }) },
    )).status).toBe(401);

    auth.session = session(USER_A);
    const response = await uploadRoute.POST(
      uploadRequest(UPLOAD_ID, new File(["Private document\n"], "notes.md", { type: "text/markdown" })),
      { params: Promise.resolve({ threadId }) },
    );
    expect(response.status).toBe(201);
    const result = await response.json() as {
      document: { kind: string; sha256: string };
      preview: { files: Array<{ name: string; url: string }> };
    };
    expect(result).toMatchObject({
      document: { kind: "text" },
      preview: { files: [{ name: "preview.txt" }] },
    });
    expect(() => assertUiContract("DocumentUploadResponse", result)).not.toThrow();

    const previewContext = {
      params: Promise.resolve({ threadId, uploadId: UPLOAD_ID, fileName: "preview.txt" }),
    };
    const preview = await previewRoute.GET(new Request("http://localhost/preview"), previewContext);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Cache-Control")).toBe("private, no-store");
    expect(preview.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(preview.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(preview.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(preview.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await preview.text()).toBe("Private document\n");

    // A previously uploaded document keeps its authorized URL after a cache
    // schema upgrade, deletion, or corruption. Retry must rebuild real bytes.
    const { loadInstallationConfig } = await import("@/config/installation");
    const { documentServicesForUser } = await import("@/documents/server-service");
    const services = await documentServicesForUser(await loadInstallationConfig(), USER_A);
    const versionPreviewRoute = await import("@/app/api/threads/[threadId]/documents/[uploadId]/versions/[versionId]/preview/[fileName]/route");
    const versionContext = { params: Promise.resolve({ threadId, uploadId: UPLOAD_ID, versionId: UPLOAD_ID, fileName: "preview.txt" }) };
    const versionPreview = await versionPreviewRoute.GET(new Request("http://localhost/version-preview"), versionContext);
    expect(versionPreview.status).toBe(200);
    expect(Object.fromEntries(versionPreview.headers)).toEqual(Object.fromEntries(preview.headers));
    expect(await versionPreview.text()).toBe("Private document\n");
    const previewDirectory = path.join(services.previews.previewRoot, threadId, UPLOAD_ID);
    const metadataPath = path.join(previewDirectory, "preview.json");
    const oldMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
    oldMetadata.schemaVersion = 1;
    delete oldMetadata.artifacts;
    await writeFile(metadataPath, JSON.stringify(oldMetadata), { mode: 0o600 });
    const recovered = await previewRoute.GET(new Request("http://localhost/preview"), previewContext);
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe("Private document\n");
    await rm(path.join(previewDirectory, "preview.txt"));
    const recreated = await previewRoute.GET(new Request("http://localhost/preview"), previewContext);
    expect(recreated.status).toBe(200);
    expect(await recreated.text()).toBe("Private document\n");

    auth.session = session(USER_B);
    expect((await previewRoute.GET(new Request("http://localhost/preview"), previewContext)).status).toBe(404);
    expect((await versionPreviewRoute.GET(new Request("http://localhost/version-preview"), versionContext)).status).toBe(404);
  });

  it("transcribes an original audio through the same owner/tenant ACL and private routes", async () => {
    const { SystemDocumentToolRunner } = await import("@/documents/preview-service");
    const { loadInstallationConfig } = await import("@/config/installation");
    const { documentServicesForUser } = await import("@/documents/server-service");
    const { parseDocumentUploadResponse } = await import("@/ui/document-ui-adapter");
    const uploadRoute = await import("@/app/api/threads/[threadId]/documents/route");
    const previewRoute = await import("@/app/api/threads/[threadId]/documents/[uploadId]/preview/[fileName]/route");
    const downloadRoute = await import("@/app/api/threads/[threadId]/documents/[uploadId]/versions/[versionId]/route");
    const historyRoute = await import("@/app/api/threads/[threadId]/documents/[uploadId]/route");
    const { isSameOriginMutation } = await import("@/auth/request-security");
    const uploadId = "0198b9f0-6631-7000-8000-000000000529";
    const ogg = oggOpusFixture();
    const send = () => uploadRoute.POST(uploadRequest(uploadId, new File([new Uint8Array(ogg)], "voice.ogg", { type: "audio/ogg" })), { params: Promise.resolve({ threadId }) });
    const previous = [process.env.AIBRAIN_FFPROBE_BIN, process.env.AIBRAIN_AUDIO_TRANSCRIBER_BIN];
    const runner = vi.spyOn(SystemDocumentToolRunner.prototype, "run").mockImplementation(async (command) => ({
      stdout: command === "/tools/ffprobe" ? JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "opus", channels: 1, sample_rate: "48000" }], format: { format_name: "ogg", duration: "1.0" } }) : "Synthetic HTTP fixture transcript", stderr: "",
    }));
    try {
      process.env.AIBRAIN_FFPROBE_BIN = "/tools/ffprobe";
      process.env.AIBRAIN_AUDIO_TRANSCRIBER_BIN = "/tools/transcribe";
      auth.session = session(USER_A);
      vi.mocked(isSameOriginMutation).mockResolvedValueOnce(false);
      expect((await send()).status).toBe(403);
      auth.session = null; expect((await send()).status).toBe(401);
      auth.session = session(USER_B); expect((await send()).status).toBe(404);
      auth.session = { ...session(USER_A), tenant: { id: "other-installation", name: "Other" } }; expect((await send()).status).toBe(403);
      expect(runner).not.toHaveBeenCalled();
      auth.session = session(USER_A);
      const response = await send(); expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.document.kind).toBe("audio"); expect(parseDocumentUploadResponse(result)).not.toBeNull();
      expect(() => assertUiContract("DocumentUploadResponse", result)).not.toThrow();
      const config = await loadInstallationConfig(); const services = await documentServicesForUser(config, USER_A);
      const staged = await services.staging.readById(threadId, uploadId);
      expect(await readFile(path.join(services.manifest.roots.staging, staged.relativePath))).toEqual(ogg);
      const previewContext = { params: Promise.resolve({ threadId, uploadId, fileName: "preview.txt" }) };
      const preview = await previewRoute.GET(new Request("http://localhost/preview"), previewContext);
      expect(preview.status).toBe(200); expect(await preview.text()).toBe("Synthetic HTTP fixture transcript");
      expect(preview.headers.get("Cache-Control")).toBe("private, no-store");
      const history = await historyRoute.GET(new Request("http://localhost/history"), { params: Promise.resolve({ threadId, uploadId }) });
      const versionId = (await history.json()).document.originalVersionId;
      const downloadContext = { params: Promise.resolve({ threadId, uploadId, versionId }) };
      const download = await downloadRoute.GET(new Request("http://localhost/download"), downloadContext);
      expect(download.status).toBe(200); expect(Buffer.from(await download.arrayBuffer())).toEqual(ogg);
      auth.session = session(USER_B);
      expect((await previewRoute.GET(new Request("http://localhost/preview"), previewContext)).status).toBe(404);
      expect((await downloadRoute.GET(new Request("http://localhost/download"), downloadContext)).status).toBe(404);
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      runner.mockRestore();
      for (const [index, key] of ["AIBRAIN_FFPROBE_BIN", "AIBRAIN_AUDIO_TRANSCRIBER_BIN"].entries()) {
        if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
      }
    }
  });

  it("stages a PNG privately and supplies image bytes to the model without publication", async () => {
    const uploadRoute = await import("@/app/api/threads/[threadId]/documents/route");
    const previewRoute = await import("@/app/api/threads/[threadId]/documents/[uploadId]/preview/[fileName]/route");
    const { documentServicesForUser } = await import("@/documents/server-service");
    const { loadInstallationConfig } = await import("@/config/installation");
    const { ServerTurnDocumentInputResolver } = await import("@/documents/turn-attachments");
    auth.session = session(USER_A);
    const uploadId = "0198b9f0-6631-7000-8000-000000000519";
    const png = generatedPngFixture();
    const response = await uploadRoute.POST(uploadRequest(uploadId, new File([new Uint8Array(png)], "input.png", { type: "image/png" })), { params: Promise.resolve({ threadId }) });
    expect(response.status).toBe(201);
    expect((await response.json()).document.kind).toBe("image");
    const config = await loadInstallationConfig();
    const services = await documentServicesForUser(config, USER_A);
    const staged = await services.staging.readById(threadId, uploadId);
    const resolver = new ServerTurnDocumentInputResolver({ stagingRoot: services.manifest.roots.staging, previews: services.previews, pdftotext: "/unused/pdftotext" });
    expect(await resolver.resolve(staged)).toEqual([{ type: "image", url: `data:image/png;base64,${png.toString("base64")}` }]);
    const preview = await previewRoute.GET(new Request("http://localhost/preview"), { params: Promise.resolve({ threadId, uploadId, fileName: "preview.png" }) });
    expect(preview.status).toBe(200);
    expect(Buffer.from(await preview.arrayBuffer()).equals(png)).toBe(true);
    const versionPreviewRoute = await import("@/app/api/threads/[threadId]/documents/[uploadId]/versions/[versionId]/preview/[fileName]/route");
    const versionContext = { params: Promise.resolve({ threadId, uploadId, versionId: uploadId, fileName: "preview.png" }) };
    const versionPreview = await versionPreviewRoute.GET(new Request("http://localhost/version-preview"), versionContext);
    expect(versionPreview.status).toBe(200);
    expect(Object.fromEntries(versionPreview.headers)).toEqual(Object.fromEntries(preview.headers));
    expect(Buffer.from(await versionPreview.arrayBuffer())).toEqual(png);
    expect(existsSync(config.paths.publishWriteRoot)).toBe(false);
    auth.session = session(USER_B);
    expect((await previewRoute.GET(new Request("http://localhost/preview"), { params: Promise.resolve({ threadId, uploadId, fileName: "preview.png" }) })).status).toBe(404);
    expect((await versionPreviewRoute.GET(new Request("http://localhost/version-preview"), versionContext)).status).toBe(404);
  });

  it("rejects false MIME before any staged response is returned", async () => {
    const uploadRoute = await import("@/app/api/threads/[threadId]/documents/route");
    auth.session = session(USER_A);
    const response = await uploadRoute.POST(
      uploadRequest(BAD_UPLOAD_ID, new File(["not a pdf"], "report.pdf", { type: "application/pdf" })),
      { params: Promise.resolve({ threadId }) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "El document no supera la validació de seguretat." });
  });

  it("rejects a malformed Excel hyperlink record without staging the workbook", async () => {
    const uploadRoute = await import("@/app/api/threads/[threadId]/documents/route");
    const data = await readFile(path.resolve("tests/infra/fixtures/knowledge-legacy.xls"));
    const bof = data.indexOf(Buffer.from("0908100000060500", "hex"));
    expect(bof).toBeGreaterThan(0);
    data.writeUInt16LE(0x01b8, bof + 20); // Synthetic HLINK; never a customer file.
    auth.session = session(USER_A);
    const response = await uploadRoute.POST(
      uploadRequest(BAD_UPLOAD_ID, new File([new Uint8Array(data)], "unsafe.xls", { type: "application/octet-stream" })),
      { params: Promise.resolve({ threadId }) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "El document no supera la validació de seguretat." });
    const [{ loadInstallationConfig }, { documentServicesForUser }] = await Promise.all([
      import("@/config/installation"), import("@/documents/server-service"),
    ]);
    const services = await documentServicesForUser(await loadInstallationConfig(), USER_A);
    await expect(services.staging.readById(threadId, BAD_UPLOAD_ID)).rejects.toThrow();
  });

  it("admits XLSM through the authenticated route, retains the original and isolates its passive derivative", async () => {
    const [{ default: JSZip }, { generateLocalDocument }, { DocumentPreviewService }, uploadRoute, contentRoute,
      { loadInstallationConfig }, { documentServicesForUser }, projectRoute, { FileWorkbenchStore }] = await Promise.all([
      import("jszip"), import("@/runtime/documents/local-document-generator"), import("@/documents/preview-service"),
      import("@/app/api/threads/[threadId]/documents/route"), import("@/app/api/threads/[threadId]/documents/[uploadId]/versions/[versionId]/route"),
      import("@/config/installation"), import("@/documents/server-service"), import("@/app/api/projects/[projectId]/sources/route"), import("@/workbench/filesystem-store"),
    ]);
    const generated = await generateLocalDocument({ format: "xlsx", title: "Synthetic", content: "Synthetic", rows: [["Fixture", 12.5]] });
    const zip = await JSZip.loadAsync(generated.data);
    zip.file("xl/vbaProject.bin", "INERT_TEST_VBA_PAYLOAD");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const id = "0198b9f0-6631-7000-8000-000000000595";
    const request = () => uploadRequest(id, new File([new Uint8Array(bytes)], "fixture.xlsm", { type: "application/vnd.ms-excel.sheet.macroEnabled.12" }));
    const preview = vi.spyOn(DocumentPreviewService.prototype, "create").mockRejectedValue(new Error("OPTIONAL_PREVIEW_FAILED"));
    try {
      auth.session = session(USER_A);
      const response = await uploadRoute.POST(request(), { params: Promise.resolve({ threadId }) });
      expect(response.status).toBe(201);
      const body = await response.json();
      assertUiContract("DocumentUploadResponse", body);
      expect(body.document.fileName).toBe("fixture.passive.xlsx");
      expect(body.document.legacyExcel.originalFileName).toBe("fixture.xlsm");
      const config = await loadInstallationConfig();
      const services = await documentServicesForUser(config, USER_A);
      expect(await readFile((await services.legacyOriginals.resolveContentById(threadId, id)).absolutePath)).toEqual(bytes);
      expect((await uploadRoute.POST(request(), { params: Promise.resolve({ threadId }) })).status).toBe(201);
      const context = { params: Promise.resolve({ threadId, uploadId: id, versionId: id }) };
      const content = await contentRoute.GET(new Request("http://localhost/content"), context);
      expect(content.status).toBe(200);
      const passive = await JSZip.loadAsync(await content.arrayBuffer());
      expect(passive.file("xl/vbaProject.bin")).toBeNull();
      const workbench = FileWorkbenchStore.fromInstallation(config);
      const project = await workbench.createProject(USER_A, "XLSM reference");
      const source = await projectRoute.POST(request(), { params: Promise.resolve({ projectId: project.id }) });
      expect(source.status).toBe(201);
      expect((await source.json()).source.name).toBe("fixture.passive.xlsx");
      auth.session = session(USER_B);
      expect((await uploadRoute.POST(request(), { params: Promise.resolve({ threadId }) })).status).toBe(404);
      expect((await contentRoute.GET(new Request("http://localhost/content"), context)).status).toBe(404);
      expect((await projectRoute.POST(request(), { params: Promise.resolve({ projectId: project.id }) })).status).toBe(404);
    } finally { preview.mockRestore(); }
  }, 20_000);

  it.each(["passive", "native"])("stores %s XLS originals outside workers and serves only the authorized derivative with stable retries", async mode => {
    const [{ SystemDocumentToolRunner, DocumentPreviewService }, { documentServicesForUser }, { loadInstallationConfig },
      { buildWorkerLaunchContext }, uploadRoute, contentRoute, { generateLocalDocument }] = await Promise.all([
      import("@/documents/preview-service"), import("@/documents/server-service"), import("@/config/installation"),
      import("@/runtime/workers/provisioner"), import("@/app/api/threads/[threadId]/documents/route"),
      import("@/app/api/threads/[threadId]/documents/[uploadId]/versions/[versionId]/route"),
      import("@/runtime/documents/local-document-generator"),
    ]);
    const passive = mode === "passive";
    const id = passive ? "0198b9f0-6631-7000-8000-000000000591" : "0198b9f0-6631-7000-8000-000000000592";
    const original = await readFile(`tests/fixtures/${passive ? "legacy-passive-links-macros" : "legacy-autofilter"}.xls`);
    const golden = await readFile("tests/fixtures/legacy-passive-result.json");
    const generated = await generateLocalDocument({ format: "xlsx", title: "Synthetic", content: "Synthetic", rows: [["Fixture", 12.5]] });
    const run = vi.spyOn(SystemDocumentToolRunner.prototype, "run").mockImplementation(async (command, args, options) => {
      if (passive) {
        expect(command).toBe("/usr/local/bin/aibrain-xls-passive"); expect(args).toEqual([]);
        expect((await readFile(path.join(options.cwd, "source.biff"))).includes(Buffer.from("INERT_TEST_VBA_PAYLOAD"))).toBe(false);
        await writeFile(path.join(options.cwd, "output/result.json"), golden, { mode: 0o600 });
      } else {
        expect(args).toContain("xlsx:Calc MS Excel 2007 XML");
        expect(await readFile(path.join(options.cwd, "source.xls"))).toEqual(original);
        await writeFile(path.join(options.cwd, "source.xlsx"), generated.data, { mode: 0o600 });
      }
      return { stdout: "", stderr: "" };
    });
    // The separate immutable-container test exercises real Office/PDF preview.
    const preview = vi.spyOn(DocumentPreviewService.prototype, "create").mockImplementation(async document => ({
      schemaVersion: 2, uploadId: document.uploadId, threadId: document.threadId, sourceSha256: document.sha256,
      status: "ready", kind: "xlsx", files: ["document.pdf"], artifacts: [{ fileName: "document.pdf", size: 20, sha256: "a".repeat(64) }], pages: 1, createdAt: new Date().toISOString(),
    }));
    try {
      auth.session = session(USER_A);
      const request = (bytes = original) => uploadRequest(id, new File([new Uint8Array(bytes)], "fixture.xls", { type: "application/octet-stream" }));
      const response = await uploadRoute.POST(request(), { params: Promise.resolve({ threadId }) });
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(() => assertUiContract("DocumentUploadResponse", result)).not.toThrow();
      expect(result.document.fileName).toBe(passive ? "fixture.passive.xlsx" : "fixture.xlsx");
      expect(Boolean(result.document.legacyExcel)).toBe(passive);
      const config = await loadInstallationConfig(), services = await documentServicesForUser(config, USER_A);
      const stored = await services.legacyOriginals.resolveContentById(threadId, id);
      expect(await readFile(stored.absolutePath)).toEqual(original);
      const mounts = buildWorkerLaunchContext(config, services.manifest).mounts;
      for (const mount of [...mounts.runtimeReadOnly, ...mounts.runtimeReadWrite, ...mounts.browserReadWrite]) {
        expect(stored.absolutePath.startsWith(mount + path.sep)).toBe(false);
        expect(path.join(services.staging.rootDirectory, ".incoming").startsWith(mount + path.sep)).toBe(false);
      }
      const context = { params: Promise.resolve({ threadId, uploadId: id, versionId: id }) };
      const download = await contentRoute.GET(new Request("http://localhost/content"), context);
      expect(download.status).toBe(200); expect(download.headers.get("Cache-Control")).toBe("private, no-store");
      const bytes = Buffer.from(await download.arrayBuffer());
      expect(bytes.equals(original)).toBe(false); expect(bytes.includes(Buffer.from("INERT_TEST_VBA_PAYLOAD"))).toBe(false);
      expect((await uploadRoute.POST(request(), { params: Promise.resolve({ threadId }) })).status).toBe(201);
      expect(run).toHaveBeenCalledTimes(1);
      const changed = Buffer.from(original); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      expect((await uploadRoute.POST(request(changed), { params: Promise.resolve({ threadId }) })).status).toBe(409);
      expect(await readFile(stored.absolutePath)).toEqual(original);
      auth.session = session(USER_B);
      expect((await contentRoute.GET(new Request("http://localhost/content"), context)).status).toBe(404);
      expect((await uploadRoute.POST(request(), { params: Promise.resolve({ threadId }) })).status).toBe(404);
    } finally { run.mockRestore(); preview.mockRestore(); }
  }, 20_000);

  it.each(["passive", "native"])("keeps the original and an explicit receipt when the %s processor fails", async mode => {
    const { SystemDocumentToolRunner } = await import("@/documents/preview-service");
    const { POST } = await import("@/app/api/threads/[threadId]/documents/route");
    const run = vi.spyOn(SystemDocumentToolRunner.prototype, "run").mockRejectedValue(new Error("PRIVATE_INPUT_MUST_NOT_ESCAPE"));
    try {
      auth.session = session(USER_A);
      const id = mode === "passive" ? BAD_UPLOAD_ID : "0198b9f0-6631-7000-8000-000000000593";
      const bytes = await readFile(`tests/fixtures/${mode === "passive" ? "legacy-passive-links-macros" : "legacy-autofilter"}.xls`);
      const request = () => uploadRequest(id, new File([new Uint8Array(bytes)], "fixture.xls", { type: "application/vnd.ms-excel" }));
      const response = await POST(request(), { params: Promise.resolve({ threadId }) });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(() => assertUiContract("DocumentUploadResponse", body)).not.toThrow();
      const { parseDocumentUploadResponse } = await import("@/ui/document-ui-adapter");
      expect(parseDocumentUploadResponse(body)?.document.storedLegacyExcel).toMatchObject({ status: "unavailable", originalFileName: "fixture.xls", originalSize: bytes.length });
      expect(body.document.kind).toBe("text");
      expect(JSON.stringify(body)).not.toContain("PRIVATE_INPUT");
      const { documentServicesForUser } = await import("@/documents/server-service");
      const { loadInstallationConfig } = await import("@/config/installation");
      const services = await documentServicesForUser(await loadInstallationConfig(), USER_A);
      const stored = await services.legacyOriginals.resolveContentById(threadId, id);
      expect(await readFile(stored.absolutePath)).toEqual(bytes);
      const receipt = await services.staging.resolveContentById(threadId, id);
      const receiptBytes = await readFile(receipt.absolutePath);
      expect(receiptBytes.toString()).toContain("procesamiento no está disponible");
      expect(receiptBytes.includes(Buffer.from("INERT_TEST_VBA_PAYLOAD"))).toBe(false);
      expect(receiptBytes.includes(Buffer.from("PRIVATE_INPUT"))).toBe(false);
      expect((await POST(request(), { params: Promise.resolve({ threadId }) })).status).toBe(201);
      expect(run).toHaveBeenCalledOnce();
      expect((await services.staging.readById(threadId, id)).sha256).toBe(receipt.document.sha256);
      auth.session = session(USER_B);
      expect((await POST(request(), { params: Promise.resolve({ threadId }) })).status).toBe(404);
    } finally { run.mockRestore(); }
  });

  it("accepts a converted XLS when optional preview rendering fails", async () => {
    const { SystemDocumentToolRunner, DocumentPreviewService } = await import("@/documents/preview-service");
    const { POST } = await import("@/app/api/threads/[threadId]/documents/route");
    const { generateLocalDocument } = await import("@/runtime/documents/local-document-generator");
    const { parseDocumentUploadResponse } = await import("@/ui/document-ui-adapter");
    const generated = await generateLocalDocument({ format: "xlsx", title: "Synthetic", content: "Synthetic", rows: [["Fixture", 12.5]] });
    const run = vi.spyOn(SystemDocumentToolRunner.prototype, "run").mockImplementation(async (_command, _args, options) => {
      await writeFile(path.join(options.cwd, "source.xlsx"), generated.data, { mode: 0o600 });
      return { stdout: "", stderr: "" };
    });
    const preview = vi.spyOn(DocumentPreviewService.prototype, "create").mockRejectedValue(new Error("PRIVATE_RENDER_ERROR"));
    try {
      auth.session = session(USER_A);
      const bytes = await readFile("tests/fixtures/legacy-autofilter.xls");
      const response = await POST(uploadRequest("0198b9f0-6631-7000-8000-000000000594", new File([new Uint8Array(bytes)], "fixture.xls", { type: "application/vnd.ms-excel" })), { params: Promise.resolve({ threadId }) });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(() => assertUiContract("DocumentUploadResponse", body)).not.toThrow();
      expect(parseDocumentUploadResponse(body)).toMatchObject({ originalStored: true, document: { kind: "xlsx" }, preview: { status: "unavailable", files: [] } });
      expect(JSON.stringify(body)).not.toContain("PRIVATE_RENDER_ERROR");
      const invalid = structuredClone(body); delete invalid.originalStored;
      expect(parseDocumentUploadResponse(invalid)).toBeNull();
      expect(() => assertUiContract("DocumentUploadResponse", invalid)).toThrow();
    } finally { run.mockRestore(); preview.mockRestore(); }
  });

  // This is a real filesystem route roundtrip with seven serialized durable
  // operations. Keep its deadline local to this test so runner I/O contention
  // cannot leave an operation writing after suite cleanup.
  it("roundtrips v1 to v2, preserves readable v1, restores it and rejects a stale base", async () => {
    const documentId = "0198b9f0-6631-7000-8000-000000000521";
    const versionTwoId = "0198b9f0-6631-7000-8000-000000000522";
    const staleAttemptId = "0198b9f0-6631-7000-8000-000000000523";
    const restoreId = "0198b9f0-6631-7000-8000-000000000524";
    const [uploadRoute, historyRoute, contentRoute, restoreRoute] = await Promise.all([
      import("@/app/api/threads/[threadId]/documents/route"),
      import("@/app/api/threads/[threadId]/documents/[uploadId]/route"),
      import("@/app/api/threads/[threadId]/documents/[uploadId]/versions/[versionId]/route"),
      import("@/app/api/threads/[threadId]/documents/[uploadId]/versions/[versionId]/restore/route"),
    ]);
    auth.session = session(USER_A);
    expect((await uploadRoute.POST(
      uploadRequest(documentId, new File(["version one"], "roundtrip.txt", { type: "text/plain" })),
      { params: Promise.resolve({ threadId }) },
    )).status).toBe(201);

    const initial = await historyRoute.GET(new Request("http://localhost/history"), {
      params: Promise.resolve({ threadId, uploadId: documentId }),
    });
    expect(initial.status).toBe(200);
    const initialBody = await initial.json() as { document: {
      scope: { kind: string; id: string };
      originalVersionId: string;
      versions: Array<{ versionId: string; etag: string; author: { userId: string; name: string }; createdAt: string; provenance: { type: string } }>;
    } };
    expect(initialBody.document.versions).toHaveLength(1);
    expect(initialBody.document).toMatchObject({
      originalVersionId: documentId,
      scope: { kind: "project" },
      versions: [{
        author: { userId: USER_A, name: expect.any(String) },
        createdAt: expect.any(String),
        provenance: { type: "original_upload" },
      }],
    });
    const v1Etag = initialBody.document.versions[0]!.etag;
    expect(initial.headers.get("ETag")).toBe(`"${v1Etag}"`);

    const missingBase = uploadRequest(
      "0198b9f0-6631-7000-8000-000000000525",
      new File(["missing base"], "roundtrip.txt", { type: "text/plain" }),
    );
    missingBase.headers.set("X-AiBrain-Document-Id", documentId);
    expect((await uploadRoute.POST(missingBase, { params: Promise.resolve({ threadId }) })).status).toBe(428);

    const v2Request = uploadRequest(versionTwoId, new File(["version two"], "roundtrip.txt", { type: "text/plain" }));
    v2Request.headers.set("If-Match", `"${v1Etag}"`);
    v2Request.headers.set("X-AiBrain-Document-Id", documentId);
    const v2Response = await uploadRoute.POST(v2Request, { params: Promise.resolve({ threadId }) });
    expect(v2Response.status).toBe(201);
    const v2Body = await v2Response.json() as { document: { versions: Array<{ versionId: string; etag: string }> } };
    expect(v2Body.document.versions.map((version) => version.versionId)).toEqual([documentId, versionTwoId]);
    const v2Etag = v2Body.document.versions[1]!.etag;

    const original = await contentRoute.GET(new Request("http://localhost/original"), {
      params: Promise.resolve({ threadId, uploadId: documentId, versionId: documentId }),
    });
    expect(original.status).toBe(200);
    expect(original.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await original.text()).toBe("version one");

    const staleRequest = uploadRequest(staleAttemptId, new File(["stale"], "roundtrip.txt", { type: "text/plain" }));
    staleRequest.headers.set("If-Match", `"${v1Etag}"`);
    staleRequest.headers.set("X-AiBrain-Document-Id", documentId);
    const conflict = await uploadRoute.POST(staleRequest, { params: Promise.resolve({ threadId }) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "DOCUMENT_VERSION_CONFLICT" });

    const restore = await restoreRoute.POST(new Request("http://localhost/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": `"${v2Etag}"` },
      body: JSON.stringify({ restoreVersionId: restoreId }),
    }), { params: Promise.resolve({ threadId, uploadId: documentId, versionId: documentId }) });
    expect(restore.status).toBe(201);
    const restored = await restore.json() as { document: { latestVersionId: string; versions: Array<{ provenance: { type: string } }> } };
    expect(restored.document.latestVersionId).toBe(restoreId);
    expect(restored.document.versions.at(-1)?.provenance.type).toBe("restore");

    auth.session = session(USER_B);
    expect((await historyRoute.GET(new Request("http://localhost/history"), {
      params: Promise.resolve({ threadId, uploadId: documentId }),
    })).status).toBe(404);

    auth.session = { ...session(USER_A), tenant: { id: "other-tenant", name: "Other Tenant" } };
    expect((await historyRoute.GET(new Request("http://localhost/history"), {
      params: Promise.resolve({ threadId, uploadId: documentId }),
    })).status).toBe(403);
  }, 15_000);

  it("returns retry metadata before starting a conversion when shared capacity is saturated", async () => {
    const previousMaximum = process.env.AIBRAIN_DOCUMENT_MAX_CONVERSIONS;
    const previousRetry = process.env.AIBRAIN_DOCUMENT_RETRY_AFTER_MS;
    process.env.AIBRAIN_DOCUMENT_MAX_CONVERSIONS = "1";
    process.env.AIBRAIN_DOCUMENT_RETRY_AFTER_MS = "2500";
    const { FileDocumentConversionGate } = await import("@/documents/conversion-gate");
    const gate = new FileDocumentConversionGate({
      rootDirectory: path.join(dataRoot, "locks", "document-conversions"),
      maxConcurrent: 1,
    });
    let release!: () => void;
    let admitted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { admitted = resolve; });
    const active = gate.run(async () => {
      admitted();
      await held;
    });
    await started;
    try {
      const uploadRoute = await import("@/app/api/threads/[threadId]/documents/route");
      auth.session = session(USER_A);
      const response = await uploadRoute.POST(
        uploadRequest(
          "0198b9f0-6631-7000-8000-000000000513",
          new File(["%PDF-1.7\n%%EOF\n"], "queued.pdf", { type: "application/pdf" }),
        ),
        { params: Promise.resolve({ threadId }) },
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("3");
      expect(await response.json()).toEqual({
        error: "La conversió de documents està ocupada. Torna-ho a provar.",
        code: "DOCUMENT_CONVERSION_BACKPRESSURE",
      });
    } finally {
      release();
      await active;
      if (previousMaximum === undefined) delete process.env.AIBRAIN_DOCUMENT_MAX_CONVERSIONS;
      else process.env.AIBRAIN_DOCUMENT_MAX_CONVERSIONS = previousMaximum;
      if (previousRetry === undefined) delete process.env.AIBRAIN_DOCUMENT_RETRY_AFTER_MS;
      else process.env.AIBRAIN_DOCUMENT_RETRY_AFTER_MS = previousRetry;
    }
  });

  it("rejects a saturated storage slot before persisting the multipart body", async () => {
    const previousMaximum = process.env.AIBRAIN_DOCUMENT_MAX_ACTIVE_UPLOADS;
    const previousRetry = process.env.AIBRAIN_DOCUMENT_STORAGE_RETRY_AFTER_MS;
    process.env.AIBRAIN_DOCUMENT_MAX_ACTIVE_UPLOADS = "1";
    process.env.AIBRAIN_DOCUMENT_STORAGE_RETRY_AFTER_MS = "4200";
    const { FileDocumentStorageGate } = await import("@/documents/storage-gate");
    const gate = new FileDocumentStorageGate({
      rootDirectory: path.join(dataRoot, "locks", "document-storage"), capacityDirectories: [dataRoot],
      maxActiveUploads: 1,
    });
    let release!: () => void;
    let admitted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { admitted = resolve; });
    const active = gate.run(async () => {
      admitted();
      await held;
    });
    await started;
    try {
      const uploadRoute = await import("@/app/api/threads/[threadId]/documents/route");
      auth.session = session(USER_A);
      const response = await uploadRoute.POST(
        uploadRequest(
          "0198b9f0-6631-7000-8000-000000000514",
          new File(["must not persist"], "blocked.txt", { type: "text/plain" }),
        ),
        { params: Promise.resolve({ threadId }) },
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("5");
      expect(await response.json()).toEqual({
        error: "Hi ha altres documents carregant-se. Torna-ho a provar d’aquí a uns segons.",
        code: "DOCUMENT_STORAGE_BACKPRESSURE", reason: "busy",
      });
      const blockedUpload = path.join(
        dataRoot,
        "users",
        USER_A,
        "staging",
        "threads",
        threadId,
        "uploads",
        "0198b9f0-6631-7000-8000-000000000514",
      );
      await expect(import("node:fs/promises").then(({ lstat }) => lstat(blockedUpload)))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
      await active;
      if (previousMaximum === undefined) delete process.env.AIBRAIN_DOCUMENT_MAX_ACTIVE_UPLOADS;
      else process.env.AIBRAIN_DOCUMENT_MAX_ACTIVE_UPLOADS = previousMaximum;
      if (previousRetry === undefined) delete process.env.AIBRAIN_DOCUMENT_STORAGE_RETRY_AFTER_MS;
      else process.env.AIBRAIN_DOCUMENT_STORAGE_RETRY_AFTER_MS = previousRetry;
    }
  });



  it("rejects a second malformed legacy workbook before staging it", async () => {
    const uploadRoute = await import("@/app/api/threads/[threadId]/documents/route");
    const data = await readFile(path.resolve("tests/infra/fixtures/knowledge-legacy.xls"));
    const bof = data.indexOf(Buffer.from("0908100000060500", "hex"));
    expect(bof).toBeGreaterThan(0);
    data.writeUInt16LE(0x01b8, bof + 20); // Synthetic HLINK; never a customer file.
    auth.session = session(USER_A);
    const response = await uploadRoute.POST(
      uploadRequest("0198b9f0-6631-7000-8000-000000000956", new File([new Uint8Array(data)], "unsafe.xls", { type: "application/octet-stream" })),
      { params: Promise.resolve({ threadId }) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "El document no supera la validació de seguretat.",
    });
    const [{ loadInstallationConfig }, { documentServicesForUser }] = await Promise.all([
      import("@/config/installation"), import("@/documents/server-service"),
    ]);
    const services = await documentServicesForUser(await loadInstallationConfig(), USER_A);
    await expect(services.staging.readById(threadId, "0198b9f0-6631-7000-8000-000000000956")).rejects.toThrow();
  });
});
