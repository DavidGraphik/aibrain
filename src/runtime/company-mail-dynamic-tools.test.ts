import { describe, expect, it, vi } from "vitest";
import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import type { CompanyMailToolContext } from "./company-mail-dynamic-tools";
import { COMPANY_MAIL_NAMESPACE, handleCompanyMailTool } from "./company-mail-dynamic-tools";

vi.mock("server-only", () => ({}));
vi.mock("@/connectors/company-mail-server-service", () => ({ companyMailContext: vi.fn(async () => undefined), companyMailAccessForIdentity: vi.fn(async () => { throw new Error("credential boundary reached"); }) }));
vi.mock("@/workbench/store", () => ({ getWritableProject: vi.fn(async () => ({ status: "active" })) }));
import { companyMailAccessForIdentity, companyMailContext } from "@/connectors/company-mail-server-service";
import { getWritableProject } from "@/workbench/store";
import { DocumentStorageBackpressureError, DocumentStorageFullError } from "@/documents/storage-gate";
const c = {
  config: { installationId: "company-qa" }, session: { provider: "local", tenant: { id: "company-qa" }, user: { id: "00000000-0000-4000-8000-000000000001" } },
  installationId: "company-qa", userId: "00000000-0000-4000-8000-000000000001", runtimeThreadId: "runtime-thread", runtimeTurnId: "runtime-turn",
  selected: true, executeAllowed: true, allowLocalWrites: true, projectId: "10000000-0000-4000-8000-000000000001", threadId: "local-thread", messageId: "local-message",
  projectWorkspace: "/private/project", readInvoiceIds: new Set<string>(), emitArtifact: vi.fn(),
} as unknown as CompanyMailToolContext;
const params = { namespace: COMPANY_MAIL_NAMESPACE, tool: "import_attachments", arguments: {}, threadId: "runtime-thread", turnId: "runtime-turn" } as DynamicToolCallParams;

describe("company mailbox runtime authorization", () => {
  it("reports storage admission separately from mailbox/provider failure without exposing paths", async () => {
    vi.clearAllMocks();
    vi.mocked(companyMailAccessForIdentity).mockRejectedValueOnce(new DocumentStorageBackpressureError(5_000));
    const response = await handleCompanyMailTool(params, c);
    expect(response.success).toBe(false);
    const value = JSON.parse((response.contentItems[0] as { text: string }).text);
    expect(value).toMatchObject({ code: "DOCUMENT_STORAGE_BACKPRESSURE", retryable: true, retryAfterMs: 5_000 });
    expect(value.error).toContain("otros documentos");
    expect(value.error).not.toContain("/var/");
  });
  it("reports a physical full-disk error without claiming invoice completion", async () => {
    vi.clearAllMocks();
    vi.mocked(companyMailAccessForIdentity).mockRejectedValueOnce(new DocumentStorageFullError(Object.assign(new Error("synthetic"), { code: "ENOSPC" })));
    const response = await handleCompanyMailTool(params, c);
    expect(response.success).toBe(false);
    const value = JSON.parse((response.contentItems[0] as { text: string }).text);
    expect(value).toMatchObject({ code: "DOCUMENT_STORAGE_FULL" });
    expect(value.error).toContain("no se ha completado");
  });
  it.each([
    { selected: false }, { session: null }, { executeAllowed: false }, { allowLocalWrites: false }, { installationId: "foreign" }, { userId: "foreign" },
  ])("rejects unauthorized runtime contexts before reaching credentials (%j)", async override => {
    vi.clearAllMocks();
    expect((await handleCompanyMailTool(params, { ...c, ...override })).success).toBe(false);
    expect(companyMailContext).not.toHaveBeenCalled(); expect(companyMailAccessForIdentity).not.toHaveBeenCalled();
  });
  it.each([{ threadId: "foreign" }, { turnId: "foreign" }, { arguments: { projectId: "foreign" } }, { tool: "send" }])("rejects foreign turns and model-supplied authority (%j)", async override => {
    vi.clearAllMocks();
    expect((await handleCompanyMailTool({ ...params, ...override } as DynamicToolCallParams, c)).success).toBe(false);
    expect(companyMailAccessForIdentity).not.toHaveBeenCalled();
  });
  it("revalidates catalog and project permission before accessing the mailbox", async () => {
    vi.clearAllMocks();
    vi.mocked(getWritableProject).mockRejectedValueOnce(new Error("viewer cannot write"));
    expect((await handleCompanyMailTool(params, c)).success).toBe(false);
    expect(companyMailContext).toHaveBeenCalledWith(c.session);
    expect(getWritableProject).toHaveBeenCalledWith(c.session, c.projectId);
    expect(companyMailAccessForIdentity).not.toHaveBeenCalled();
    expect((await handleCompanyMailTool(params, c)).success).toBe(false);
    expect(companyMailAccessForIdentity).toHaveBeenCalledWith(c.config, c.userId);
  });
});
