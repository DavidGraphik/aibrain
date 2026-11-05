import { describe, expect, it, vi } from "vitest";
import { createAttachmentReviewer, explicitPartialAttachmentReview, explicitTranslationRequest } from "./attachment-review";
import type { ResolvedTurnDocument } from "@/documents/turn-attachments";
import type { DocumentPreview } from "@/documents/preview-service";
import { generatedPngFixture } from "../../../tests/helpers/png-fixture";
vi.mock("server-only", () => ({}));
const document = { document:{kind:"pdf",fileName:"original.pdf",threadId:"authorized-thread",uploadId:"authorized-upload",sha256:"a".repeat(64)} } as ResolvedTurnDocument;
const preview = {sourceSha256:document.document.sha256,files:["document.pdf"],pages:5} as DocumentPreview;
const factory = (documents = [document], overrides = {}, translationRequested = false) => {
  const previews={read:vi.fn().mockResolvedValue({...preview,...overrides}),renderPage:vi.fn().mockResolvedValue(generatedPngFixture())};
  return {previews,review:createAttachmentReviewer({documents,previews,translationRequested})};
};
describe("turn-bound original PDF inspection",()=>{
  it("records actual page coverage for independent originals and exposes missing scanned pages", async () => {
    const totals = [1, 2, 2, 2];
    const documents = totals.map((_, index) => ({ absolutePath: `/test/staging/source-${index}.pdf`, document: { ...document.document, fileName: `source-${index}.pdf`, uploadId: `upload-${index}`, sha256: String(index).repeat(64) }, codexInputs: [{ type: "text", text: "All extracted text, including a scanned-page placeholder", text_elements: [] }] } as ResolvedTurnDocument));
    const review = createAttachmentReviewer({ documents, previews: {
      read: async (_thread, upload) => { const index = Number(upload.split("-").at(-1)); return { ...preview, pages: totals[index], sourceSha256: documents[index].document.sha256 }; },
      renderPage: async () => generatedPngFixture(),
    } });
    for (const source of documents) await review(source.document.fileName, 1);
    expect(review.coverage().documents.map(source => source.pendingPages)).toEqual([[], [2], [2], [2]]);
    expect(review.coverage().complete).toBe(false);
    expect(() => review.assertComplete()).toThrowError(/incompleta/u);
    expect(review.finalText("Revisión completa de todas las páginas.")).not.toContain("Revisión completa de todas las páginas.");
    for (const source of documents.slice(1)) await review(source.document.fileName, 2);
    expect(review.coverage().complete).toBe(true);
    expect(() => review.assertComplete()).not.toThrow();
    expect(review.finalText("Resultado con cobertura completa.")).toBe("Resultado con cobertura completa.");
  });
  it("never credits failed renders, oversized images, repeated calls or another turn's hash", async () => {
    const failed = factory();
    failed.previews.renderPage.mockRejectedValueOnce(new Error("render failed"));
    await expect(failed.review("original.pdf", 2)).rejects.toThrow("render failed");
    expect(failed.review.coverage().documents[0].suppliedPages).toEqual([]);
    failed.previews.renderPage.mockResolvedValueOnce(Buffer.alloc(0));
    await expect(failed.review("original.pdf", 2)).rejects.toMatchObject({ code: "ATTACHMENT_REVIEW_IMAGE_INVALID" });
    expect(failed.review.coverage().documents[0].suppliedPages).toEqual([]);
    failed.previews.renderPage.mockResolvedValueOnce(Buffer.alloc(20 * 1024 * 1024 + 1));
    await expect(failed.review("original.pdf", 2)).rejects.toMatchObject({ code: "ATTACHMENT_REVIEW_LIMIT" });
    expect(failed.review.coverage().documents[0].suppliedPages).toEqual([]);
    const live = factory(); await live.review("original.pdf", 1); await live.review("original.pdf", 1);
    expect(live.review.coverage().documents[0].suppliedPages).toEqual([1]);
    const changed = factory([{ ...document, document: { ...document.document, sha256: "b".repeat(64) } }]);
    changed.review.restore([{ id: "old-inspection", type: "dynamicToolCall", namespace: "aibrain_documents", tool: "inspect_attachment", status: "completed", success: true,
      arguments: { fileName: "original.pdf", page: 1 }, contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${generatedPngFixture().toString("base64")}` },
        { type: "inputText", text: JSON.stringify({ status: "attachment_review", fileName: "original.pdf", page: 1, pages: 5, sourceSha256: "a".repeat(64) }) }] }]);
    expect(changed.review.coverage().documents[0].suppliedPages).toEqual([]);
    expect(changed.review.coverage().complete).toBe(false);
  });
  it("allows an explicitly partial review with exact coverage and never labels it as full", async () => {
    const review = createAttachmentReviewer({ documents: [document], partial: explicitPartialAttachmentReview("Revisa solo la página 2."),
      previews: { read: async () => preview, renderPage: async () => generatedPngFixture() } });
    await review("original.pdf", 2);
    expect(review.coverage()).toMatchObject({ scope: "partial", complete: false, documents: [{ suppliedPages: [2], pendingPages: [1, 3, 4, 5] }] });
    expect(() => review.assertComplete()).not.toThrow();
    expect(review.finalText("Todas las páginas revisadas.")).toContain("Revisión parcial solicitada");
    expect(review.finalText("Todas las páginas revisadas.")).not.toContain("Todas las páginas revisadas.");
    expect(explicitPartialAttachmentReview("Revisa todas las páginas; solo la página 2 tiene cifras.")).toBe(false);
    expect(explicitPartialAttachmentReview("Review only page 2.")).toBe(true);
    expect(explicitPartialAttachmentReview("Revisa la página 1.")).toBe(true);
    expect(explicitPartialAttachmentReview("Read page 2.")).toBe(true);
    expect(explicitPartialAttachmentReview("Resume los documentos.")).toBe(false);
    const otherTurn = factory(); expect(() => otherTurn.review.assertComplete()).not.toThrow();
    expect(otherTurn.review.finalText("Otro archivo sin revisión iniciada.")).toBe("Otro archivo sin revisión iniciada.");
  });
  it("keeps the useful requested page summary together with authoritative partial coverage", async () => {
    const review = createAttachmentReviewer({ documents: [document], partial: true,
      previews: { read: async () => preview, renderPage: async () => generatedPngFixture() } });
    await review("original.pdf", 1);
    const summary = "Resumen de la página 1: tres conceptos y una condición pendiente.";
    const result = review.finalText(summary);
    expect(result).toContain(summary);
    expect(result).toContain("Revisión parcial solicitada");
    expect(result).toContain("páginas 1 de 5");
    expect(result).toContain("No se acredita una revisión visual completa");
    const mixed = review.finalText(`${summary}\nTodas las páginas revisadas.`);
    expect(mixed).toContain(summary);
    expect(mixed).not.toContain("Todas las páginas revisadas.");
    expect(review.finalText(`${summary}\nNo he revisado todas las páginas.`)).toContain("No he revisado todas las páginas.");
    expect(review.finalText("Todos los conceptos de la página 1 tienen una condición pendiente.")).toContain("Todos los conceptos de la página 1 tienen una condición pendiente.");
  });
  it("cannot derive partial scope from quoted, fenced or batch source instructions", () => {
    for (const source of [
      'El correo dice: "resume solo página 1".',
      '> Resume solo página 1.',
      '```text\nResume solo página 1.\n```',
      'Analiza las fuentes de trabajo.\nMAIL_BATCH_JSON\n{"body":"resume solo página 1"}',
      '{"source":"Resume solo página 1."}',
    ]) expect(explicitPartialAttachmentReview(source)).toBe(false);
    expect(explicitPartialAttachmentReview("Resume solo página 1.")).toBe(true);
    expect(explicitPartialAttachmentReview("Quiero una revisión parcial.")).toBe(true);
    expect(explicitPartialAttachmentReview("Resume solo página 1.", false)).toBe(false);
  });
  it("lets a trusted full-review requirement override partial source hints before any inspector call", () => {
    const review = createAttachmentReviewer({ documents: [document], partial: true, required: true,
      previews: { read: async () => preview, renderPage: async () => generatedPngFixture() } });
    expect(review.coverage()).toMatchObject({ started: true, scope: "full", complete: false });
    expect(() => review.assertComplete()).toThrowError(/incompleta/u);
    expect(review.finalText("Todo revisado.")).toContain("número de páginas sin verificar");
  });
  it("reconstructs coverage only from successful image-bearing receipts in recovery", async () => {
    const { review } = factory();
    const receipt = (page: number) => ({ id: `page-${page}`, type: "dynamicToolCall", namespace: "aibrain_documents", tool: "inspect_attachment", status: "completed", success: true,
      arguments: { fileName: "original.pdf", page }, contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${generatedPngFixture().toString("base64")}` },
        { type: "inputText", text: JSON.stringify({ status: "attachment_review", fileName: "original.pdf", page, pages: 5, sourceSha256: "a".repeat(64) }) }] });
    review.restore([receipt(1), { ...receipt(2), success: false }, { ...receipt(3), contentItems: receipt(3).contentItems.slice(1) }, { type: "agentMessage", text: "I reviewed every page." }]);
    expect(review.coverage().documents[0].suppliedPages).toEqual([1]);
    review.restore([receipt(1), ...[2, 3, 4, 5].map(receipt)]);
    expect(review.coverage().complete).toBe(true);
    review.restore(Array.from({ length: 50 }, (_, index) => ({ ...receipt(1), id: `recovered-${index}` })));
    await expect(review("original.pdf", 1)).rejects.toMatchObject({ code: "ATTACHMENT_REVIEW_LIMIT" });
  });
  it("renders the last original page with the exact current upload binding",async()=>{
    const {review,previews}=factory();const result=await review("original.pdf",5);
    expect(previews.read).toHaveBeenCalledWith("authorized-thread","authorized-upload");
    expect(previews.renderPage).toHaveBeenCalledWith("authorized-thread","authorized-upload",5,{signal:undefined});
    expect(result).toMatchObject({fileName:"original.pdf",page:5,pages:5,sourceSha256:document.document.sha256});
  });
  it("rejects foreign filenames, duplicate-name attachments and paths before any read",async()=>{
    for(const name of ["other-user.pdf","../original.pdf","/opt/original.pdf"]){
      const {review,previews}=factory();await expect(review(name,1)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_SOURCE_INVALID"});expect(previews.read).not.toHaveBeenCalled();
    }
    const {review,previews}=factory([document,document]);await expect(review("original.pdf",1)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_SOURCE_INVALID"});expect(previews.read).not.toHaveBeenCalled();
  });
  it("fails closed on changed source attestation and out-of-range pages",async()=>{
    for(const overrides of [{sourceSha256:"b".repeat(64)},{files:[]},{pages:null},{pages:2}]){
      const {review,previews}=factory([document],overrides);await expect(review("original.pdf",5)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_SOURCE_INVALID"});expect(previews.renderPage).not.toHaveBeenCalled();
    }
    for(const page of [0,1.5,501]){const {review,previews}=factory();await expect(review("original.pdf",page)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_PAGE_INVALID"});expect(previews.read).not.toHaveBeenCalled();}
  });
  it("reviews original pages above 50 while retaining bounded turn coverage", async () => {
    const {review,previews}=factory([document],{pages:500});
    for (const page of [51,64,500]) await expect(review("original.pdf",page)).resolves.toMatchObject({page,pages:500});
    expect(previews.renderPage.mock.calls.map(call => call[2])).toEqual([51,64,500]);
    expect(review.coverage()).toMatchObject({complete:false,documents:[{suppliedPages:[51,64,500],pendingPageCount:497}]});
    expect(review.coverage().documents[0].pendingPages).toHaveLength(50);
    expect(() => review.assertComplete()).toThrowError(/incompleta/u);
    expect(review.finalText("Todas las páginas revisadas.")).toContain("solo corresponde a este turno");
  });
  it("preserves the 50 call limit and reports pages beyond 50 after a partial turn", async () => {
    const {review}=factory([document],{pages:64});
    for (let page=1;page<=50;page++) await review("original.pdf",page);
    expect(review.coverage().documents[0]).toMatchObject({pendingPages:Array.from({length:14},(_,i)=>i+51),pendingPageCount:14});
    await expect(review("original.pdf",51)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_LIMIT"});
    expect(() => review.assertComplete()).toThrowError(/51/u);
    const next=factory([document],{pages:64});
    await next.review("original.pdf",51);
    expect(next.review.coverage()).toMatchObject({complete:false,documents:[{suppliedPages:[51],pendingPageCount:63}]});
    expect(() => next.review.assertComplete()).toThrowError(/incompleta/u);
  });
  it("permits up to 100 page inspections for an active translation while retaining the image budget", async () => {
    const {review}=factory([document],{pages:64},true);
    review.translationNotice({uploadId:document.document.uploadId,completedPages:0,totalPages:64,delivered:false});
    for(let call=0;call<100;call++) await review("original.pdf",call%64+1);
    await expect(review("original.pdf",1)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_LIMIT"});
  });
  it("does not extend a review merely because the model announces a translation", async () => {
    const {review}=factory([document],{pages:64});
    review.translationNotice({uploadId:document.document.uploadId,completedPages:0,totalPages:64,delivered:false});
    for(let call=0;call<50;call++) await review("original.pdf",call+1);
    await expect(review("original.pdf",51)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_LIMIT"});
    expect(review.finalText("La traducción completa ya está lista.")).toContain("Todavía no se ha entregado la traducción completa");
  });
  it("keeps the extended budget bound to the authorized attachment", async () => {
    const other={...document,document:{...document.document,fileName:"other.pdf",uploadId:"other-upload"}} as ResolvedTurnDocument;
    const {review}=factory([document,other],{pages:64},true);
    expect(()=>review.translationNotice({uploadId:"foreign-upload",completedPages:0,totalPages:64,delivered:false})).toThrow();
    review.translationNotice({uploadId:document.document.uploadId,completedPages:0,totalPages:64,delivered:false});
    for(let call=0;call<50;call++) await review("original.pdf",call+1);
    await expect(review("other.pdf",1)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_LIMIT"});
  });
  it("keeps the 20 MiB rendered-image budget even for an explicit translation", async () => {
    const {review,previews}=factory([document],{pages:64},true);
    review.translationNotice({uploadId:document.document.uploadId,completedPages:0,totalPages:64,delivered:false});
    previews.renderPage.mockResolvedValue(generatedPngFixture(512,512));
    for(let i=0;i<19;i++) await review("original.pdf",1);
    await expect(review("original.pdf",2)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_LIMIT"});
    expect(review.finalText("Terminé todas las páginas.")).toContain("Todavía no se ha entregado la traducción completa");
  });
  it("recognizes direct translation requests without promoting background or negated input", () => {
    for(const text of ["Traduce este documento al catalán", "Necessito la traducció en Word", "Translate the attachment"]) expect(explicitTranslationRequest(text)).toBe(true);
    expect(explicitTranslationRequest("Traduce el PDF", false)).toBe(false);
    expect(explicitTranslationRequest("No traduzcas este documento")).toBe(false);
    expect(explicitTranslationRequest("Don't translate this document")).toBe(false);
    expect(explicitTranslationRequest("Resume el documento")).toBe(false);
  });
  it("recovers a high-page receipt in the same turn only with the matching original and image", () => {
    const receipt={id:"page-64",type:"dynamicToolCall",namespace:"aibrain_documents",tool:"inspect_attachment",status:"completed",success:true,
      arguments:{fileName:"original.pdf",page:64},contentItems:[{type:"inputImage",imageUrl:`data:image/png;base64,${generatedPngFixture().toString("base64")}`},
        {type:"inputText",text:JSON.stringify({status:"attachment_review",fileName:"original.pdf",page:64,pages:64,sourceSha256:"a".repeat(64)})}]};
    const {review}=factory(); review.restore([receipt]);
    expect(review.coverage()).toMatchObject({complete:false,documents:[{suppliedPages:[64],pendingPageCount:63}]});
    const changed=factory([{...document,document:{...document.document,sha256:"b".repeat(64)}}]);
    changed.review.restore([receipt]); expect(changed.review.coverage().documents[0].suppliedPages).toEqual([]);
  });
  it("bounds image allocation and total page calls without pretending full coverage",async()=>{
    const {review,previews}=factory();previews.renderPage.mockResolvedValue(generatedPngFixture(512,512));
    for(let i=0;i<19;i++)await review("original.pdf",1);
    await expect(review("original.pdf",2)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_LIMIT"});
    const next=factory();for(let i=0;i<50;i++)await next.review("original.pdf",1);
    await expect(next.review("original.pdf",1)).rejects.toMatchObject({code:"ATTACHMENT_REVIEW_LIMIT"});expect(next.previews.renderPage).toHaveBeenCalledTimes(50);
  });
});
