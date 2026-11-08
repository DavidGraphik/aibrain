import type { ResolvedTurnDocument, TurnDocumentPreviewReader } from "@/documents/turn-attachments";
import { isPng } from "@/runtime/generated-image-artifacts";
import { createHash } from "node:crypto";
import type { InspectedPage } from "./translation-progress";
import type { StagedDocument } from "@/documents/staging-store";

export type AttachmentReviewCoverage = {
  started: boolean;
  scope: "full" | "partial";
  complete: boolean;
  documents: Array<{ fileName: string; pages: number | null; suppliedPages: number[]; pendingPages: number[]; pendingPageCount: number | null }>;
};
export class AttachmentReviewError extends Error {
  constructor(readonly code: string, message: string, readonly coverage?: AttachmentReviewCoverage) { super(message); }
}
export type AttachmentPageReview = { png: Buffer; fileName: string; page: number; pages: number; sourceSha256: string; coverage?: AttachmentReviewCoverage };
export type AttachmentReviewer = ((fileName: string, page: number) => Promise<AttachmentPageReview>) & {
  coverage(): AttachmentReviewCoverage;
  assertComplete(): void;
  finalText(text: string): string;
  restore(items: readonly unknown[]): void;
  translationSource(fileName: string): Promise<{ uploadId: string; sourceSha256: string; pages: number }>;
  translationInspection(fileName: string, page: number): InspectedPage;
  translationNotice(status: { uploadId: string; completedPages: number; totalPages: number; delivered: boolean }): void;
  referenceHistoricalPdf(document: StagedDocument, revalidate: () => Promise<void>): void;
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const normalizedText = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

// Preserve partial findings; drop direct whole-document coverage assertions.
// This is a narrow guard, not a semantic validator of the author's conclusions.
function partialFindings(text: string) {
  return (text.match(/[^.!?\n;]+[.!?\n;]*|[.!?\n;]+/gu) ?? []).filter(part => {
    const value = normalizedText(part);
    const claimsFull = /\b(?:todas?|todos?|all|every|totes|tots)\s+(?:(?:las|los|the|les|els)\s+)?(?:(?:original|originales|originals|attached|adjuntas|single)\s+)?(?:paginas?|pages?|pagines?)\b/u.test(value) ||
      /\b(?:revision|revisio|review)(?:\s+visual)?\s+(?:completa|completo|complete|full)\b/u.test(value) ||
      /\b(?:completa|completo|complete|full)(?:\s+visual)?\s+(?:revision|revisio|review)\b/u.test(value);
    const negatesFull = /\b(?:no|not|cannot|can't)\b.{0,60}\b(?:todas?|todos?|all|every|totes|tots|completa|completo|complete|full)\b/u.test(value);
    const claimsCompletedTranslation = /\b(?:he|hem|han|has|ha|have|has|i've)\s+(?:ya\s+|ja\s+|already\s+)?(?:traducido|traduit|translated)\b/u.test(value) ||
      /\b(?:traduccion|traduccio|translation)\b.{0,40}\b(?:lista|llesta|completa|completo|complet|completada|completat|entregada|finalizada|terminada|complete|ready|delivered)\b/u.test(value);
    const negatesTranslation = /\b(?:no|not|cannot|can't)\b.{0,50}\b(?:traducid\w*|traduit\w*|translat\w*|traduccion|traduccio)\b/u.test(value);
    return (!claimsFull || negatesFull) && (!claimsCompletedTranslation || negatesTranslation);
  }).join("").trim();
}

// Coverage attests images supplied to the model, not comprehension. One ledger
// belongs to one permission-bound turn; extracted text never credits a page.
export function createAttachmentReviewer(input: {
  documents: readonly ResolvedTurnDocument[];
  previews: Pick<TurnDocumentPreviewReader, "read"> & { renderPage(threadId: string, uploadId: string, page: number, options?: { signal?: AbortSignal }): Promise<Buffer> };
  signal?: AbortSignal;
  partial?: boolean;
  required?: boolean;
  translationRequested?: boolean;
}): AttachmentReviewer {
  let calls = 0, imageBytes = 0, started = false;
  const partial = input.partial === true && input.required !== true;
  const recoveredCalls = new Set<string>(), recoveredImages = new Set<string>();
  let recoveredImageBytes = 0;
  const inspected = new Map<string, InspectedPage>();
  let translationStatus: { uploadId: string; completedPages: number; totalPages: number; delivered: boolean } | null = null;
  const sources: Array<{ document: StagedDocument; pages: number | null; supplied: Set<number>; revalidate?: () => Promise<void> }> = input.documents.filter(({ document }) => document.kind === "pdf").map(attachment => ({
    document: attachment.document,
    pages: null as number | null,
    supplied: new Set<number>(attachment.codexInputs?.some(item => item.type === "image") ? [1] : []),
  }));
  started = input.required === true && sources.length > 0;
  const coverage = (): AttachmentReviewCoverage => {
    const documents = sources.map(source => ({ fileName: source.document.fileName, pages: source.pages,
      suppliedPages: [...source.supplied].sort((a, b) => a - b),
      pendingPages: source.pages === null ? [] : Array.from({ length: Math.min(source.pages, 500) }, (_, i) => i + 1).filter(page => !source.supplied.has(page)).slice(0, 50),
      pendingPageCount: source.pages === null ? null : source.pages - source.supplied.size,
    }));
    return { started, scope: partial ? "partial" : "full", complete: started && documents.length > 0 && documents.every(source => source.pendingPageCount === 0), documents };
  };
  const pendingMessage = () => `Revisión visual incompleta: no está acreditada la revisión de todas las páginas originales.\n${coverage().documents.filter(source => source.pendingPageCount !== 0).map(source =>
    `${JSON.stringify(source.fileName)}: ${source.pages === null ? "número de páginas sin verificar" : `páginas pendientes ${source.pendingPages.join(", ")}${source.pendingPageCount! > source.pendingPages.length ? ` y otras (${source.pendingPageCount} en total)` : ""}`}`).join("\n")}\nLa cobertura solo corresponde a este turno. Para continuar, pide explícitamente un intervalo de páginas como revisión parcial y conserva sus resultados. La inspección en varios turnos no acredita por sí sola una revisión completa ni autoriza entregar una traducción completa. El texto extraído no acredita cobertura visual.`;
  const review = async (fileName: string, page: number): Promise<AttachmentPageReview> => {
    input.signal?.throwIfAborted();
    const matches = sources.filter(source => source.document.fileName === fileName);
    if (matches.length !== 1) throw new AttachmentReviewError("ATTACHMENT_REVIEW_SOURCE_INVALID", "El PDF debe ser un adjunto único de este turno.");
    const source = matches[0]!;
    const { document } = source;
    await source.revalidate?.();
    started = true;
    if (!Number.isSafeInteger(page) || page < 1 || page > 500)
      throw new AttachmentReviewError("ATTACHMENT_REVIEW_PAGE_INVALID", "Selecciona una página entre 1 y 500.");
    // Translation persists each authored page as it is processed. Permit a
    // 64-page document to finish in one turn where the independent image-byte
    // bound permits it; ordinary reviews keep the existing 50-call ceiling.
    const maxCalls = input.translationRequested && translationStatus?.uploadId === document.uploadId ? 100 : 50;
    if (++calls > maxCalls) throw new AttachmentReviewError("ATTACHMENT_REVIEW_LIMIT", "Se alcanzó el límite de revisión visual del turno; no afirmar cobertura completa.");
    const preview = await input.previews.read(document.threadId, document.uploadId);
    if (preview.sourceSha256 !== document.sha256 || !preview.files.includes("document.pdf") ||
        preview.pages === null || !Number.isSafeInteger(preview.pages) || preview.pages < 1 || page > preview.pages ||
        (source.pages !== null && source.pages !== preview.pages))
      throw new AttachmentReviewError("ATTACHMENT_REVIEW_SOURCE_INVALID", "No se ha podido verificar la página contra el original autorizado.");
    source.pages = preview.pages;
    const png = await input.previews.renderPage(document.threadId, document.uploadId, page, { signal: input.signal });
    await source.revalidate?.();
    imageBytes += png.length;
    if (imageBytes > 20 * 1024 * 1024)
      throw new AttachmentReviewError("ATTACHMENT_REVIEW_LIMIT", "La revisión visual supera el límite de imágenes; no afirmar cobertura completa.");
    if (!isPng(png)) throw new AttachmentReviewError("ATTACHMENT_REVIEW_IMAGE_INVALID", "La página no produjo una imagen PNG válida; sigue sin verificar.");
    inspected.set(`${document.uploadId}:${page}`, {page,pages:preview.pages,sourceSha256:document.sha256,imageSha256:createHash("sha256").update(png).digest("hex")});
    source.supplied.add(page);
    return { png, fileName: document.fileName, page, pages: preview.pages, sourceSha256: document.sha256, coverage: coverage() };
  };
  return Object.assign(review, {
    coverage,
    async translationSource(fileName: string) {
      const matches=sources.filter(source=>source.document.fileName===fileName);
      if(matches.length!==1) throw new AttachmentReviewError("ATTACHMENT_REVIEW_SOURCE_INVALID","El PDF debe ser un adjunto único de este turno.");
      const document=matches[0]!.document;
      await matches[0]!.revalidate?.();
      const preview=await input.previews.read(document.threadId,document.uploadId);
      if(preview.sourceSha256!==document.sha256 || !preview.files.includes("document.pdf") || preview.pages===null ||
        !Number.isSafeInteger(preview.pages) || preview.pages<1 || preview.pages>500)
        throw new AttachmentReviewError("ATTACHMENT_REVIEW_SOURCE_INVALID","No se ha podido verificar el original autorizado.");
      await matches[0]!.revalidate?.();
      return {uploadId:document.uploadId,sourceSha256:document.sha256,pages:preview.pages};
    },
    referenceHistoricalPdf(document: StagedDocument, revalidate: () => Promise<void>) {
      if(document.kind!=="pdf" || typeof revalidate!=="function") throw new AttachmentReviewError("ATTACHMENT_REVIEW_SOURCE_INVALID","El original histórico no es un PDF autorizado.");
      const same=sources.find(source=>source.document.uploadId===document.uploadId && source.document.threadId===document.threadId);
      if(same) {
        if(same.document.sha256!==document.sha256 || same.document.fileName!==document.fileName) throw new AttachmentReviewError("ATTACHMENT_REVIEW_SOURCE_INVALID","El original histórico ha cambiado.");
        same.revalidate=revalidate; return;
      }
      if(sources.some(source=>source.document.fileName===document.fileName)) throw new AttachmentReviewError("ATTACHMENT_REVIEW_SOURCE_INVALID","Hay varios PDF con el mismo nombre; selecciona un único original.");
      sources.push({document,pages:null,supplied:new Set(),revalidate});
    },
    translationInspection(fileName: string, page: number) {
      const matches=sources.filter(source=>source.document.fileName===fileName);
      const result=matches.length===1 ? inspected.get(`${matches[0]!.document.uploadId}:${page}`) : undefined;
      if(!result) throw new AttachmentReviewError("ATTACHMENT_REVIEW_INCOMPLETE","Inspecciona esta página original en el turno actual antes de guardar su traducción.");
      return result;
    },
    translationNotice(status: { uploadId: string; completedPages: number; totalPages: number; delivered: boolean }) {
      if (!sources.some(source => source.document.uploadId === status.uploadId))
        throw new AttachmentReviewError("ATTACHMENT_REVIEW_SOURCE_INVALID", "La traducción no pertenece al adjunto autorizado.");
      translationStatus = status;
    },
    assertComplete() {
      if (translationStatus && !translationStatus.delivered) throw new AttachmentReviewError("ATTACHMENT_REVIEW_INCOMPLETE", "La traducción todavía no se ha terminado y entregado; no se puede crear ni presentar como completa.");
      if (started && !partial && !coverage().complete) throw new AttachmentReviewError("ATTACHMENT_REVIEW_INCOMPLETE", pendingMessage(), coverage());
    },
    finalText(text: string) {
      if (translationStatus?.delivered) return `Se ha creado un documento Word con las traducciones guardadas de ${translationStatus.completedPages} páginas del original. La precisión de la traducción y la conservación del formato no se han verificado automáticamente.`;
      if (translationStatus) return translationStatus.completedPages < translationStatus.totalPages
        ? `Traducción guardada parcialmente: ${translationStatus.completedPages} de ${translationStatus.totalPages} páginas. Faltan ${translationStatus.totalPages - translationStatus.completedPages}; se puede continuar en esta conversación. Todavía no se ha entregado la traducción completa.`
        : `Se han guardado traducciones de ${translationStatus.totalPages} páginas. El documento final todavía no se ha entregado.`;
      if (!started) return text;
      if (partial) {
        const findings = partialFindings(text);
        return `Revisión parcial solicitada. Cobertura visual suministrada:\n${coverage().documents.map(source => `${JSON.stringify(source.fileName)}: páginas ${source.suppliedPages.join(", ") || "ninguna"} de ${source.pages ?? "total sin verificar"}`).join("\n")}\nNo se acredita una revisión visual completa de los originales.${findings ? `\n\n${findings}` : ""}`;
      }
      return !coverage().complete ? pendingMessage() : text;
    },
    // Reconstruct only successful, image-bearing server tool results from this
    // recovered turn. Arguments, model prose and text-only extraction are not receipts.
    restore(items: readonly unknown[]) {
      for (const item of items) {
        if (!record(item) || item.type !== "dynamicToolCall" || item.namespace !== "aibrain_documents" || item.tool !== "inspect_attachment") continue;
        started = true;
        if (typeof item.id !== "string") continue;
        recoveredCalls.add(item.id);
        calls = Math.max(calls, recoveredCalls.size);
        if (item.success !== true || item.status !== "completed" || !record(item.arguments) || !Array.isArray(item.contentItems) ||
            !item.contentItems.some(value => record(value) && value.type === "inputImage" && typeof value.imageUrl === "string" && value.imageUrl.startsWith("data:image/png;base64,"))) continue;
        if (!recoveredImages.has(item.id)) {
          recoveredImages.add(item.id);
          for (const image of item.contentItems) {
            if (!record(image) || image.type !== "inputImage" || typeof image.imageUrl !== "string" || !image.imageUrl.startsWith("data:image/png;base64,")) continue;
            const encoded = image.imageUrl.slice("data:image/png;base64,".length);
            recoveredImageBytes += Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
          }
          imageBytes = Math.max(imageBytes, recoveredImageBytes);
        }
        if (recoveredImageBytes > 20 * 1024 * 1024) continue;
        if (!item.contentItems.some(value => record(value) && value.type === "inputImage" && typeof value.imageUrl === "string" &&
            value.imageUrl.startsWith("data:image/png;base64,") && isPng(Buffer.from(value.imageUrl.slice("data:image/png;base64,".length), "base64")))) continue;
        const text = item.contentItems.find(value => record(value) && value.type === "inputText");
        try {
          const value: unknown = JSON.parse(text?.text);
          if (!record(value) || value.status !== "attachment_review" || value.fileName !== item.arguments.fileName || value.page !== item.arguments.page) continue;
          const matches = sources.filter(source => source.document.fileName === value.fileName);
          if (matches.length !== 1 || matches[0]!.document.sha256 !== value.sourceSha256 || typeof value.page !== "number" || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 500 ||
              typeof value.pages !== "number" || !Number.isSafeInteger(value.pages) || value.pages < value.page) continue;
          const source = matches[0]!;
          if (source.pages !== null && source.pages !== value.pages) continue;
          source.pages = value.pages;
          source.supplied.add(value.page);
          const image = item.contentItems.find(value => record(value) && value.type === "inputImage" && typeof value.imageUrl === "string" && value.imageUrl.startsWith("data:image/png;base64,") && isPng(Buffer.from(value.imageUrl.slice("data:image/png;base64,".length),"base64")));
          if (record(image) && typeof image.imageUrl === "string") inspected.set(`${source.document.uploadId}:${value.page}`, {page:value.page,pages:value.pages,sourceSha256:source.document.sha256,imageSha256:createHash("sha256").update(Buffer.from(image.imageUrl.slice("data:image/png;base64,".length),"base64")).digest("hex")});
        } catch { /* Missing or corrupt receipts never credit a page. */ }
      }
    },
  });
}

/** Only direct human text can request the larger, still byte-bounded budget. */
export function explicitTranslationRequest(message: string, humanInput = true) {
  if (!humanInput) return false;
  const text = normalizedText(message);
  if (/\b(?:no|not|don['’]?t|sin|sense)\b.{0,35}\b(?:tradu\w*|translat\w*)\b/u.test(text)) return false;
  return /\b(?:tradu\w*|translat\w*)\b/u.test(text);
}

// Narrow, explicit user scope only. Tool arguments and attachment text cannot
// relax the gate; ambiguous or contradictory requests retain the full scope.
export function explicitPartialAttachmentReview(message: string, humanInput = true) {
  if (!humanInput || /(?:^|\n)\s*(?:MAIL_BATCH_JSON|LIVE_[A-Z_]+|RESPONSE_WATCHDOG_BATCH_JSON|SIBEMA_BATCH_JSON)\b/iu.test(message)) return false;
  const text = normalizedText(message);
  if (/\b(?:todas?\s+las\s+paginas|all\s+pages|totes\s+les\s+pagines|revision\s+completa|full\s+review)\b/u.test(text)) return false;
  // A request to translate remains a full-document task even if it begins by
  // inspecting selected pages. A conditional capability question is not an
  // instruction to translate or deliver the original.
  if (/\b(?:traduce(?:lo|la|me)?|traduzcas|tradueix(?:lo|la)?|translate)\b/u.test(text)) return false;
  if (/\b(?:quiero|necesito|vull|necessito)\b.{0,60}\b(?:traducir|traduir|translation|traduccion|traduccio)\b/u.test(text)) return false;
  if (/\b(?:revisa|analiza|lee|inspecciona|review|read|inspect|llegeix|analitza)\s+(?:todo|toda|tot|tota|all|the entire|el documento completo|el document sencer)\b/u.test(text)) return false;
  if (/\b(?:traduccion|traduccio|translation)\s+(?:completa|completo|entera|entero|integral|complete|full)\b/u.test(text)) return false;
  if (/\b(?:revisa|analiza|lee|inspecciona|llegeix|analitza|review|read|inspect)\b.{0,60}\b(?:el resto|la resta|las demas paginas|les altres pagines|the remaining pages|the rest)\b/u.test(text)) return false;
  // Accept a capability question, not a separate translation request hidden
  // after an otherwise partial instruction. Ambiguous translation language
  // stays under the full-review gate.
  const withoutCapabilityQuestion=text.replace(/\b(?:explica|indica|dime|digues|diu|tell me|explain)\s+(?:si|if|whether)\s+(?:pots|podries|puedes|podrias|can|could)(?:\s+you)?\s+(?:traducir|traduir|translate)(?:lo|la|it)?\b/gu," ");
  if (/\b(?:tradu\w*|translat\w*)\b/u.test(withoutCapabilityQuestion)) return false;
  const instruction = text.trim().split("\n")[0]!;
  // Exclude quoted source content before recognizing commands after a QA or
  // search preface. Never infer a request from quoted prose or a code fence.
  const direct = instruction.replace(/```[^`]*```|`[^`]*`|«[^»]*»|“[^”]*”|"[^"\n]*"/gu, match => " ".repeat(match.length));
  if (/^\s*(?:>|```|\{)/u.test(direct)) return false;
  const clauses=direct.split(/(?:[.!?;](?:\s+|$))/u).map(value=>value.trim()).filter(Boolean);
  const scoped = /^(?:(?:por favor|please|si us plau)[,\s]+)?(?:(?:sin|sense|without)\s+[^,;.!?]{1,180},\s*)?(?:si\s+(?:el|lo|la)\s+(?:trobes|encuentras|find)\s*,\s*)?(?:(?:revisa|analiza|lee|resume|inspecciona|mira|review|read|inspect|summarize|llegeix|analitza)\s+(?:(?:visualmente|visualment|visually)\s+)?(?:(?:solo|solamente|unicamente|only|just|nomes)\s+)?(?:(?:la|las|the|les)\s+)?(?:paginas?|pages?|pagines?)\s+\d+\b|(?:solo|solamente|unicamente|only|just|nomes)\s+(?:(?:la|las|the|les)\s+)?(?:paginas?|pages?|pagines?)\s+\d+\b|(?:haz|prepara|realiza|quiero|necesito|prepare|make)\s+(?:(?:una|a|an)\s+)?(?:revision parcial|revisio parcial|partial review)\b)/u;
  return clauses.some(clause=>scoped.test(clause));
}

/** Inspecting one source is not an instruction to review every attached PDF. */
export function explicitFullAttachmentReview(message: string, humanInput = true) {
  if (!humanInput) return false;
  const direct = normalizedText(message.split(/\n\s*(?:MAIL_BATCH_JSON|LIVE_[A-Z_]+|RESPONSE_WATCHDOG_BATCH_JSON|SIBEMA_BATCH_JSON)\b/iu)[0]!)
    .replace(/```[\s\S]*?```|`[^`]*`|«[^»]*»|“[^”]*”|"[^"\n]*"/gu, " ")
    .split("\n").filter(line => !/^\s*(?:>|\{|MAIL_BATCH_JSON|LIVE_[A-Z_]+|RESPONSE_WATCHDOG_BATCH_JSON|SIBEMA_BATCH_JSON)/iu.test(line)).join(" ");
  // Asking whether translation is possible is not asking for a translation.
  const instruction = direct.replace(/\b(?:explica|indica|dime|digues|diu|tell me|explain)\s+(?:si|if|whether)\s+(?:pots|podries|puedes|podrias|can|could)(?:\s+you)?\s+(?:traducir|traduir|translate)(?:lo|la|it)?\b/gu, " ");
  if (explicitTranslationRequest(instruction)) return true;
  const clauses = instruction.split(/[.!?;]\s*/u);
  return clauses.some(clause => {
    if (/\b(?:no|not|don't|no facis)\b.{0,50}\b(?:revis\w*|review|inspect\w*|analiz\w*|lee|llegeix|read)\b/u.test(clause)) return false;
    const action = /\b(?:revisa|revisar|revisio|revision|analiza|inspecciona|llegeix|analitza|review|inspect|read|lee)\b/u.test(clause);
    const whole = /\b(?:(?:todas?|todos?|totes|tots|all|every)\s+(?:(?:las|los|les|els|sus|the|its)\s+)?(?:paginas?|pagines?|pages?|documentos?|documents?|pdfs?|originales?|originals?|adjuntos?|attachments?)|(?:todo|toda|tot|tota|entire|whole)\s+(?:(?:el|la|the)\s+)?(?:documento|document|pdf)|(?:revision|revisio|review)(?:\s+visual)?\s+(?:complet[oa]?|full)|(?:full|complete)(?:\s+visual)?\s+review|el resto|la resta|the rest|remaining pages)\b/u.test(clause);
    if (action && whole) return true;
    // Unqualified document review is full; a focused page/section lookup is not.
    return /\b(?:revisa|analiza|inspecciona|analitza|review|inspect|lee|llegeix|read)\s+(?:(?:visualmente|visualment|visually)\s+)?(?:(?:el|la|los|las|este|esta|estos|estas|the|this|these|el meu|aquest)\s+)?(?:(?:attached|adjunto|adjunta|adjunts?|adjuntes)\s+)?(?:documentos?|documents?|pdfs?|originales?|originals?|adjuntos?|attachments?)\b/u.test(clause) &&
      !/\b(?:paginas?|pagines?|pages?|apartado|seccion|section|posicion|inicio|principio|final|beginning|end)\b/u.test(clause);
  });
}

/** Foreground chat carries an automation-management session too; only the
 * trusted execution mode distinguishes a user's request from background work. */
export function attachmentReviewIntent(message: string, backgroundExecution: boolean) {
  const humanInput = !backgroundExecution;
  return { translationRequested: explicitTranslationRequest(message, humanInput),
    partial: humanInput && (explicitPartialAttachmentReview(message, humanInput) || !explicitFullAttachmentReview(message, humanInput)), required: backgroundExecution };
}
