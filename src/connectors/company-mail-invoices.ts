import { createHash } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import type { ImapFlow, FetchMessageObject } from "imapflow";
import { atomicWriteFile } from "@/storage";
import { readRegularFileWithin } from "@/security/safe-file";
import { safeFileName, validateUploadedDocument } from "@/documents/upload-validation";
import { companyMailAttachmentParts, downloadCompanyMailAttachment, MAX_MAIL_ATTACHMENT_BYTES } from "./company-mail-client";
import { CompanyMailError, type CompanyMailCredential } from "./company-mail-contracts";
import { HetznerMailInvoiceDestination, type MailInvoiceDestination } from "./company-mail-destination";
import { MAIL_HASH, MAIL_UUID, privateMailDirectory } from "./company-mail-store";
import { mailInvoiceReadingContents } from "./company-mail-pdf";

export type InvoiceReviewStatus = "pending" | "reviewed" | "needs_attention" | "ignored";
export type MailInvoiceEntry = {
  id: string; receipt: string; messageKey: string; uid: number; fileName: string; mediaType: string;
  sha256: string | null; size: number; receivedAt: string | null; importedAt: string; updatedAt?: string;
  subject: string; sender: string; status: InvoiceReviewStatus; note: string;
  invoiceNumber: string; supplier: string; amount: string; currency: string;
  duplicateOf: string | null; errorCode: string | null; reviewedAt: string | null; attempts: number; retryAt: string | null;
};
export type MailInvoiceLedger = { schemaVersion: 1; installationId: string; userId: string; projectId: string; mailboxKey: string; processedMessages: string[]; deferredMessages?: Record<string, string>; entries: MailInvoiceEntry[] };
const madridDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
export function mailInvoiceChangesForDay(entries: MailInvoiceEntry[], day: string) {
  return entries.filter(e => [e.importedAt, e.reviewedAt, e.updatedAt].some(value => value && madridDay.format(new Date(value)) === day));
}
export function mailHash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
export function mailboxIdentity(host: string, credential: CompanyMailCredential) { return mailHash(`${host}\0${credential.email}\0${credential.folder}`); }
const LEDGER_LIMIT = 20_000;
const MAX_RUN_ATTACHMENTS = 20;
const SUPPORTED = /\.(?:pdf|png|jpe?g|xlsx|xls)$/iu;
function text(value: unknown, max: number) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, max) : ""; }
function isMissing(error: unknown) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }

export class FileMailInvoiceLedger {
  constructor(readonly root: string, readonly identity: Pick<MailInvoiceLedger, "installationId" | "userId" | "projectId" | "mailboxKey">, readonly destination: MailInvoiceDestination = new HetznerMailInvoiceDestination(root)) {}
  async read(): Promise<MailInvoiceLedger> {
    try {
      const value: unknown = JSON.parse((await readRegularFileWithin(this.root, "ledger.json", 32 * 1024 * 1024)).toString("utf8"));
      if (!value || typeof value !== "object") throw new Error("invalid");
      const v = value as MailInvoiceLedger;
      if (v.schemaVersion !== 1 || Object.entries(this.identity).some(([key, expected]) => v[key as keyof MailInvoiceLedger] !== expected) ||
          !Array.isArray(v.entries) || v.entries.length > LEDGER_LIMIT || !Array.isArray(v.processedMessages) || v.processedMessages.length > LEDGER_LIMIT ||
          !v.processedMessages.every(key => MAIL_HASH.test(key)) ||
          v.deferredMessages !== undefined && (!v.deferredMessages || typeof v.deferredMessages !== "object" || Array.isArray(v.deferredMessages) || Object.keys(v.deferredMessages).length > LEDGER_LIMIT || Object.entries(v.deferredMessages).some(([key, until]) => !MAIL_HASH.test(key) || typeof until !== "string" || !Number.isFinite(Date.parse(until)))) ||
          !v.entries.every(e => e && MAIL_HASH.test(e.id) && MAIL_HASH.test(e.receipt) && MAIL_HASH.test(e.messageKey) &&
            (e.sha256 === null || MAIL_HASH.test(e.sha256)) && Number.isSafeInteger(e.uid) && e.uid > 0 && Number.isSafeInteger(e.size) && e.size >= 0 && e.size <= MAX_MAIL_ATTACHMENT_BYTES &&
            typeof e.fileName === "string" && safeFileName(e.fileName) === e.fileName && typeof e.subject === "string" && typeof e.sender === "string" && typeof e.note === "string" &&
            ["pending", "reviewed", "needs_attention", "ignored"].includes(e.status))) throw new Error("invalid");
      return v;
    } catch (error) {
      if (!isMissing(error)) throw new CompanyMailError("MAIL_LEDGER_CORRUPT", "El registro de importación requiere revisión; no se ha reiniciado.");
      return { schemaVersion: 1, ...this.identity, processedMessages: [], entries: [] };
    }
  }
  async write(ledger: MailInvoiceLedger) {
    if (ledger.entries.length > LEDGER_LIMIT || ledger.processedMessages.length > LEDGER_LIMIT || Object.keys(ledger.deferredMessages ?? {}).length > LEDGER_LIMIT) throw new CompanyMailError("MAIL_LEDGER_LIMIT", "El registro necesita archivarse antes de seguir importando.");
    const encoded = JSON.stringify(ledger);
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new CompanyMailError("MAIL_LEDGER_LIMIT", "El registro necesita archivarse antes de seguir importando.");
    await atomicWriteFile(path.join(this.root, "ledger.json"), encoded, { mode: 0o600 });
  }
  async original(entry: MailInvoiceEntry) {
    if (!entry.sha256 || !MAIL_HASH.test(entry.sha256)) throw new CompanyMailError("MAIL_ORIGINAL_UNAVAILABLE", "Original no disponible.");
    const data = await this.destination.readOriginal(entry.sha256);
    if (mailHash(data) !== entry.sha256 || data.length !== entry.size) throw new CompanyMailError("MAIL_ORIGINAL_CHANGED", "El original no coincide con su registro.");
    return data;
  }
}
export async function invoiceLedgerForMailbox(serverUserRoot: string, identity: FileMailInvoiceLedger["identity"]) {
  if (!MAIL_UUID.test(identity.projectId) || !MAIL_HASH.test(identity.mailboxKey)) throw new CompanyMailError("MAIL_LEDGER_ID_INVALID", "Identidad de importación no válida.");
  const root = await privateMailDirectory(serverUserRoot, ["invoices", identity.projectId, identity.mailboxKey]);
  await privateMailDirectory(root, ["originals"]);
  return new FileMailInvoiceLedger(root, identity);
}

/** Only imports local copies; no Seen, move, deletion or remote writes. Each part
 * has a durable receipt before the next part. A crash resumes unfinished work. */
export async function importCompanyMailInvoices(input: { client: ImapFlow; credential: CompanyMailCredential; store: FileMailInvoiceLedger; signal?: AbortSignal }) {
  const { client, credential, store } = input;
  if (!client.mailbox || !client.mailbox.readOnly) throw new CompanyMailError("MAIL_READONLY_REQUIRED", "El buzón debe abrirse en modo lectura.");
  const epoch = String(client.mailbox.uidValidity);
  if (!/^\d+$/u.test(epoch)) throw new CompanyMailError("MAIL_UIDVALIDITY_REQUIRED", "El servidor no ha identificado la versión del buzón.");
  const ledger = await store.read();
  // SEARCH uses INTERNALDATE, not the sender-controlled Date or unread flag.
  const found = await client.search({ since: new Date(`${credential.since}T00:00:00Z`) }, { uid: true });
  if (!found || !Array.isArray(found) || found.length > 50_000 || found.some(uid => !Number.isSafeInteger(uid) || uid < 1 || uid > 4294967295)) throw new CompanyMailError("MAIL_SEARCH_LIMIT", "Acota la fecha inicial para importar este buzón.");
  const processed = new Set(ledger.processedMessages);
  const now = Date.now();
  const pending = found.toSorted((a, b) => a - b).filter(uid => !processed.has(mailHash(`${epoch}:${uid}`)));
  const deferred = ledger.deferredMessages ??= {};
  const isDeferred = (uid: number) => Date.parse(deferred[mailHash(`${epoch}:${uid}`)] ?? "") > now;
  const eligible = pending.filter(uid => !isDeferred(uid));
  const outputs: MailInvoiceEntry[] = [];
  let attempted = 0;
  let downloadedBytes = 0;
  let messages = 0;
  for (const uid of eligible.slice(0, 100)) {
    if (input.signal?.aborted) throw new CompanyMailError("MAIL_CANCELLED", "Importación cancelada.");
    const messageKey = mailHash(`${epoch}:${uid}`);
    const fetched = await client.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
    if (!fetched || fetched.uid !== uid) continue;
    const message = fetched as FetchMessageObject;
    const parts = companyMailAttachmentParts(message.bodyStructure);
    if (parts.length > 100) throw new CompanyMailError("MAIL_PARTS_LIMIT", "Un correo contiene demasiados adjuntos; revisión manual pendiente.");
    let complete = true;
    let enumerated = true;
    for (const part of parts) {
      if (input.signal?.aborted) throw new CompanyMailError("MAIL_CANCELLED", "Importación cancelada.");
      const receipt = mailHash(`${messageKey}:${part.part}`);
      const existing = ledger.entries.find(e => e.receipt === receipt);
      if (existing && !existing.errorCode) continue;
      if (existing?.retryAt && Date.parse(existing.retryAt) > now) { complete = false; continue; }
      if (attempted >= MAX_RUN_ATTACHMENTS || downloadedBytes >= 64 * 1024 * 1024) { complete = false; enumerated = false; break; }
      attempted += 1;
      const base: MailInvoiceEntry = existing ?? {
        id: receipt, receipt, messageKey, uid, fileName: text(part.name, 120) || "adjunto", mediaType: part.type,
        sha256: null, size: 0, receivedAt: message.internalDate instanceof Date ? message.internalDate.toISOString() : null,
        importedAt: new Date().toISOString(), subject: text(message.envelope?.subject, 500), sender: text(message.envelope?.from?.[0]?.address, 254),
        status: "pending", note: "", invoiceNumber: "", supplier: "", amount: "", currency: "", duplicateOf: null, errorCode: null, reviewedAt: null, attempts: 0, retryAt: null,
      };
      base.attempts += 1;
      base.updatedAt = new Date().toISOString();
      try {
        base.fileName = safeFileName(part.name);
        if (!SUPPORTED.test(part.name)) {
          base.status = "ignored";
          base.note = "Formato fuera del alcance de importación de facturas.";
        } else {
          const data = await downloadCompanyMailAttachment(client, uid, part, bytes => {
            downloadedBytes += bytes;
            if (downloadedBytes > 64 * 1024 * 1024) throw new CompanyMailError("MAIL_RUN_BUDGET", "Límite de descarga por ejecución; continúa en la próxima importación.");
          });
          const genericMime = part.type.toLowerCase() === "application/octet-stream";
          const inferredMime: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
          const suppliedMimeType = part.type.toLowerCase();
          // Some suppliers declare a PDF using the legacy x-pdf alias. Keep the
          // strict extension/signature validator; normalize only this known alias.
          const declaredMimeType = genericMime ? inferredMime[path.extname(part.name).toLowerCase()] ?? part.type
            : suppliedMimeType === "application/x-pdf" ? "application/pdf" : suppliedMimeType;
          const document = validateUploadedDocument({ fileName: part.name, declaredMimeType, data: mailInvoiceReadingContents(data, declaredMimeType) });
          base.sha256 = mailHash(data);
          base.size = data.length;
          base.mediaType = document.mediaType;
          const duplicate = ledger.entries.find(e => e.receipt !== receipt && e.sha256 === base.sha256 && !e.errorCode && !e.duplicateOf);
          base.duplicateOf = duplicate?.id ?? null;
          if (duplicate) { base.status = "ignored"; base.note = "Original repetido por contenido; se conserva una sola copia."; }
          else {
            await store.destination.putOriginal(base.sha256, data);
            base.status = "pending"; base.note = "Adjunto importado, comprobación de factura pendiente.";
            outputs.push(base);
          }
          // A successful retry belongs to today's import, rather than the date
          // of its first failed download. Existing successful receipts skip it.
          base.importedAt = new Date().toISOString();
        }
        base.errorCode = null; base.retryAt = null;
      } catch (error) {
        if (error instanceof CompanyMailError && error.code === "MAIL_RUN_BUDGET") { complete = false; enumerated = false; break; }
        // Preserve an actionable entry and retry the unfinished message next run.
        base.fileName = text(part.name.normalize("NFC").replace(/[\\/]/gu, "_"), 100).replace(/^\.+$/u, "adjunto") || "adjunto";
        base.errorCode = error instanceof CompanyMailError ? error.code : "MAIL_ATTACHMENT_INVALID";
        base.status = "needs_attention"; base.note = "No se pudo importar este adjunto. Revisión o reintento pendiente.";
        base.retryAt = new Date(now + Math.min(24 * 60, 120 * 2 ** Math.min(base.attempts - 1, 4)) * 60_000).toISOString();
        complete = false;
      }
      if (!existing) ledger.entries.push(base);
      await store.write(ledger);
    }
    if (complete) {
      ledger.processedMessages.push(messageKey);
      processed.add(messageKey);
      delete deferred[messageKey];
    } else if (enumerated) {
      // Only back off after every part has been inspected. A partial batch may
      // contain both a failed part and untouched healthy parts beyond the limit.
      const retries = ledger.entries.filter(e => e.messageKey === messageKey && e.errorCode && e.retryAt).map(e => Date.parse(e.retryAt!));
      if (retries.length && retries.every(until => until > now)) deferred[messageKey] = new Date(Math.min(...retries)).toISOString();
      else delete deferred[messageKey];
    } else {
      delete deferred[messageKey];
    }
    await store.write(ledger);
    messages += 1;
    if (attempted >= MAX_RUN_ATTACHMENTS || downloadedBytes >= 64 * 1024 * 1024) break;
  }
  const unfinished = pending.filter(uid => !processed.has(mailHash(`${epoch}:${uid}`)));
  return { ledger, imported: outputs, messagesExamined: messages, remainingMessages: unfinished.filter(uid => !isDeferred(uid)).length,
    deferredMessages: unfinished.filter(isDeferred).length,
    errors: ledger.entries.filter(e => e.errorCode).map(e => ({ id: e.id, fileName: e.fileName, code: e.errorCode })) };
}

export type MailInvoiceReview = { id: string; status: "reviewed" | "needs_attention" | "ignored"; note: string; invoiceNumber: string; supplier: string; amount: string; currency: string };
export function parseMailInvoiceReview(value: unknown): MailInvoiceReview {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "amount,currency,id,invoiceNumber,note,status,supplier") throw new CompanyMailError("MAIL_REVIEW_INVALID", "Datos de revisión no válidos.");
  const v = value as MailInvoiceReview;
  if (!MAIL_HASH.test(v.id) || !["reviewed", "needs_attention", "ignored"].includes(v.status) ||
      typeof v.note !== "string" || !v.note.trim() || v.note.length > 2000 ||
      typeof v.invoiceNumber !== "string" || v.invoiceNumber.length > 150 || typeof v.supplier !== "string" || v.supplier.length > 200 ||
      typeof v.amount !== "string" || !/^(?:|-?\d{1,12}(?:\.\d{1,2})?)$/u.test(v.amount) || typeof v.currency !== "string" || !/^(?:|[A-Z]{3})$/u.test(v.currency)) {
    throw new CompanyMailError("MAIL_REVIEW_INVALID", "Datos de revisión no válidos.");
  }
  return v;
}
export async function recordMailInvoiceReview(store: FileMailInvoiceLedger, review: MailInvoiceReview) {
  const ledger = await store.read();
  const entry = ledger.entries.find(e => e.id === review.id);
  if (!entry || !entry.sha256 || entry.errorCode || entry.duplicateOf) throw new CompanyMailError("MAIL_REVIEW_UNAVAILABLE", "Importa y lee el original antes de registrar una revisión.");
  await store.original(entry);
  const updatedAt = new Date().toISOString();
  Object.assign(entry, review, { reviewedAt: updatedAt, updatedAt });
  await store.write(ledger);
  return entry;
}

function xml(value: string) { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").replace(/[&<>"']/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!); }
/** Inline strings never become formulas, including sender-controlled =/+/@ text. */
export async function mailInvoiceWorkbook(ledger: MailInvoiceLedger) {
  const headers = ["ID", "Archivo", "Recepción", "Importación", "Remitente", "Asunto", "Estado", "Nota", "Proveedor", "Factura", "Importe", "Divisa", "SHA256", "Duplicado de", "Error", "Revisión"];
  const rows = [headers, ...ledger.entries.map(e => [e.id, e.fileName, e.receivedAt ?? "", e.importedAt, e.sender, e.subject, e.status, e.note, e.supplier, e.invoiceNumber, e.amount, e.currency, e.sha256 ?? "", e.duplicateOf ?? "", e.errorCode ?? "", e.reviewedAt ?? ""])];
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Facturas" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  const cells = rows.map((row, i) => `<row r="${i + 1}">${row.map((v, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join("")}</row>`).join("");
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><sheetData>${cells}</sheetData><autoFilter ref="A1:P${rows.length}"/></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
export async function refreshMailInvoiceWorkbook(store: FileMailInvoiceLedger) {
  const ledger = await store.read();
  const contents = await mailInvoiceWorkbook(ledger);
  await store.destination.putWorkbook(contents);
  return { ledger, contents };
}
