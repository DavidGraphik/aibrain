import { beforeEach, describe, expect, it, vi } from "vitest";

const projectId = "00000000-0000-4000-8000-000000000011";
const mocks = vi.hoisted(() => ({
  session: {
    current: {
      provider: "local",
      tenant: { id: "qa-company", name: "QA" },
      user: { id: "00000000-0000-4000-8000-000000000001", name: "Arnau", email: "arnau@example.test" },
    } as { provider: "local"; tenant: { id: string; name: string }; user: { id: string; name: string; email: string } } | null,
  },
  readRegularFileWithin: vi.fn(),
  prepareWorkspaceDocumentPreview: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: async () => mocks.session.current }));
vi.mock("@/config/installation", () => ({
  loadInstallationConfig: async () => ({ installationId: "qa-company" }),
}));
vi.mock("@/workbench/store", () => ({
  getProjectRuntimeContext: async (session: { user: { id: string } }) => {
    if (session.user.id !== "00000000-0000-4000-8000-000000000001") throw new Error("Not found");
    return { projectId };
  },
}));
vi.mock("@/workbench/shared-access", () => ({
  resolveProjectAccess: async () => ({
    role: "owner",
    project: { id: projectId },
  }),
}));
vi.mock("@/runtime/workers/provisioner", () => ({
  deriveWorkerRoots: () => ({ workspace: "/private/workspaces" }),
  resolveWorkerOwnedPath: async () => "/private/workspaces/projects/00000000-0000-4000-8000-000000000011",
}));
vi.mock("@/security/safe-file", () => ({
  readRegularFileWithin: mocks.readRegularFileWithin,
}));
vi.mock("@/documents/server-service", () => ({ documentServicesForUser: async () => ({ conversionGate: { run: (operation: () => Promise<unknown>) => operation() } }) }));
vi.mock("@/documents/workspace-preview", () => ({
  prepareWorkspaceDocumentPreview: mocks.prepareWorkspaceDocumentPreview,
}));

import { GET } from "@/app/api/projects/[projectId]/files/route";
import { DocumentConversionBackpressureError } from "@/documents/conversion-gate";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import { StorageError } from "@/storage";

function request(filePath: string, raw = false, download = false, representation = false) {
  return new Request(`https://brain.example/api/projects/${projectId}/files?path=${encodeURIComponent(filePath)}${raw ? "&raw=1" : ""}${download ? "&download=1" : ""}${representation ? "&representation=1" : ""}`);
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function officeZip(part: string) {
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: part, data: Buffer.from("<root/>") },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc32(entry.data), 14); local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(entry.data.length, 20); central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data); centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("workspace file preview route", () => {
  beforeEach(() => {
    mocks.session.current = {
      provider: "local",
      tenant: { id: "qa-company", name: "QA" },
      user: { id: "00000000-0000-4000-8000-000000000001", name: "Arnau", email: "arnau@example.test" },
    };
    mocks.readRegularFileWithin.mockReset();
    mocks.readRegularFileWithin.mockResolvedValue(Buffer.from("export const ready = true;"));
    mocks.prepareWorkspaceDocumentPreview.mockReset();
    mocks.prepareWorkspaceDocumentPreview.mockResolvedValue({ data: Buffer.from("%PDF-1.7\nconverted"), pages: 1 });
  });

  it("returns the current authenticated workspace file as bounded text", async () => {
    const response = await GET(request("src/example.ts"), { params: Promise.resolve({ projectId }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      file: {
        path: "src/example.ts",
        name: "example.ts",
        kind: "text",
        mimeType: "text/plain",
        size: 26,
        language: "TypeScript",
        content: "export const ready = true;",
        previewUrl: null,
        previewMimeType: "text/plain",
        downloadUrl: `/api/projects/${projectId}/files?path=src%2Fexample.ts&raw=1&download=1`,
      },
    });
    expect(mocks.readRegularFileWithin).toHaveBeenCalledWith(
      "/private/workspaces/projects/00000000-0000-4000-8000-000000000011",
      "src/example.ts",
      8_000_000,
    );
  });

  it("accepts Codex absolute paths only through the same confined workspace boundary", async () => {
    const absolutePath = "/private/workspaces/projects/00000000-0000-4000-8000-000000000011/src/example.ts";
    const response = await GET(request(absolutePath), { params: Promise.resolve({ projectId }) });

    expect(response.status).toBe(200);
    expect(mocks.readRegularFileWithin).toHaveBeenCalledWith(
      "/private/workspaces/projects/00000000-0000-4000-8000-000000000011",
      "src/example.ts",
      8_000_000,
    );
  });

  it("serves images inline and keeps unauthenticated reads closed", async () => {
    mocks.readRegularFileWithin.mockResolvedValueOnce(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = await GET(request("public/preview.png", true), { params: Promise.resolve({ projectId }) });
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("Cache-Control")).toBe("private, no-store");
    expect(image.headers.get("Content-Disposition")).toContain("inline");

    mocks.readRegularFileWithin.mockResolvedValueOnce(Buffer.from("%PDF-1.7\nfixture"));
    const pdfDownload = await GET(request("informes/informe.pdf", true, true), { params: Promise.resolve({ projectId }) });
    expect(pdfDownload.status).toBe(200);
    expect(pdfDownload.headers.get("Content-Disposition")).toContain("attachment");
    expect(pdfDownload.headers.get("Content-Type")).toBe("application/pdf");
    expect(mocks.readRegularFileWithin).toHaveBeenLastCalledWith(
      "/private/workspaces/projects/00000000-0000-4000-8000-000000000011",
      "informes/informe.pdf",
      50 * 1024 * 1024,
    );

    mocks.session.current = null;
    const unauthenticated = await GET(request("src/example.ts"), { params: Promise.resolve({ projectId }) });
    expect(unauthenticated.status).toBe(401);
  });

  it("serves a valid PDF only through private, non-sniffable response headers", async () => {
    mocks.readRegularFileWithin.mockResolvedValueOnce(Buffer.from("%PDF-1.7\\n%%EOF\\n"));

    const response = await GET(request("informes/informe.pdf", true), { params: Promise.resolve({ projectId }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Disposition")).toContain("inline");

    mocks.readRegularFileWithin.mockResolvedValueOnce(Buffer.from("not a pdf"));
    const malformed = await GET(request("informes/informe.pdf", true), { params: Promise.resolve({ projectId }) });
    expect(malformed.status).toBe(415);
  });

  it("repairs the private legacy PDF preview while downloading the exact original", async () => {
    const original = Buffer.from("%PDF-1.4\nlegacy source without xref\n%%EOF\n");
    mocks.readRegularFileWithin.mockResolvedValue(original);
    const preview = await GET(request("hello-world.pdf", true), { params: Promise.resolve({ projectId }) });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe("%PDF-1.7\nconverted");
    expect(mocks.prepareWorkspaceDocumentPreview).toHaveBeenCalledWith(expect.objectContaining({ data: original, relativePath: "hello-world.pdf" }));
    mocks.prepareWorkspaceDocumentPreview.mockClear();
    const download = await GET(request("hello-world.pdf", true, true), { params: Promise.resolve({ projectId }) });
    expect(Buffer.from(await download.arrayBuffer()).equals(original)).toBe(true);
    expect(mocks.prepareWorkspaceDocumentPreview).not.toHaveBeenCalled();
  });

  it("validates Office files and serves a converted private PDF representation instead of binary text", async () => {
    const docx = officeZip("word/document.xml");
    mocks.readRegularFileWithin.mockResolvedValue(docx);
    const metadata = await GET(request("documents/brief.docx"), { params: Promise.resolve({ projectId }) });
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      file: {
        kind: "office",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        previewMimeType: "application/pdf",
        previewUrl: `/api/projects/${projectId}/files?path=documents%2Fbrief.docx&representation=1`,
      },
    });

    const preview = await GET(request("documents/brief.docx", false, false, true), {
      params: Promise.resolve({ projectId }),
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Content-Type")).toBe("application/pdf");
    expect(preview.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await preview.text()).toContain("%PDF-1.7");
    expect(mocks.prepareWorkspaceDocumentPreview).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      relativePath: "documents/brief.docx",
      fileName: "brief.docx",
    }));

    mocks.readRegularFileWithin.mockResolvedValue(Buffer.from("fake office"));
    const fake = await GET(request("documents/fake.docx"), { params: Promise.resolve({ projectId }) });
    expect(fake.status).toBe(415);
  });

  it.each([
    {
      error: new StorageError("DOCUMENT_TOOL_TIMEOUT", "timeout"),
      status: 504,
      state: "failed",
    },
    {
      error: new StorageError("DOCUMENT_OPERATION_ABORTED", "aborted"),
      status: 408,
      state: "cancelled",
    },
    {
      error: new StorageError("DOCUMENT_TOOL_FAILED", "failed"),
      status: 422,
      state: "failed",
    },
    {
      error: new DocumentConversionBackpressureError(1_500),
      status: 503,
      state: "retryable",
    },
  ])("returns a private terminal preview state for conversion error $status", async ({ error, status, state }) => {
    mocks.readRegularFileWithin.mockResolvedValue(officeZip("word/document.xml"));
    mocks.prepareWorkspaceDocumentPreview.mockRejectedValue(error);

    const response = await GET(request("documents/brief.docx", false, false, true), {
      params: Promise.resolve({ projectId }),
    });

    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ state });
    if (status === 503) expect(response.headers.get("Retry-After")).toBe("2");
  });

  it("downloads generated PDF, DOCX, PPTX and XLSX bytes and exposes authenticated previews", async () => {
    for (const format of ["pdf", "docx", "pptx", "xlsx"] as const) {
      const generated = await generateLocalDocument({
        format,
        title: `Resultado ${format}`,
        content: format === "xlsx" ? "Nombre\tImporte\nServicio\t1250" : "Contenido verificable",
      });
      mocks.readRegularFileWithin.mockResolvedValue(generated.data);
      const filePath = `documents/resultado.${format}`;
      const download = await GET(request(filePath, true, true), { params: Promise.resolve({ projectId }) });
      expect(download.status).toBe(200);
      expect(download.headers.get("Content-Type")).toBe(generated.mimeType);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(generated.data);

      const preview = await GET(request(filePath, format === "pdf", false, format !== "pdf"), {
        params: Promise.resolve({ projectId }),
      });
      expect(preview.status).toBe(200);
      expect(preview.headers.get("Cache-Control")).toBe("private, no-store");
      expect(preview.headers.get("Content-Type")).toBe("application/pdf");
      expect(Buffer.from(await preview.arrayBuffer()).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    }
  });

  it("routes an XLSX workspace file to its private cell grid", async () => {
    const generated = await generateLocalDocument({ format: "xlsx", title: "Full", content: "Nom\tTotal\nProva\t24" });
    mocks.readRegularFileWithin.mockResolvedValue(generated.data);
    const metadata = await GET(request("documents/full.xlsx"), { params: Promise.resolve({ projectId }) });
    expect(await metadata.json()).toMatchObject({ file: {
      previewMimeType: "application/pdf",
      previewUrl: `/api/projects/${projectId}/files?path=documents%2Ffull.xlsx&representation=1`,
    } });
    const grid = await GET(new Request(`https://brain.example/api/projects/${projectId}/files?path=documents%2Ffull.xlsx&grid=1`),
      { params: Promise.resolve({ projectId }) });
    expect(grid.status).toBe(200);
    expect((await grid.json()).sheets[0].cells).toContainEqual({ address: "B2", value: "24" });
  });

  it("rejects malformed queries before reading the workspace", async () => {
    const response = await GET(
      new Request(`https://brain.example/api/projects/${projectId}/files?path=src%2Fa.ts&path=src%2Fb.ts`),
      { params: Promise.resolve({ projectId }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.readRegularFileWithin).not.toHaveBeenCalled();
  });

  it("rejects a cross-tenant session before resolving any workspace path", async () => {
    mocks.session.current = {
      provider: "local",
      tenant: { id: "other-company", name: "Other" },
      user: { id: "00000000-0000-4000-8000-000000000001", name: "Arnau", email: "arnau@example.test" },
    };
    const response = await GET(request("src/example.ts"), { params: Promise.resolve({ projectId }) });
    expect(response.status).toBe(403);
    expect(mocks.readRegularFileWithin).not.toHaveBeenCalled();
  });

  it("returns not found for another employee in the same tenant", async () => {
    mocks.session.current = {
      provider: "local",
      tenant: { id: "qa-company", name: "QA" },
      user: { id: "00000000-0000-4000-8000-000000000002", name: "David", email: "david@example.test" },
    };
    const response = await GET(request("documents/resultado.pdf", true, true), { params: Promise.resolve({ projectId }) });
    expect(response.status).toBe(404);
    expect(mocks.readRegularFileWithin).not.toHaveBeenCalled();
  });
});
