import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import { verifyTranslatedDocx } from "@/runtime/documents/translation-progress";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPermissions } from "@/permissions";
import { persistGeneratedImageArtifact } from "@/runtime/generated-image-artifacts";
import {
  AIBRAIN_DOCUMENT_TOOL_NAMESPACE,
  DOCUMENT_DYNAMIC_TOOLS,
  handleLocalDocumentDynamicToolCall,
  type LocalDocumentDynamicToolContext,
} from "@/runtime/documents/dynamic-tools";
import { generatedPngFixture } from "../../../tests/helpers/png-fixture";
import template from "./templates/arnall-schedule.json";
import { createAttachmentReviewer } from "./attachment-review";
import type { ResolvedTurnDocument } from "@/documents/turn-attachments";
import type { DocumentPreview } from "@/documents/preview-service";

vi.mock("server-only", () => ({}));

const INSTALLATION_ID = "documents-qa";
const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "10000000-0000-4000-8000-000000000002";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const THREAD_ID = "30000000-0000-4000-8000-000000000002";
const MESSAGE_ID = "30000000-0000-4000-8000-000000000001";
const PREVIOUS_MESSAGE_ID = "30000000-0000-4000-8000-000000000003";
const OTHER_THREAD_ID = "30000000-0000-4000-8000-000000000004";
const roots: string[] = [];

describe("read-only original attachment inspection", () => {
  it("can deliver 64 separately authored synthetic pages in one translation turn", async () => {
    const c=await context(USER_A);
    const source={document:{kind:"pdf",fileName:"long.pdf",threadId:THREAD_ID,uploadId:"40000000-0000-4000-8000-000000000001",sha256:"a".repeat(64)},codexInputs:[]} as unknown as ResolvedTurnDocument;
    const reviewer=()=>createAttachmentReviewer({documents:[source],translationRequested:true,previews:{read:async()=>({sourceSha256:"a".repeat(64),files:["document.pdf"],pages:64} as DocumentPreview),renderPage:async()=>generatedPngFixture()}});
    const ctx=(r:ReturnType<typeof reviewer>)=>({...c,inspectAttachment:r,translationSource:(n:string)=>r.translationSource(n),translationInspection:(n:string,p:number)=>r.translationInspection(n,p),translationNotice:(s:{uploadId:string;completedPages:number;totalPages:number;delivered:boolean})=>r.translationNotice(s),assertAttachmentReviewComplete:()=>r.assertComplete(),permissions:{...c.permissions,rules:[...c.permissions.rules,{...c.permissions.rules[0]!,ruleId:"documents.read",action:"consult" as const}]}});
    const call=(tool:string,args:Record<string,string|number>,id:string)=>({...request(id,"pdf"),tool,arguments:args});
    const base={fileName:"long.pdf",targetLanguage:"Catalan"};const current=ctx(reviewer());const authored:string[]=[];
    expect((await handleLocalDocumentDynamicToolCall(call("translation_status",base,"start"),current)).response.success).toBe(true);
    for(let page=1;page<=64;page++) {
      const translation=Array.from({length:85},(_,line)=>`P${page} L${line} `+createHash("sha256").update(`${page}:${line}`).digest("hex")).join("\n");
      authored.push(`[Página ${page}]\n${translation}`);
      expect((await handleLocalDocumentDynamicToolCall(call("inspect_attachment",{fileName:base.fileName,page},`inspect-${page}`),current)).response.success).toBe(true);
      expect((await handleLocalDocumentDynamicToolCall(call("translation_save_page",{...base,page,translation},`save-${page}`),current)).response.success).toBe(true);
    }
    const result=await handleLocalDocumentDynamicToolCall(call("translation_finish",{...base,outputFileName:"long.docx"},"finish-long"),current);
    expect(result.response.success).toBe(true);expect(result.artifacts).toHaveLength(1);
    const bytes=await readFile(path.join(c.installation.paths.dataRoot,"generated-document-artifacts",USER_A,result.artifacts[0].id,"long.docx"));
    const doc=await JSZip.loadAsync(bytes);const xml=await doc.file("word/document.xml")!.async("string");
    const expected=authored.join("\n\n");expect(Buffer.byteLength(expected)).toBeGreaterThan(200_000);expect(expected.split("\n").length).toBeGreaterThan(5_000);
    await expect(verifyTranslatedDocx(bytes,"Traducción: long.pdf",expected)).resolves.toBeUndefined();
    expect(validateUploadedDocument({fileName:"long.docx",declaredMimeType:result.artifacts[0].mimeType!,data:bytes}).kind).toBe("docx");
    for(let page=1;page<=64;page++)expect(xml).toContain(`[Página ${page}]`);
  },30000);
  it("resumes an original translation across turns, requiring inspection and all page texts before delivering exact Word content", async () => {
    const c=await context(USER_A);
    const source={document:{kind:"pdf",fileName:"source.pdf",threadId:THREAD_ID,uploadId:"40000000-0000-4000-8000-000000000001",sha256:"a".repeat(64)},codexInputs:[]} as unknown as ResolvedTurnDocument;
    const makeReviewer=()=>createAttachmentReviewer({documents:[source],previews:{read:async()=>({sourceSha256:"a".repeat(64),files:["document.pdf"],pages:2} as DocumentPreview),renderPage:async()=>generatedPngFixture()}});
    const makeContext=(review:ReturnType<typeof makeReviewer>)=>({...c,inspectAttachment:review,
      assertAttachmentReviewComplete:()=>review.assertComplete(),translationSource:(name:string)=>review.translationSource(name),
      translationInspection:(name:string,page:number)=>review.translationInspection(name,page),translationNotice:(status:{uploadId:string;completedPages:number;totalPages:number;delivered:boolean})=>review.translationNotice(status),
      permissions:{...c.permissions,rules:[...c.permissions.rules,{...c.permissions.rules[0]!,ruleId:"documents.read",action:"consult" as const}]}});
    const call=(tool:string,args:Record<string,string|number>,id:string)=>({...request(id,"pdf"),tool,arguments:args});
    const base={fileName:"source.pdf",targetLanguage:"català"};const first=makeReviewer();const a=makeContext(first);
    const save=(page:number,translation:string,id:string)=>call("translation_save_page",{...base,page,translation},id);
    const inspect=(page:number,id:string)=>call("inspect_attachment",{fileName:"source.pdf",page},id);
    expect((await handleLocalDocumentDynamicToolCall(save(1,"first text","no-inspect"),a)).response.success).toBe(false);
    expect((await handleLocalDocumentDynamicToolCall(inspect(1,"inspect-p1"),a)).response.success).toBe(true);
    expect((await handleLocalDocumentDynamicToolCall(save(1,"# literal heading\n- literal bullet","save-p1"),a)).response.success).toBe(true);
    expect((await handleLocalDocumentDynamicToolCall(call("translation_finish",{...base,outputFileName:"translated.docx"},"too-early"),a)).response.success).toBe(false);
    const second=makeReviewer();const b=makeContext(second);
    const status=await handleLocalDocumentDynamicToolCall(call("translation_status",base,"status"),b);
    expect(JSON.parse((status.response.contentItems[0] as {text:string}).text)).toMatchObject({coverage:{savedPages:[1],pendingPages:[2],complete:false}});
    expect((await handleLocalDocumentDynamicToolCall(request("generic-bypass","pdf"),b)).response.success).toBe(false);
    expect((await handleLocalDocumentDynamicToolCall(inspect(2,"inspect-p2"),b)).response.success).toBe(true);
    expect((await handleLocalDocumentDynamicToolCall(save(2,"end of page 2","save-p2"),b)).response.success).toBe(true);
    const done=await handleLocalDocumentDynamicToolCall(call("translation_finish",{...base,outputFileName:"translated.docx"},"finish"),b);
    expect(done.response.success).toBe(true);expect(done.artifacts).toHaveLength(1);
    const bytes=await readFile(path.join(c.installation.paths.dataRoot,"generated-document-artifacts",USER_A,done.artifacts[0].id,"translated.docx"));
    const doc=await JSZip.loadAsync(bytes);const xml=await doc.file("word/document.xml")!.async("string");
    expect(xml).toContain("# literal heading");expect(xml).toContain("- literal bullet");expect(xml).toContain("end of page 2");
    expect(second.finalText("Coverage complete")).toContain("precisión de la traducción");
    const third=makeReviewer();const later={...makeContext(third),sourceTurnId:"30000000-0000-4000-8000-000000000005"};
    const repeated=await handleLocalDocumentDynamicToolCall(call("translation_finish",{...base,outputFileName:"translated.docx"},"finish-again"),later);
    expect(repeated.response.success).toBe(true);expect(repeated.artifacts[0].id).toBe(done.artifacts[0].id);
  });
  it("blocks report creation without effects until every original page has been supplied, then allows the same call", async () => {
    const c = await context(USER_A);
    const inspectAttachment = createAttachmentReviewer({
      documents: [{ document: { kind: "pdf", fileName: "source.pdf", threadId: "source-thread", uploadId: "source-upload", sha256: "a".repeat(64) }, codexInputs: [] } as unknown as ResolvedTurnDocument],
      previews: { read: async () => ({ sourceSha256: "a".repeat(64), files: ["document.pdf"], pages: 3 } as DocumentPreview), renderPage: async () => generatedPngFixture() },
    });
    const ctx = { ...c, inspectAttachment,
      assertAttachmentReviewComplete: () => inspectAttachment.assertComplete(),
      permissions: { ...c.permissions, rules: [...c.permissions.rules, { ...c.permissions.rules[0]!, ruleId: "documents.read", action: "consult" as const }] },
    };
    const inspect = (page: number) => ({ ...request(`page-${page}`, "pdf"), tool: "inspect_attachment", arguments: { fileName: "source.pdf", page } });
    expect((await handleLocalDocumentDynamicToolCall(inspect(1), ctx)).response.success).toBe(true);
    const blocked = await handleLocalDocumentDynamicToolCall(request("review-report", "pdf"), ctx);
    expect(blocked.response.success).toBe(false);
    expect(blocked.artifacts).toEqual([]);
    expect(JSON.parse((blocked.response.contentItems[0] as { text: string }).text)).toMatchObject({ code: "ATTACHMENT_REVIEW_INCOMPLETE", coverage: { complete: false } });
    expect(await readdir(c.receiptRoot)).toEqual([]);
    for (const page of [2, 3]) expect((await handleLocalDocumentDynamicToolCall(inspect(page), ctx)).response.success).toBe(true);
    const completed = await handleLocalDocumentDynamicToolCall(request("review-report", "pdf"), ctx);
    expect(completed.response.success).toBe(true);
    expect(completed.artifacts).toHaveLength(1);
  });
  it("guards batch and delivery before publishing, but permits an explicitly partial report with coverage", async () => {
    const c = await context(USER_A);
    const make = (partial = false) => createAttachmentReviewer({ partial,
      documents: [{ document: { kind: "pdf", fileName: "source.pdf", threadId: "source-thread", uploadId: "source-upload", sha256: "a".repeat(64) }, codexInputs: [] } as unknown as ResolvedTurnDocument],
      previews: { read: async () => ({ sourceSha256: "a".repeat(64), files: ["document.pdf"], pages: 2 } as DocumentPreview), renderPage: async () => generatedPngFixture() },
    });
    const review = make(); await review("source.pdf", 1);
    const ctx = { ...c, assertAttachmentReviewComplete: () => review.assertComplete() };
    const batch = await handleLocalDocumentDynamicToolCall(batchRequest(), ctx);
    expect(batch.response.success).toBe(false); expect(batch.artifacts).toEqual([]);
    expect(await readdir(c.receiptRoot)).toEqual([]);
    const generated = await generateLocalDocument({ format: "pdf", title: "Partial source review", content: "Observed page only." });
    await mkdir(path.join(c.projectWorkspace, "documents"));
    await writeFile(path.join(c.projectWorkspace, "documents/authored.pdf"), generated.data);
    const delivery = await handleLocalDocumentDynamicToolCall({ ...request("deliver-review", "pdf"), tool: "deliver", arguments: { relativePath: "documents/authored.pdf" } }, ctx);
    expect(delivery.response.success).toBe(false); expect(delivery.artifacts).toEqual([]);
    const partial = make(true); await partial("source.pdf", 1);
    const result = await handleLocalDocumentDynamicToolCall(request("partial-review", "pdf"), { ...c,
      assertAttachmentReviewComplete: () => partial.assertComplete(), attachmentReviewCoverage: () => partial.coverage(), attachmentReviewNotice: () => partial.finalText(""),
    });
    expect(result.response.success).toBe(true);
    expect(JSON.parse((result.response.contentItems[0] as { text: string }).text)).toMatchObject({ attachmentReview: { scope: "partial", complete: false, documents: [{ suppliedPages: [1], pendingPages: [2] }] } });
    expect(partial.coverage()).toMatchObject({ scope: "partial", complete: false });
    const bytes = await readFile(path.join(c.projectWorkspace, "documents/resultado.pdf"));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
    expect(partial.finalText("Reviewed all original pages.")).toContain("Revisión parcial solicitada");
    const repeated = await handleLocalDocumentDynamicToolCall(request("partial-review", "pdf"), { ...c,
      assertAttachmentReviewComplete: () => partial.assertComplete(), attachmentReviewCoverage: () => partial.coverage(), attachmentReviewNotice: () => partial.finalText(""),
    });
    expect(repeated.response.success).toBe(true);
    expect(repeated.artifacts[0].id).toBe(result.artifacts[0].id);
  });

  const inspection = () => ({ ...request("inspect-original", "pdf"), tool:"inspect_attachment", arguments:{fileName:"original.pdf",page:5} });
  it("allows authorized attachment consultation without granting document creation or commands", async () => {
    const c=await context(USER_A);
    const inspectAttachment=vi.fn().mockResolvedValue({png:generatedPngFixture(),fileName:"original.pdf",page:5,pages:5,sourceSha256:"a".repeat(64)});
    const readOnly={...c,inspectAttachment,permissions:{...c.permissions,rules:[...permissions(USER_A,"deny").rules,{...c.permissions.rules[0]!,ruleId:"documents.read",action:"consult" as const,effect:"allow" as const}]}};
    const result=await handleLocalDocumentDynamicToolCall(inspection(),readOnly);
    expect(result.response.success).toBe(true);expect(result.artifacts).toEqual([]);
    expect(inspectAttachment).toHaveBeenCalledWith("original.pdf",5);
    expect(result.response.contentItems.some(i=>i.type==="inputImage")).toBe(true);
    expect((await handleLocalDocumentDynamicToolCall(request("no-create","pdf"),readOnly)).response.success).toBe(false);
  });
  it("accepts inspection of page 500 and rejects 501 before accessing the original", async () => {
    const c=await context(USER_A);
    const inspectAttachment=vi.fn().mockResolvedValue({png:generatedPngFixture(),fileName:"original.pdf",page:500,pages:500,sourceSha256:"a".repeat(64)});
    const permitted={...c,inspectAttachment,permissions:{...c.permissions,rules:[{...c.permissions.rules[0]!,ruleId:"documents.read",action:"consult" as const,effect:"allow" as const}]}};
    const high={...inspection(),arguments:{fileName:"original.pdf",page:500}};
    expect((await handleLocalDocumentDynamicToolCall(high,permitted)).response.success).toBe(true);
    expect(inspectAttachment).toHaveBeenCalledWith("original.pdf",500);
    expect((await handleLocalDocumentDynamicToolCall({...high,arguments:{fileName:"original.pdf",page:501}},permitted)).response.success).toBe(false);
    expect(inspectAttachment).toHaveBeenCalledTimes(1);
  });
  it("rejects explicit read denial, extra identity fields and foreign turn ownership before inspection", async () => {
    const c=await context(USER_A);const inspectAttachment=vi.fn();
    const rule={...c.permissions.rules[0]!,ruleId:"documents.read",action:"consult" as const,effect:"allow" as const};
    const permitted={...c,inspectAttachment,permissions:{...c.permissions,rules:[rule]}};
    const denied={...permitted,permissions:{...c.permissions,rules:[rule,{...rule,effect:"deny" as const}]}};
    expect((await handleLocalDocumentDynamicToolCall(inspection(),denied)).response.success).toBe(false);
    expect((await handleLocalDocumentDynamicToolCall({...inspection(),arguments:{...inspection().arguments,threadId:OTHER_THREAD_ID}},permitted)).response.success).toBe(false);
    expect((await handleLocalDocumentDynamicToolCall({...inspection(),threadId:"foreign-runtime"},permitted)).response.success).toBe(false);
    expect(inspectAttachment).not.toHaveBeenCalled();
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function permissions(userId: string, effect: "allow" | "deny" = "allow"): ResolvedPermissions {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    userId,
    roleId: null,
    projectId: PROJECT_ID,
    turnId: "30000000-0000-4000-8000-000000000001",
    resolvedAt: "2026-08-30T00:00:00.000Z",
    fingerprint: "a".repeat(64),
    sources: [],
    rules: [{
      ruleId: "tools.execute",
      action: "execute",
      effect,
      instruction: "Local tools",
      sourceScope: "installation",
      sourcePolicyVersion: 1,
      precedence: 100,
    }],
    developerInstructions: `Policy fingerprint: ${"a".repeat(64)}`,
  };
}

async function context(userId: string): Promise<LocalDocumentDynamicToolContext> {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-local-doc-tool-"));
  roots.push(root);
  const canonicalRoot = await realpath(root);
  const workspace = path.join(canonicalRoot, "users", userId, "workspace", "projects", PROJECT_ID);
  const receiptRoot = path.join(canonicalRoot, "users", userId, "state", "document-generation-calls");
  const installation = {
    installationId: INSTALLATION_ID,
    companySlug: "documents-qa",
    paths: {
      dataRoot: path.join(canonicalRoot, "data"),
      usersRoot: path.join(canonicalRoot, "users"),
      companyContextRoot: path.join(canonicalRoot, "company-context"),
      sourceReadRoot: path.join(canonicalRoot, "source-ro"),
      publishWriteRoot: path.join(canonicalRoot, "publish-rw"),
      backupsRoot: path.join(canonicalRoot, "backups"),
    },
  };
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(receiptRoot, { recursive: true, mode: 0o700 }),
    mkdir(installation.paths.dataRoot, { recursive: true, mode: 0o700 }),
  ]);
  const canonicalWorkspace = await realpath(workspace);
  return {
    installation,
    installationId: INSTALLATION_ID,
    userId,
    projectId: PROJECT_ID,
    projectWorkspace: canonicalWorkspace,
    receiptRoot,
    runtimeThreadId: "runtime-thread",
    runtimeTurnId: "runtime-turn",
    sourceThreadId: THREAD_ID,
    sourceTurnId: MESSAGE_ID,
    permissions: permissions(userId),
    now: () => new Date("2026-08-30T12:00:00.000Z"),
  };
}

function request(callId: string, format: "pdf" | "docx" | "pptx" | "xlsx") {
  return {
    threadId: "runtime-thread",
    turnId: "runtime-turn",
    callId,
    namespace: AIBRAIN_DOCUMENT_TOOL_NAMESPACE,
    tool: "create",
    arguments: {
      format,
      fileName: `resultado.${format}`,
      title: `Resultado ${format}`,
      content: format === "xlsx" ? "Nombre\tImporte\nServicio\t1250" : "Resumen\nContenido verificable",
      ...(format === "xlsx" ? { rows: [["Nombre", "Importe"], ["Servicio", 1250]] } : {}),
    },
  } as const;
}

function batchRequest(callId = "hello-world-batch") {
  return {
    threadId: "runtime-thread",
    turnId: "runtime-turn",
    callId,
    namespace: AIBRAIN_DOCUMENT_TOOL_NAMESPACE,
    tool: "create_batch",
    arguments: {
      files: (["pdf", "docx", "pptx", "xlsx"] as const).map((format) => ({
        format,
        fileName: `hello-world.${format}`,
        title: "Hello world",
        content: "Hello world",
        ...(format === "xlsx" ? { rows: [["Message"], ["Hello world"]] } : {}),
      })),
    },
  } as const;
}

describe("local document dynamic tool", () => {
  it("exposes an optional Word heading flag for single and batch documents and renders it through the tool", async () => {
    for (const namespace of DOCUMENT_DYNAMIC_TOOLS) {
      if (namespace.type !== "namespace") throw Error("document namespace missing");
      const create = namespace.tools.find(tool => tool.name === "create")!;
      const batch = namespace.tools.find(tool => tool.name === "create_batch")!;
      expect(create.inputSchema).toMatchObject({ properties: { includeTitle: { type: "boolean", default: true } } });
      expect(batch.inputSchema).toMatchObject({ properties: { files: { items: { properties: { includeTitle: { type: "boolean", default: true } } } } } });
      expect((create.inputSchema as { required: string[] }).required).not.toContain("includeTitle");
    }
    const ctx = await context(USER_A), base = request("exact-body", "docx");
    const params = { ...base, arguments: { ...base.arguments, title: "Metadata", content: "Only this phrase", includeTitle: false } };
    const result = await handleLocalDocumentDynamicToolCall(params, ctx);
    expect(result.response.success).toBe(true);
    const bytes = await readFile(path.join(ctx.installation.paths.dataRoot, "generated-document-artifacts", USER_A, result.artifacts[0].id, "resultado.docx"));
    const archive = await JSZip.loadAsync(bytes), document = await archive.file("word/document.xml")!.async("text");
    expect(Array.from(document.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gu), match => match[1])).toEqual(["Only this phrase"]);
    const invalid = await handleLocalDocumentDynamicToolCall({ ...params, callId: "bad-heading-flag", arguments: { ...params.arguments, includeTitle: "false" } }, ctx);
    expect(invalid.response.success).toBe(false);
  });
  it("declares unique document functions and keeps the richer schedule contract", () => {
    for (const namespace of DOCUMENT_DYNAMIC_TOOLS) {
      if (namespace.type !== "namespace") throw Error("document namespace missing");
      expect(new Set(namespace.tools.map(tool => tool.name)).size).toBe(namespace.tools.length);
      const schedule = namespace.tools.filter(tool => tool.name === "create_arnall_schedule");
      expect(schedule).toHaveLength(1);
      expect(schedule[0].inputSchema).toMatchObject({ properties: { people: { items: { properties: {
        maxWeeklyHours: { type: "number", minimum: 0, maximum: 40 },
      } } } } });
    }
  });

  it("attaches a fictional Arnall schedule in the original template without business records", async () => {
    const base = await context(USER_A);
    const ctx = { ...base, installation: { ...base.installation, companySlug: "arnall" } };
    const params = {
      threadId: "runtime-thread", turnId: "runtime-turn", callId: "fictional-schedule",
      namespace: AIBRAIN_DOCUMENT_TOOL_NAMESPACE, tool: "create_arnall_schedule",
      arguments: { fileName: "horari-demo.xlsx", establishmentName: "Botiga Demo", week: "2026-W40", people: [
        { name: "Aina", section: "DEPENDIENTA", codeHours: { M: 5, T: 4, D: 9 }, days: [
          { code: "M", firstLine: "09:00–14:00", secondLine: "" },
          { code: "M", firstLine: "09:00–14:00", secondLine: "" },
          { code: "F", firstLine: "", secondLine: "" },
          { code: "M", firstLine: "09:00–14:00", secondLine: "" },
          { code: "M", firstLine: "09:00–14:00", secondLine: "" },
          { code: "F", firstLine: "", secondLine: "" },
          { code: "F", firstLine: "", secondLine: "" },
        ] },
      ] },
    };
    const denied = await handleLocalDocumentDynamicToolCall(params, base);
    expect(denied.response.success).toBe(false);
    expect(denied.artifacts).toHaveLength(0);
    const result = await handleLocalDocumentDynamicToolCall(params, ctx);
    expect(result.response.success).toBe(true);
    expect(result.artifacts).toHaveLength(1);
    const payload = JSON.parse((result.response.contentItems[0] as { text: string }).text);
    expect(payload.review).toMatchObject({ totalHours: 20, people: [{ name: "Aina", workDays: 4, hours: 20 }] });
    const wrongHours = await handleLocalDocumentDynamicToolCall({ ...params, callId: "fictional-wrong-hours", arguments: {
      ...params.arguments, people: [{ ...params.arguments.people[0], codeHours: { M: 4, T: 4, D: 9 } }],
    } }, ctx);
    expect(wrongHours.response.success).toBe(false);
    expect(wrongHours.artifacts).toHaveLength(0);
    const reducedWeek = await handleLocalDocumentDynamicToolCall({ ...params, callId: "fictional-reduced-week", arguments: {
      ...params.arguments, fileName: "horari-reduced.xlsx",
      people: [{ ...params.arguments.people[0], maxWeeklyHours: 16 }],
    } }, ctx);
    expect(reducedWeek.response.success).toBe(false);
    expect(reducedWeek.artifacts).toHaveLength(0);
    const validReducedWeek = await handleLocalDocumentDynamicToolCall({ ...params, callId: "fictional-valid-reduced-week", arguments: {
      ...params.arguments, fileName: "horari-reduced.xlsx",
      people: [{ ...params.arguments.people[0], maxWeeklyHours: 20 }],
    } }, ctx);
    expect(validReducedWeek.response.success).toBe(true);
    expect(validReducedWeek.artifacts).toHaveLength(1);
    const zip = await JSZip.loadAsync(await readFile(path.join(ctx.projectWorkspace, "documents/horari-demo.xlsx")));
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("text");
    expect(sheet).toContain("Botiga Demo");
    expect(sheet).toContain("Aina");
    expect(sheet).toContain("09:00–14:00");
    expect(sheet.match(/<f\b/gu)).toHaveLength(2499);
    expect((await zip.file("xl/workbook.xml")!.async("text")).match(/<sheet\b/gu)).toHaveLength(4);
    for (const node of ["mergeCells", "pageMargins", "pageSetup"]) {
      const re = new RegExp(`<${node}\\b[^>]*(?:/>|>[\\s\\S]*?</${node}>)`, "u");
      expect(sheet.match(re)?.[0]).toBe(template["xl/worksheets/sheet1.xml"].match(re)?.[0]);
    }
    expect(await handleLocalDocumentDynamicToolCall(params, ctx)).toEqual(result);
  });
  it("persists matching structured PDF and PPTX presentations and binds slide content to replay", async () => {
    const ctx = await context(USER_A);
    const slides = [{ title: "Objectiu", body: "Reduir incidències." }, { title: "Mesura", body: "Revisió setmanal de comandes." }];
    const params = {
      ...batchRequest("presentation-batch"),
      arguments: { files: (["pdf", "pptx"] as const).map((format) => ({
        format, fileName: `presentacio.${format}`, title: "Operacions", content: "Resum de la presentació", slides,
      })) },
    };
    const result = await handleLocalDocumentDynamicToolCall(params, ctx);
    expect(result.response.success).toBe(true);
    expect(result.artifacts).toHaveLength(2);
    for (const artifact of result.artifacts) expect(artifact.pages).toBe(2);
    const pdf = await PDFDocument.load(await readFile(path.join(ctx.projectWorkspace, "documents/presentacio.pdf")));
    expect(pdf.getPageCount()).toBe(2);
    const replay = await handleLocalDocumentDynamicToolCall(params, ctx);
    expect(replay.artifacts.map((artifact) => artifact.id)).toEqual(result.artifacts.map((artifact) => artifact.id));
    const changed = await handleLocalDocumentDynamicToolCall({ ...params, arguments: { files: params.arguments.files.map((file) => ({ ...file, slides: [{ title: "Changed", body: "Different final content" }] })) } }, ctx);
    expect(changed.response.success).toBe(false);
    expect(changed.artifacts).toHaveLength(0);
  });

  it("returns actionable slide validation failures without publishing artifacts", async () => {
    const ctx = await context(USER_A);
    const params = request("bad-slides", "pptx");
    const result = await handleLocalDocumentDynamicToolCall({ ...params, arguments: { ...params.arguments, slides: [] } }, ctx);
    expect(result.response.success).toBe(false);
    expect(result.response.contentItems).toEqual([expect.objectContaining({ text: expect.stringContaining("LOCAL_DOCUMENT_SLIDES_INVALID") })]);
    expect(result.artifacts).toHaveLength(0);
  });

  it("creates, verifies and projects all four formats from a private project workspace", async () => {
    const ctx = await context(USER_A);
    for (const format of ["pdf", "docx", "pptx", "xlsx"] as const) {
      const result = await handleLocalDocumentDynamicToolCall(request(`call-${format}`, format), ctx);
      expect(result.response.success).toBe(true);
      expect(result.artifacts).toEqual([expect.objectContaining({
        kind: format,
        status: "ready",
        url: expect.stringContaining("?download=1"),
        previewUrl: expect.stringContaining("?preview=1"),
      })]);
      const payload = JSON.parse((result.response.contentItems[0] as { text: string }).text);
      expect(payload).toMatchObject({ storage: "local-private-workspace", externalConnectorUsed: false, format });
      expect(payload).not.toHaveProperty("path");
      expect(payload.size).toBeGreaterThan(100);
      expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect((await readdir(path.join(ctx.projectWorkspace, "documents"))).sort()).toEqual([
      "resultado.docx", "resultado.pdf", "resultado.pptx", "resultado.xlsx",
    ]);
  }, 30_000);

  it("creates four requested formats in one deterministic call with one artifact per file and no internal path", async () => {
    const ctx = await context(USER_A);
    const result = await handleLocalDocumentDynamicToolCall(batchRequest(), ctx);

    expect(result.response.success).toBe(true);
    expect(result.artifacts.map(({ kind }) => kind)).toEqual(["pdf", "docx", "pptx", "xlsx"]);
    expect(new Set(result.artifacts.map(({ id }) => id))).toHaveProperty("size", 4);
    expect(result.artifacts.every(({ targetLabel }) => targetLabel === null)).toBe(true);
    expect((await readdir(path.join(ctx.projectWorkspace, "documents"))).sort()).toEqual([
      "hello-world.docx", "hello-world.pdf", "hello-world.pptx", "hello-world.xlsx",
    ]);
    const payload = JSON.parse((result.response.contentItems[0] as { text: string }).text);
    expect(payload).toMatchObject({
      status: "created",
      storage: "local-private-workspace",
      externalConnectorUsed: false,
    });
    expect(payload.files).toHaveLength(4);
    expect(JSON.stringify(payload)).not.toContain(ctx.projectWorkspace);
    expect(JSON.stringify(payload)).not.toContain("/var/lib/");
    expect(payload.files.every((file: Record<string, unknown>) => !("path" in file))).toBe(true);

    const replay = await handleLocalDocumentDynamicToolCall(batchRequest(), ctx);
    expect(replay).toEqual(result);
    expect(await readdir(path.join(ctx.projectWorkspace, "documents"))).toHaveLength(4);

    const changed = batchRequest();
    const conflict = await handleLocalDocumentDynamicToolCall({
      ...changed,
      arguments: {
        files: [
          ...changed.arguments.files,
          { format: "pdf", fileName: "extra.pdf", title: "Extra", content: "Extra" },
        ],
      },
    }, ctx);
    expect(conflict.response.success).toBe(false);
    expect((conflict.response.contentItems[0] as { text: string }).text).toContain("does not match");
    expect(await readdir(path.join(ctx.projectWorkspace, "documents"))).toHaveLength(4);

    const uncertainCallId = "uncertain-batch";
    const receiptName = `${createHash("sha256").update(uncertainCallId).digest("hex")}.json`;
    await mkdir(path.join(ctx.receiptRoot, `${receiptName}.claim`), { recursive: true, mode: 0o700 });
    const uncertain = await handleLocalDocumentDynamicToolCall(batchRequest(uncertainCallId), ctx);
    expect(uncertain.response.success).toBe(false);
    expect((uncertain.response.contentItems[0] as { text: string }).text).toContain("indeterminate");
    expect(await readdir(path.join(ctx.projectWorkspace, "documents"))).toHaveLength(4);
  }, 30_000);

  it("resolves a generated PNG by opaque item id and creates a one-page image-only A4 PDF", async () => {
    const ctx = await context(USER_A);
    const sourceImageItemId = "generated-image-item-1";
    const sourcePng = generatedPngFixture(120, 80);
    const imageArtifact = await persistGeneratedImageArtifact({
      id: sourceImageItemId,
      type: "imageGeneration",
      result: sourcePng.toString("base64"),
    }, {
      installation: ctx.installation,
      projectWorkspace: ctx.projectWorkspace,
      projectId: ctx.projectId,
      threadId: ctx.sourceThreadId,
      messageId: ctx.sourceTurnId,
      storageOwnerId: ctx.userId,
    });
    expect(imageArtifact).not.toBeNull();

    const result = await handleLocalDocumentDynamicToolCall({
      threadId: ctx.runtimeThreadId,
      turnId: ctx.runtimeTurnId,
      callId: "image-to-pdf-call",
      namespace: AIBRAIN_DOCUMENT_TOOL_NAMESPACE,
      tool: "image_to_pdf",
      arguments: {
        sourceImageItemId,
        fileName: "imagen-generada.pdf",
        title: "Imagen generada",
      },
    }, ctx);

    expect(result.response.success).toBe(true);
    expect(result.artifacts).toEqual([expect.objectContaining({
      kind: "pdf",
      name: "imagen-generada.pdf",
      pages: 1,
      mimeType: "application/pdf",
    })]);
    const responsePayload = JSON.parse((result.response.contentItems[0] as { text: string }).text);
    expect(responsePayload).not.toHaveProperty("path");
    expect(JSON.stringify(responsePayload)).not.toContain(sourceImageItemId);
    expect(JSON.stringify(responsePayload)).not.toContain(ctx.projectWorkspace);

    const bytes = await readFile(path.join(ctx.projectWorkspace, "documents", "imagen-generada.pdf"));
    const pdf = await PDFDocument.load(bytes);
    const page = pdf.getPages()[0]!;
    const resources = page.node.Resources()!;
    const xObjects = pdf.context.lookup(resources.get(PDFName.of("XObject")), PDFDict);
    const fonts = pdf.context.lookup(resources.get(PDFName.of("Font")), PDFDict);
    expect(pdf.getPageCount()).toBe(1);
    expect(page.getWidth()).toBeCloseTo(595.28, 2);
    expect(page.getHeight()).toBeCloseTo(841.89, 2);
    expect(xObjects.keys().length).toBeGreaterThan(0);
    expect(fonts.keys()).toHaveLength(0);
  }, 20_000);

  it("resolves an opaque image item from a previous assistant turn in the same thread", async () => {
    const ctx = await context(USER_A);
    const sourceImageItemId = "historical-generated-image-item";
    await persistGeneratedImageArtifact({
      id: sourceImageItemId,
      type: "imageGeneration",
      result: generatedPngFixture(96, 64).toString("base64"),
    }, {
      installation: ctx.installation,
      projectWorkspace: ctx.projectWorkspace,
      projectId: ctx.projectId,
      threadId: ctx.sourceThreadId,
      messageId: PREVIOUS_MESSAGE_ID,
      storageOwnerId: ctx.userId,
    });

    const result = await handleLocalDocumentDynamicToolCall({
      threadId: ctx.runtimeThreadId,
      turnId: ctx.runtimeTurnId,
      callId: "historical-image-to-pdf-call",
      namespace: AIBRAIN_DOCUMENT_TOOL_NAMESPACE,
      tool: "image_to_pdf",
      arguments: {
        sourceImageItemId,
        fileName: "imagen-anterior.pdf",
        title: "Imagen anterior",
      },
    }, ctx);

    expect(PREVIOUS_MESSAGE_ID).not.toBe(ctx.sourceTurnId);
    expect(result.response.success).toBe(true);
    const pdf = await PDFDocument.load(await readFile(path.join(ctx.projectWorkspace, "documents", "imagen-anterior.pdf")));
    expect(pdf.getPageCount()).toBe(1);
  }, 20_000);

  it("does not resolve historical image ids across thread or storage-owner boundaries", async () => {
    const ctx = await context(USER_A);
    const sourcePng = generatedPngFixture(48, 48).toString("base64");
    await persistGeneratedImageArtifact({
      id: "foreign-thread-image-item",
      type: "imageGeneration",
      result: sourcePng,
    }, {
      installation: ctx.installation,
      projectWorkspace: ctx.projectWorkspace,
      projectId: ctx.projectId,
      threadId: OTHER_THREAD_ID,
      messageId: PREVIOUS_MESSAGE_ID,
      storageOwnerId: ctx.userId,
    });
    await persistGeneratedImageArtifact({
      id: "foreign-owner-image-item",
      type: "imageGeneration",
      result: sourcePng,
    }, {
      installation: ctx.installation,
      projectWorkspace: ctx.projectWorkspace,
      projectId: ctx.projectId,
      threadId: ctx.sourceThreadId,
      messageId: PREVIOUS_MESSAGE_ID,
      storageOwnerId: USER_B,
    });

    for (const [callId, sourceImageItemId] of [
      ["foreign-thread-image-to-pdf", "foreign-thread-image-item"],
      ["foreign-owner-image-to-pdf", "foreign-owner-image-item"],
    ] as const) {
      const result = await handleLocalDocumentDynamicToolCall({
        threadId: ctx.runtimeThreadId,
        turnId: ctx.runtimeTurnId,
        callId,
        namespace: AIBRAIN_DOCUMENT_TOOL_NAMESPACE,
        tool: "image_to_pdf",
        arguments: { sourceImageItemId, fileName: `${callId}.pdf`, title: "Imagen privada" },
      }, ctx);
      expect(result.response.success).toBe(false);
      expect((result.response.contentItems[0] as { text: string }).text).toContain("LOCAL_DOCUMENT_SOURCE_IMAGE_INVALID");
    }
    await expect(readdir(path.join(ctx.projectWorkspace, "documents"))).resolves.toEqual([]);
  });

  it("rejects workspace paths and unknown image ids without creating a PDF", async () => {
    const ctx = await context(USER_A);
    const requestBase = {
      threadId: ctx.runtimeThreadId,
      turnId: ctx.runtimeTurnId,
      namespace: AIBRAIN_DOCUMENT_TOOL_NAMESPACE,
      tool: "image_to_pdf",
    } as const;
    const internalPath = await handleLocalDocumentDynamicToolCall({
      ...requestBase,
      callId: "image-path-rejected",
      arguments: {
        sourceImageItemId: "generated-image-item-1",
        sourceImagePath: "/var/lib/aibrain/private.png",
        fileName: "imagen.pdf",
        title: "Imagen",
      },
    }, ctx);
    expect(internalPath.response.success).toBe(false);
    expect((internalPath.response.contentItems[0] as { text: string }).text).toContain("LOCAL_DOCUMENT_ARGUMENTS_INVALID");

    const unknown = await handleLocalDocumentDynamicToolCall({
      ...requestBase,
      callId: "unknown-image-rejected",
      arguments: {
        sourceImageItemId: "missing-image-item",
        fileName: "imagen.pdf",
        title: "Imagen",
      },
    }, ctx);
    expect(unknown.response.success).toBe(false);
    expect((unknown.response.contentItems[0] as { text: string }).text).toContain("LOCAL_DOCUMENT_SOURCE_IMAGE_INVALID");
    await expect(readdir(path.join(ctx.projectWorkspace, "documents"))).resolves.toEqual([]);
  });

  it("replays the same call exactly once and rejects a changed replay", async () => {
    const ctx = await context(USER_A);
    const first = await handleLocalDocumentDynamicToolCall(request("stable-call", "pdf"), ctx);
    const replay = await handleLocalDocumentDynamicToolCall(request("stable-call", "pdf"), ctx);
    expect(replay).toEqual(first);
    expect(await readdir(path.join(ctx.projectWorkspace, "documents"))).toEqual(["resultado.pdf"]);

    const changed = request("stable-call", "pdf");
    const conflict = await handleLocalDocumentDynamicToolCall({
      ...changed,
      arguments: { ...changed.arguments, content: "Contenido distinto" },
    }, ctx);
    expect(conflict.response.success).toBe(false);
    expect((conflict.response.contentItems[0] as { text: string }).text).toContain("does not match");
  }, 20_000);

  it("fails closed for a denied user and cannot replay another user's receipt", async () => {
    const userA = await context(USER_A);
    const userB = await context(USER_B);
    const created = await handleLocalDocumentDynamicToolCall(request("private-call", "docx"), userA);
    expect(created.response.success).toBe(true);

    const denied = await handleLocalDocumentDynamicToolCall(request("denied-call", "docx"), {
      ...userB,
      permissions: permissions(USER_B, "deny"),
    });
    expect(denied.response.success).toBe(false);
    await expect(readdir(path.join(userB.projectWorkspace, "documents"))).rejects.toMatchObject({ code: "ENOENT" });

    const wrongIdentity = await handleLocalDocumentDynamicToolCall(request("private-call", "docx"), {
      ...userB,
      userId: USER_A,
    });
    expect(wrongIdentity.response.success).toBe(false);
  });

  it("uses no external connector and never inherits another employee's OAuth-backed result", async () => {
    const userA = await context(USER_A);
    const userB = await context(USER_B);
    const externalFetch = vi.fn(() => {
      throw new Error("local document generation must not access a provider");
    });
    vi.stubGlobal("fetch", externalFetch);
    vi.stubEnv("GOOGLE_DRIVE_OAUTH_TOKEN", "arnau-token-must-remain-unused");

    const privateRequest = {
      ...request("arnau-private-call", "docx"),
      arguments: {
        ...request("arnau-private-call", "docx").arguments,
        title: "Hello world",
        content: "Hello world",
      },
    };
    const created = await handleLocalDocumentDynamicToolCall(privateRequest, userA);
    expect(created.response.success).toBe(true);
    expect(JSON.parse((created.response.contentItems[0] as { text: string }).text)).toMatchObject({
      status: "created",
      externalConnectorUsed: false,
    });
    expect(externalFetch).not.toHaveBeenCalled();

    const foreignReplay = await handleLocalDocumentDynamicToolCall(
      privateRequest,
      { ...userB, receiptRoot: userA.receiptRoot },
    );
    expect(foreignReplay.response.success).toBe(false);
    expect(JSON.parse((foreignReplay.response.contentItems[0] as { text: string }).text)).toMatchObject({
      status: "failed",
      code: "LOCAL_DOCUMENT_RECEIPT_CONFLICT",
      externalConnectorUsed: false,
    });
    expect(externalFetch).not.toHaveBeenCalled();
  });
});


describe("presentation render turn boundary", () => {
  it("denies wrong turns and denied users before touching the workspace or converter", async () => {
    const ctx = await context(USER_A);
    const renderPresentation = vi.fn();
    const params = { ...request("render-denied", "pdf"), tool: "render", arguments: { relativePath: ".aibrain-drafts/deck.pdf", page: 1 } };
    for (const [call, permissionsValue] of [
      [{ ...params, turnId: "foreign-turn" }, ctx.permissions],
      [params, permissions(USER_A, "deny")],
    ] as const) {
      const result = await handleLocalDocumentDynamicToolCall(call, { ...ctx, projectWorkspace: "/does-not-exist", permissions: permissionsValue, renderPresentation });
      expect(result.response.success).toBe(false);
      expect(JSON.stringify(result.response)).toMatch(/IDENTITY_MISMATCH|PERMISSION_DENIED/);
      expect(result.artifacts).toEqual([]);
    }
    expect(renderPresentation).not.toHaveBeenCalled();
  });

  it("returns a review image and private draft PDF without creating a final artifact", async () => {
    const ctx = await context(USER_A);
    await mkdir(path.join(ctx.projectWorkspace, ".aibrain-drafts"));
    const pdf = await PDFDocument.create(); pdf.addPage();
    const data = Buffer.from(await pdf.save());
    await writeFile(path.join(ctx.projectWorkspace, ".aibrain-drafts/deck.pdf"), data);
    const renderPresentation = vi.fn().mockResolvedValue({ pdf: data, png: generatedPngFixture(), pages: 1 });
    const result = await handleLocalDocumentDynamicToolCall({ ...request("render-valid", "pdf"), tool: "render", arguments: { relativePath: ".aibrain-drafts/deck.pdf", page: 1 } }, { ...ctx, renderPresentation });
    expect(result.response.success).toBe(true);
    expect(result.artifacts).toEqual([]);
    expect(result.response.contentItems[1]).toMatchObject({ type: "inputImage", imageUrl: expect.stringMatching(/^data:image\/png;base64,/) });
    const metadata = JSON.parse(result.response.contentItems[0]!.type === "inputText" ? result.response.contentItems[0].text : "{}");
    expect(metadata).toMatchObject({ status: "review", page: 1, pages: 1, sha256: createHash("sha256").update(data).digest("hex") });
    expect(await readFile(path.join(ctx.projectWorkspace, metadata.reviewPdfPath))).toEqual(data);
    expect(await readdir(ctx.projectWorkspace)).toEqual([".aibrain-drafts"]);
  });
});


describe("explicit document delivery", () => {
  const delivery = (relativePath: string) => ({ ...request("delivery-call", "pdf"), tool: "deliver", arguments: { relativePath } });
  it.each(["pdf", "pptx", "docx", "xlsx"] as const)("delivers only the selected %s bytes and preserves stable repeat identity", async (format) => {
    const ctx = await context(USER_A);
    await mkdir(path.join(ctx.projectWorkspace, "documents"));
    const generated = await generateLocalDocument({ format, title: "Selected final", content: "Reviewed final content" });
    const relativePath = `documents/final.${format}`;
    await writeFile(path.join(ctx.projectWorkspace, relativePath), generated.data);
    await writeFile(path.join(ctx.projectWorkspace, `documents/old.${format}`), generated.data);
    const first = await handleLocalDocumentDynamicToolCall(delivery(relativePath), ctx);
    expect(first.response.success).toBe(true);
    expect(first.artifacts).toHaveLength(1);
    expect(first.artifacts[0]).toMatchObject({ name: `final.${format}`, kind: format, status: "ready" });
    const repeated = await handleLocalDocumentDynamicToolCall({ ...delivery(relativePath), callId: "delivery-repeat" }, ctx);
    expect(repeated.artifacts).toEqual(first.artifacts);
    const stored = path.join(ctx.installation.paths.dataRoot, "generated-document-artifacts", USER_A, first.artifacts[0]!.id, `final.${format}`);
    expect(await readFile(stored)).toEqual(generated.data);
    expect(JSON.stringify(first.response)).not.toContain(ctx.projectWorkspace);
    const changed = await generateLocalDocument({ format, title: "Changed", content: "Different source bytes" });
    await writeFile(path.join(ctx.projectWorkspace, relativePath), changed.data);
    const rejected = await handleLocalDocumentDynamicToolCall(delivery(relativePath), ctx);
    expect(rejected.response.success).toBe(false);
    expect(rejected.artifacts).toEqual([]);
    expect(await readFile(stored)).toEqual(generated.data);
  });

  it("rejects identity and permission mismatches before source reads", async () => {
    const ctx = await context(USER_A);
    for (const [params, policy] of [
      [{ ...delivery("documents/final.pdf"), turnId: "foreign-turn" }, ctx.permissions],
      [delivery("documents/final.pdf"), permissions(USER_A, "deny")],
      [delivery("documents/final.pdf"), permissions(USER_B)],
    ] as const) {
      const result = await handleLocalDocumentDynamicToolCall(params, { ...ctx, projectWorkspace: "/nonexistent", permissions: policy });
      expect(result.response.success).toBe(false);
      expect(JSON.stringify(result.response)).toMatch(/IDENTITY_MISMATCH|PERMISSION_DENIED/);
      expect(result.artifacts).toEqual([]);
    }
  });

  it("rejects drafts, traversal, symlinks and invalid file bytes without delivery", async () => {
    const ctx = await context(USER_A);
    await mkdir(path.join(ctx.projectWorkspace, "documents"));
    await writeFile(path.join(ctx.projectWorkspace, "documents/fake.pdf"), "not a pdf");
    await symlink(path.join(ctx.projectWorkspace, "documents/fake.pdf"), path.join(ctx.projectWorkspace, "documents/link.pdf"));
    await symlink(path.join(ctx.projectWorkspace, "documents"), path.join(ctx.projectWorkspace, "documents/linked"));
    for (const relativePath of [".aibrain-drafts/review.pdf", "documents/../outside.pdf", "documents/.aibrain-drafts/review.pdf", "/documents/final.pdf", "documents//final.pdf", "documents/fake.pdf", "documents/link.pdf", "documents/linked/fake.pdf"]) {
      const result = await handleLocalDocumentDynamicToolCall(delivery(relativePath), ctx);
      expect(result.response.success).toBe(false);
      expect(result.artifacts).toEqual([]);
    }
    expect(await readdir(ctx.installation.paths.dataRoot)).toEqual([]);
  });
});

it("confirms a remembered file only after the persistence callback succeeds", async () => {
  const ctx = await context(USER_A);
  const call = { threadId: ctx.runtimeThreadId, turnId: ctx.runtimeTurnId, callId: "remember-1", namespace: AIBRAIN_DOCUMENT_TOOL_NAMESPACE,
    tool: "remember", arguments: { fileName: "reference.xlsx" } };
  const persist = vi.fn().mockResolvedValue({ status: "saved", name: "reference.xlsx", sha256: "a".repeat(64) });
  const result = await handleLocalDocumentDynamicToolCall(call, { ...ctx, rememberProjectFile: persist });
  expect(result.response.success).toBe(true); expect(persist).toHaveBeenCalledWith("reference.xlsx");
  persist.mockRejectedValue(new Error("Original unavailable"));
  expect((await handleLocalDocumentDynamicToolCall(call, { ...ctx, rememberProjectFile: persist })).response.success).toBe(false);
  persist.mockClear();
  expect((await handleLocalDocumentDynamicToolCall({ ...call, turnId: "foreign-turn" }, { ...ctx, rememberProjectFile: persist })).response.success).toBe(false);
  expect(persist).not.toHaveBeenCalled();
});

it("confirms project preferences only after a verified scoped save", async () => {
  const ctx = await context(USER_A);
  const call = { threadId: ctx.runtimeThreadId, turnId: ctx.runtimeTurnId, callId: "preferences-1", namespace: AIBRAIN_DOCUMENT_TOOL_NAMESPACE,
    tool: "remember_preferences", arguments: { notes: "Usar cinco columnas y tolerancia inferior a 0,05 €." } };
  const persist = vi.fn().mockResolvedValue({ status: "saved", notes: call.arguments.notes });
  expect((await handleLocalDocumentDynamicToolCall(call, { ...ctx, rememberProjectPreferences: persist })).response.success).toBe(true);
  expect(persist).toHaveBeenCalledWith(call.arguments.notes);
  persist.mockRejectedValue(new Error("Los criterios han cambiado en otra conversación."));
  expect((await handleLocalDocumentDynamicToolCall(call, { ...ctx, rememberProjectPreferences: persist })).response.success).toBe(false);
  persist.mockClear();
  expect((await handleLocalDocumentDynamicToolCall({ ...call, turnId: "foreign-turn" }, { ...ctx, rememberProjectPreferences: persist })).response.success).toBe(false);
  expect(persist).not.toHaveBeenCalled();
});
