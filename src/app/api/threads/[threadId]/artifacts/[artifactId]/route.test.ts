import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const THREAD = "00000000-0000-4000-8000-000000000013";
const ARTIFACT = "00000000-0000-4000-8000-000000000014";
const OWNER = "00000000-0000-4000-8000-000000000015";
const mocks = vi.hoisted(() => ({
  session: { provider: "local", tenant: { id: "document-test", name: "Test" }, user: { id: "00000000-0000-4000-8000-000000000015", name: "Owner", email: "owner@example.test" } },
  resolve: vi.fn(),
  read: vi.fn(),
  services: vi.fn(),
  preview: vi.fn(),
  page: vi.fn(),
  grid: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: async () => mocks.session }));
vi.mock("@/library/server-resource-access", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/library/server-resource-access")>(),
  resolveGeneratedDocumentResource: mocks.resolve,
}));
vi.mock("@/security/safe-file", () => ({ readRegularFileWithin: mocks.read }));
vi.mock("@/documents/server-service", () => ({ documentServicesForUser: mocks.services }));
vi.mock("@/documents/workspace-preview", () => ({
  prepareWorkspaceDocumentPreview: mocks.preview,
  prepareWorkspaceDocumentPage: mocks.page,
}));
vi.mock("@/documents/workbook-grid", () => ({ prepareWorkbookGrid: mocks.grid }));

import { GET } from "./route";

const contents = Buffer.from("%PDF-1.7\nimmutable artifact\n%%EOF");
const location = {
  projectId: "00000000-0000-4000-8000-000000000011",
  threadId: THREAD,
  storageOwnerId: OWNER,
  relativePath: `generated-document-artifacts/${OWNER}/${ARTIFACT}/report.pdf`,
  fileName: "report.pdf",
  mediaType: "application/pdf",
  size: contents.length,
  sha256: "d3f77a636c41ba720a7f4c169565929e8ad0c11cf70420faaa60de641f8cf8af",
};

function request(query: string) {
  return new Request(`https://brain.example/api/threads/${THREAD}/artifacts/${ARTIFACT}${query}`);
}

describe("generated document artifact route", () => {
  beforeEach(() => {
    location.sha256 = createHash("sha256").update(contents).digest("hex");
    mocks.resolve.mockReset().mockResolvedValue({ installation: { paths: { dataRoot: "/private/data" } }, location });
    mocks.read.mockReset().mockResolvedValue(contents);
    mocks.services.mockReset().mockResolvedValue({ conversionGate: { run: (operation: () => Promise<unknown>) => operation() } });
    mocks.preview.mockReset().mockResolvedValue({ data: Buffer.from("%PDF-1.7\npreview"), pages: 3 });
    mocks.page.mockReset().mockResolvedValue({ data: Buffer.from("89504e470d0a1a0a00", "hex"), pages: 3 });
    mocks.grid.mockReset().mockResolvedValue({ schemaVersion: 1, kind: "spreadsheet", truncated: false, sheets: [{ name: "Full", hidden: false, cells: [{ address: "AN2", value: "Valor 40" }] }] });
  });

  it("serves the immutable original and binds resolution to the URL thread", async () => {
    const response = await GET(request("?download=1"), { params: Promise.resolve({ threadId: THREAD, artifactId: ARTIFACT }) });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(contents);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(mocks.resolve).toHaveBeenCalledWith(mocks.session, { artifactId: ARTIFACT, threadId: THREAD });
    expect(mocks.read).toHaveBeenCalledWith("/private/data", location.relativePath, 50 * 1024 * 1024);
  });

  it("returns PDF and paged PNG representations without exposing a host path", async () => {
    const pdf = await GET(request("?preview=1"), { params: Promise.resolve({ threadId: THREAD, artifactId: ARTIFACT }) });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({
      projectId: location.projectId,
      relativePath: location.relativePath,
      fileName: "report.pdf",
      data: contents,
    }));
    const page = await GET(request("?preview=1&page=2"), { params: Promise.resolve({ threadId: THREAD, artifactId: ARTIFACT }) });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("image/png");
    expect(page.headers.get("x-document-page-count")).toBe("3");
    expect(mocks.page).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
  });

  it("fails closed before conversion when the durable hash changes", async () => {
    mocks.read.mockResolvedValue(Buffer.from("substituted"));
    const response = await GET(request("?preview=1"), { params: Promise.resolve({ threadId: THREAD, artifactId: ARTIFACT }) });
    expect(response.status).toBe(409);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("does not accept ambiguous modes or a foreign conversation binding", async () => {
    const invalid = await GET(request("?preview=1&download=1"), { params: Promise.resolve({ threadId: THREAD, artifactId: ARTIFACT }) });
    expect(invalid.status).toBe(400);
    mocks.resolve.mockRejectedValue(new Error("foreign thread"));
    const foreign = await GET(request("?download=1"), { params: Promise.resolve({ threadId: THREAD, artifactId: ARTIFACT }) });
    expect(foreign.status).toBe(404);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("serves the authenticated grid from the verified XLSX bytes", async () => {
    location.fileName = "report.xlsx";
    location.relativePath = `generated-document-artifacts/${OWNER}/${ARTIFACT}/report.xlsx`;
    location.mediaType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const response = await GET(request("?grid=1"), { params: Promise.resolve({ threadId: THREAD, artifactId: ARTIFACT }) });
    expect(response.status).toBe(200);
    expect((await response.json()).sheets[0].cells[0]).toEqual({ address: "AN2", value: "Valor 40" });
    expect(mocks.grid).toHaveBeenCalledWith(expect.objectContaining({ fileName: "report.xlsx", data: contents }));
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
