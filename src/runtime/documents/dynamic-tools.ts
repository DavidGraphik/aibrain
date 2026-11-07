import { renderPresentationDraft, PresentationRenderError, type PresentationRenderCallback } from "@/runtime/documents/presentation-render";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { DynamicToolCallParams } from "../../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "../../../contracts/codex/0.162.1/types/v2/DynamicToolCallResponse";
import type { InstallationConfig } from "@/config/installation-schema";
import type { DocumentArtifact } from "@/lib/chat-contract";
import type { ResolvedPermissions } from "@/permissions";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { resourceLocationIndexForInstallation } from "@/library/server-resource-access";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import {
  generateLocalDocument,
  normalizeDocumentSlides,
  LocalDocumentGenerationError,
  type LocalDocumentSlide,
  isLocalDocumentFormula,
  type LocalDocumentCell,
  type LocalDocumentFormat,
} from "@/runtime/documents/local-document-generator";
import { generatedDocumentArtifactId, persistGeneratedDocumentArtifact } from "@/runtime/generated-document-artifacts";
import { generatedImageArtifactId, isPng } from "@/runtime/generated-image-artifacts";
import type { ArnallSchedule } from "@/runtime/documents/arnall-schedule";
import { reviewFictionalArnallSchedule } from "@/runtime/documents/fictional-arnall-schedule";
import { AttachmentReviewError, type AttachmentPageReview } from "@/runtime/documents/attachment-review";
import { TranslationProgress, TranslationProgressError, verifyTranslatedDocx, type InspectedPage } from "@/runtime/documents/translation-progress";

import { AIBRAIN_DOCUMENT_TOOL_NAMESPACE } from "./dynamic-tool-contract";
export { AIBRAIN_DOCUMENT_TOOL_NAMESPACE, DOCUMENT_DYNAMIC_TOOLS } from "./dynamic-tool-contract";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FILE_NAME_PATTERN = /^[^/\\\0\r\n]{1,160}$/u;
const FORMATS = ["pdf", "docx", "pptx", "xlsx"] as const;

export class LocalDocumentDynamicToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalDocumentDynamicToolError";
  }
}

type CreateArguments = Readonly<{
  format: LocalDocumentFormat;
  fileName: string;
  title: string;
  content: string;
  rows?: readonly (readonly LocalDocumentCell[])[];
  slides?: readonly LocalDocumentSlide[];
  sourceImageItemId?: string;
}>;

type Receipt = Readonly<{
  schemaVersion: 1;
  installationId: string;
  userId: string;
  projectId: string;
  runtimeThreadId: string;
  runtimeTurnId: string;
  callId: string;
  inputFingerprint: string;
  relativePath: string;
  format: LocalDocumentFormat;
  mimeType: string;
  size: number;
  sha256: string;
  pages: number | null;
  createdAt: string;
}>;

type BatchReceipt = Readonly<{
  schemaVersion: 1;
  kind: "document_batch";
  installationId: string;
  userId: string;
  projectId: string;
  runtimeThreadId: string;
  runtimeTurnId: string;
  callId: string;
  inputFingerprint: string;
  childCallIds: readonly string[];
  status: "started" | "completed";
  createdAt: string;
}>;

export type LocalDocumentDynamicToolResult = Readonly<{
  response: DynamicToolCallResponse;
  artifacts: readonly DocumentArtifact[];
}>;

export type LocalDocumentDynamicToolContext = Readonly<{
  installation: Pick<InstallationConfig, "installationId" | "paths"> & { companySlug?: string };
  installationId: string;
  userId: string;
  projectId: string;
  projectWorkspace: string;
  receiptRoot: string;
  runtimeThreadId: string;
  runtimeTurnId: string;
  sourceThreadId: string;
  sourceTurnId: string;
  permissions: ResolvedPermissions;
  rememberProjectFile?: (fileName: string) => Promise<Record<string, unknown>>;
  rememberProjectPreferences?: (notes: string) => Promise<Record<string, unknown>>;
  renderPresentation?: PresentationRenderCallback;
  inspectAttachment?: (fileName: string, page: number) => Promise<AttachmentPageReview>;
  assertAttachmentReviewComplete?: () => void;
  attachmentReviewCoverage?: () => import("@/runtime/documents/attachment-review").AttachmentReviewCoverage;
  attachmentReviewNotice?: () => string;
  translationSource?: (fileName: string) => Promise<{uploadId:string;sourceSha256:string;pages:number}>;
  translationInspection?: (fileName: string, page: number) => InspectedPage;
  translationNotice?: (status: {uploadId:string;completedPages:number;totalPages:number;delivered:boolean}) => void;
  spreadsheetLayout?: "schedule";
  arnallSchedule?: ArnallSchedule;
  now?: () => Date;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value);
  if (required.some((key) => !(key in value)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Document tool fields are invalid.");
  }
}

function parseRows(value: unknown): readonly (readonly LocalDocumentCell[])[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Spreadsheet rows are invalid.");
  }
  return value.map((row) => {
    if (!Array.isArray(row) || row.length === 0 || row.length > 100) {
      throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Spreadsheet row width is invalid.");
    }
    return row.map((cell) => {
      if (cell !== null && typeof cell !== "string" && typeof cell !== "number" && typeof cell !== "boolean" && !isLocalDocumentFormula(cell)) {
        throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Spreadsheet cell is invalid.");
      }
      return cell as LocalDocumentCell;
    });
  });
}

function parseArguments(value: unknown): CreateArguments {
  if (!isRecord(value)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Document arguments must be an object.");
  exactKeys(value, ["format", "fileName", "title", "content"], ["rows", "slides"]);
  if (typeof value.format !== "string" || !FORMATS.includes(value.format as LocalDocumentFormat) ||
      typeof value.fileName !== "string" || !FILE_NAME_PATTERN.test(value.fileName) || value.fileName === "." || value.fileName === ".." ||
      typeof value.title !== "string" || typeof value.content !== "string") {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Document arguments are invalid.");
  }
  const format = value.format as LocalDocumentFormat;
  if (path.extname(value.fileName).toLocaleLowerCase() !== `.${format}`) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_EXTENSION_MISMATCH", "File name extension does not match the requested format.");
  }
  return {
    format,
    fileName: value.fileName.normalize("NFC"),
    title: value.title,
    content: value.content,
    rows: parseRows(value.rows),
    ...(value.slides === undefined ? {} : { slides: normalizeDocumentSlides(value.slides) }),
  };
}

function parseFictionalArnallSchedule(value: unknown): { input: CreateArguments; schedule: ArnallSchedule; review: ReturnType<typeof reviewFictionalArnallSchedule> } {
  if (!isRecord(value)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Faltan los datos del horario ficticio.");
  exactKeys(value, ["fileName", "establishmentName", "week", "people"]);
  if (typeof value.fileName !== "string" || !FILE_NAME_PATTERN.test(value.fileName) ||
      path.extname(value.fileName).toLocaleLowerCase() !== ".xlsx" ||
      typeof value.establishmentName !== "string" || typeof value.week !== "string" ||
      !Array.isArray(value.people) || value.people.length < 1 || value.people.length > 43) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Los datos del horario ficticio no son válidos.");
  }
  const people = value.people.map((person: unknown, index: number) => {
    if (!isRecord(person)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Persona ficticia no válida.");
    exactKeys(person, ["name", "section", "codeHours", "days"], ["maxWeeklyHours"]);
    if (!isRecord(person.codeHours)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Horas ficticias no válidas.");
    exactKeys(person.codeHours, ["M", "T", "D"]);
    if (typeof person.name !== "string" || !["DEPENDIENTA", "ELABORACION"].includes(String(person.section)) ||
        [person.codeHours.M, person.codeHours.T, person.codeHours.D].some((hours) => typeof hours !== "number" || !Number.isFinite(hours))) {
      throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Persona u horas ficticias no válidas.");
    }
    if (!Array.isArray(person.days) || person.days.length !== 7) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Semana ficticia no válida.");
    for (const day of person.days) if (day !== null) {
      if (!isRecord(day)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Turno ficticio no válido.");
      exactKeys(day, ["code", "firstLine", "secondLine"], ["requested"]);
      if (typeof day.code !== "string" || typeof day.firstLine !== "string" || typeof day.secondLine !== "string") {
        throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Turno ficticio no válido.");
      }
    }
    return { ...person, id: index + 1 };
  });
  const schedule = { establishmentId: 1, establishmentName: value.establishmentName, week: value.week, people } as unknown as ArnallSchedule;
  let review: ReturnType<typeof reviewFictionalArnallSchedule>;
  try { review = reviewFictionalArnallSchedule(schedule); }
  catch (error) { throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_SCHEDULE_INVALID", error instanceof Error ? error.message : "Horario ficticio no válido."); }
  const input = parseArguments({ format: "xlsx", fileName: value.fileName, title: `Simulación de horario ${value.week}`, content: "Simulación ficticia no guardada ni aprobada.", rows: [["Persona", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom", "Horas"]] });
  return { input, schedule, review };
}

function parseImageToPdfArguments(value: unknown): CreateArguments {
  if (!isRecord(value)) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Image PDF arguments must be an object.");
  }
  exactKeys(value, ["sourceImageItemId", "fileName", "title"]);
  if (typeof value.sourceImageItemId !== "string" || !OPAQUE_ID_PATTERN.test(value.sourceImageItemId) ||
      typeof value.fileName !== "string" || !FILE_NAME_PATTERN.test(value.fileName) || value.fileName === "." || value.fileName === ".." ||
      path.extname(value.fileName).toLocaleLowerCase() !== ".pdf" || typeof value.title !== "string") {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Image PDF arguments are invalid.");
  }
  return {
    format: "pdf",
    fileName: value.fileName.normalize("NFC"),
    title: value.title,
    content: "",
    sourceImageItemId: value.sourceImageItemId,
  };
}

function parseBatchArguments(value: unknown) {
  if (!isRecord(value)) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Document batch arguments must be an object.");
  }
  exactKeys(value, ["files"]);
  if (!Array.isArray(value.files) || value.files.length < 2 || value.files.length > 8) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Document batch must contain between two and eight files.");
  }
  const files = value.files.map(parseArguments);
  const names = files.map(({ fileName }) => fileName.toLocaleLowerCase());
  if (new Set(names).size !== names.length) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Document batch file names must be unique.");
  }
  return files;
}

function permissionAllowsLocalDocumentCreation(permissions: ResolvedPermissions) {
  const rules = permissions.rules.filter((rule) => rule.ruleId === "tools.execute" && rule.action === "execute");
  if (rules.some((rule) => rule.effect === "deny")) return false;
  return rules.some((rule) => rule.effect === "allow");
}

function canonicalInput(input: CreateArguments) {
  return JSON.stringify({
    format: input.format,
    fileName: input.fileName,
    title: input.title,
    content: input.content,
    rows: input.rows ?? null,
    ...(input.slides === undefined ? {} : { slides: input.slides }),
    sourceImageItemId: input.sourceImageItemId ?? null,
  });
}

function canonicalBatchInput(files: readonly CreateArguments[]) {
  return JSON.stringify(files.map((file) => JSON.parse(canonicalInput(file)) as unknown));
}

function receiptNameFor(callId: string) {
  return `${createHash("sha256").update(callId).digest("hex")}.json`;
}

async function artifactFromReceipt(receipt: Receipt, context: LocalDocumentDynamicToolContext): Promise<DocumentArtifact> {
  const contents = await readRegularFileWithin(context.projectWorkspace, receipt.relativePath, 20_000_000);
  return persistGeneratedDocumentArtifact({
    artifactId: generatedDocumentArtifactId(context.sourceTurnId, receipt.relativePath),
    relativePath: receipt.relativePath,
    contents,
    pages: receipt.pages,
    context: {
      installation: context.installation,
      projectId: context.projectId,
      threadId: context.sourceThreadId,
      messageId: context.sourceTurnId,
      storageOwnerId: context.userId,
    },
  });
}

function responseFor(receipt: Receipt, fictionalReview?: ReturnType<typeof reviewFictionalArnallSchedule>, coverage?: import("@/runtime/documents/attachment-review").AttachmentReviewCoverage): DynamicToolCallResponse {
  return {
    success: true,
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({
        status: "created",
        storage: "local-private-workspace",
        externalConnectorUsed: false,
        fileName: path.basename(receipt.relativePath),
        format: receipt.format,
        mimeType: receipt.mimeType,
        size: receipt.size,
        sha256: receipt.sha256,
        pages: receipt.pages,
        previewAvailable: true,
        downloadAvailable: true,
        ...(fictionalReview ? { review: fictionalReview } : {}),
        ...(coverage?.started ? { attachmentReview: coverage } : {}),
      }),
    }],
  };
}

function failure(
  code: string,
  message: string,
  status: "failed" | "indeterminate" = "failed",
  coverage?: import("@/runtime/documents/attachment-review").AttachmentReviewCoverage,
): LocalDocumentDynamicToolResult {
  return {
    response: {
      success: false,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({ status, code, message, externalConnectorUsed: false, ...(coverage ? { coverage } : {}) }),
      }],
    },
    artifacts: [],
  };
}

function receiptValue(value: unknown): Receipt {
  if (!isRecord(value)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_RECEIPT_INVALID", "Document receipt is invalid.");
  exactKeys(value, [
    "schemaVersion", "installationId", "userId", "projectId", "runtimeThreadId", "runtimeTurnId", "callId",
    "inputFingerprint", "relativePath", "format", "mimeType", "size", "sha256", "pages", "createdAt",
  ]);
  if (value.schemaVersion !== 1 || typeof value.installationId !== "string" || typeof value.userId !== "string" ||
      typeof value.projectId !== "string" || typeof value.runtimeThreadId !== "string" || typeof value.runtimeTurnId !== "string" ||
      typeof value.callId !== "string" || typeof value.inputFingerprint !== "string" || typeof value.relativePath !== "string" ||
      typeof value.format !== "string" || !FORMATS.includes(value.format as LocalDocumentFormat) || typeof value.mimeType !== "string" ||
      typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 64 || typeof value.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.sha256) || (value.pages !== null && (!Number.isSafeInteger(value.pages) || (value.pages as number) < 1)) ||
      typeof value.createdAt !== "string" || Number.isNaN(new Date(value.createdAt).valueOf())) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_RECEIPT_INVALID", "Document receipt fields are invalid.");
  }
  return value as Receipt;
}

function batchReceiptValue(value: unknown): BatchReceipt {
  if (!isRecord(value)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_RECEIPT_INVALID", "Document batch receipt is invalid.");
  exactKeys(value, [
    "schemaVersion", "kind", "installationId", "userId", "projectId", "runtimeThreadId", "runtimeTurnId", "callId",
    "inputFingerprint", "childCallIds", "status", "createdAt",
  ]);
  if (value.schemaVersion !== 1 || value.kind !== "document_batch" || typeof value.installationId !== "string" ||
      typeof value.userId !== "string" || typeof value.projectId !== "string" || typeof value.runtimeThreadId !== "string" ||
      typeof value.runtimeTurnId !== "string" || typeof value.callId !== "string" || typeof value.inputFingerprint !== "string" ||
      !Array.isArray(value.childCallIds) || value.childCallIds.length < 2 || value.childCallIds.length > 8 ||
      value.childCallIds.some((callId) => typeof callId !== "string" || !OPAQUE_ID_PATTERN.test(callId)) ||
      (value.status !== "started" && value.status !== "completed") || typeof value.createdAt !== "string" ||
      Number.isNaN(new Date(value.createdAt).valueOf())) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_RECEIPT_INVALID", "Document batch receipt fields are invalid.");
  }
  return value as unknown as BatchReceipt;
}

async function secureDirectory(workspace: string) {
  const canonicalWorkspace = await realpath(workspace);
  const documents = path.join(workspace, "documents");
  await mkdir(documents, { recursive: true, mode: 0o700 });
  const metadata = await lstat(documents);
  const canonicalDocuments = await realpath(documents);
  const relative = path.relative(canonicalWorkspace, canonicalDocuments);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_PATH_UNSAFE", "Private document directory is unsafe.");
  }
  return documents;
}

async function sourcePngFor(input: CreateArguments, context: LocalDocumentDynamicToolContext) {
  const sourceImageItemId = input.sourceImageItemId;
  if (!sourceImageItemId) return undefined;
  try {
    const index = resourceLocationIndexForInstallation(context.installation);
    const matches = (await index.listForProjects(new Set([context.projectId]), "generated-image"))
      .filter((candidate) => candidate.threadId === context.sourceThreadId &&
        candidate.storageOwnerId === context.userId && candidate.messageId !== null &&
        generatedImageArtifactId(candidate.messageId, sourceImageItemId) === candidate.resourceId);
    // App Server item ids are opaque. Re-deriving each indexed artifact id
    // from its original assistant message preserves that opacity while making
    // same-thread references survive later turns. Ambiguity fails closed.
    if (matches.length !== 1) throw new Error("Generated image reference is missing or ambiguous.");
    const location = matches[0]!;
    const artifactId = location.resourceId;
    const expectedPath = `generated-image-artifacts/${artifactId}.png`;
    if (location.mediaType !== "image/png" || location.relativePath !== expectedPath ||
        !/^[^/\\\u0000-\u001f\u007f]+\.png$/u.test(location.fileName)) {
      throw new Error("Generated image binding mismatch.");
    }
    const contents = await readRegularFileWithin(context.installation.paths.dataRoot, expectedPath, 20_000_000);
    if (contents.byteLength !== location.size ||
        createHash("sha256").update(contents).digest("hex") !== location.sha256 || !isPng(contents)) {
      throw new Error("Generated image integrity mismatch.");
    }
    const validated = validateUploadedDocument({
      fileName: location.fileName,
      declaredMimeType: location.mediaType,
      data: contents,
    });
    if (validated.kind !== "image" || validated.mediaType !== "image/png") {
      throw new Error("Generated image is not a PNG.");
    }
    return contents;
  } catch {
    throw new LocalDocumentDynamicToolError(
      "LOCAL_DOCUMENT_SOURCE_IMAGE_INVALID",
      "No se ha podido localizar y verificar la imagen PNG generada en esta conversación.",
    );
  }
}

async function availableTarget(documents: string, fileName: string) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const name = suffix === 0 ? fileName : `${stem}-${suffix + 1}${extension}`;
    const target = path.join(documents, name);
    try {
      await lstat(target);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return { name, target };
      throw error;
    }
  }
  throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_NAME_EXHAUSTED", "No safe file name is available.");
}

async function readReceipt(filePath: string) {
  try {
    return receiptValue(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readBatchReceipt(filePath: string) {
  try {
    return batchReceiptValue(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function verifyReceipt(receipt: Receipt, inputFingerprint: string, context: LocalDocumentDynamicToolContext) {
  if (receipt.installationId !== context.installationId || receipt.userId !== context.userId || receipt.projectId !== context.projectId ||
      receipt.runtimeThreadId !== context.runtimeThreadId || receipt.runtimeTurnId !== context.runtimeTurnId || receipt.inputFingerprint !== inputFingerprint) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_RECEIPT_CONFLICT", "Document call receipt does not match this authenticated turn.");
  }
  const contents = await readRegularFileWithin(context.projectWorkspace, receipt.relativePath, 20_000_000);
  if (contents.length !== receipt.size || createHash("sha256").update(contents).digest("hex") !== receipt.sha256) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_RECEIPT_CORRUPT", "Previously created document no longer matches its receipt.");
  }
  validateUploadedDocument({ fileName: path.basename(receipt.relativePath), declaredMimeType: receipt.mimeType, data: contents });
}

function verifyBatchReceipt(
  receipt: BatchReceipt,
  inputFingerprint: string,
  childCallIds: readonly string[],
  context: LocalDocumentDynamicToolContext,
) {
  if (receipt.installationId !== context.installationId || receipt.userId !== context.userId ||
      receipt.projectId !== context.projectId || receipt.runtimeThreadId !== context.runtimeThreadId ||
      receipt.runtimeTurnId !== context.runtimeTurnId || receipt.inputFingerprint !== inputFingerprint ||
      receipt.childCallIds.length !== childCallIds.length ||
      receipt.childCallIds.some((callId, index) => callId !== childCallIds[index])) {
    throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_RECEIPT_CONFLICT", "Document batch call receipt does not match this authenticated turn.");
  }
}

function batchResult(results: readonly LocalDocumentDynamicToolResult[]): LocalDocumentDynamicToolResult {
  const artifacts = results.flatMap(({ artifacts: created }) => created);
  const payloads = results.map(({ response }) => responsePayload(response));
  const successful = results.every(({ response }) => response.success);
  return {
    response: {
      success: successful,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify(successful ? {
          status: "created",
          storage: "local-private-workspace",
          externalConnectorUsed: false,
          files: payloads,
        } : {
          status: "indeterminate",
          code: "LOCAL_DOCUMENT_BATCH_INCOMPLETE",
          message: "No se han podido confirmar todos los documentos. No se repetirá automáticamente ninguna creación.",
          externalConnectorUsed: false,
          files: payloads,
        }),
      }],
    },
    artifacts,
  };
}

async function completedBatchResult(
  files: readonly CreateArguments[],
  childCallIds: readonly string[],
  context: LocalDocumentDynamicToolContext,
) {
  const results: LocalDocumentDynamicToolResult[] = [];
  for (const [index, file] of files.entries()) {
    const callId = childCallIds[index];
    const receipt = await readReceipt(path.join(context.receiptRoot, receiptNameFor(callId)));
    if (!receipt || receipt.callId !== callId) {
      throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_RECEIPT_CORRUPT", "Completed document batch is missing a child receipt.");
    }
    await verifyReceipt(receipt, createHash("sha256").update(canonicalInput(file)).digest("hex"), context);
    results.push({ response: responseFor(receipt, undefined, context.attachmentReviewCoverage?.()), artifacts: [await artifactFromReceipt(receipt, context)] });
  }
  return batchResult(results);
}

async function handleSingleLocalDocumentDynamicToolCall(
  params: DynamicToolCallParams,
  context: LocalDocumentDynamicToolContext,
): Promise<LocalDocumentDynamicToolResult> {
  try {
    if (!isRecord(params)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_REQUEST_INVALID", "Document tool request is invalid.");
    exactKeys(params, ["threadId", "turnId", "callId", "namespace", "tool", "arguments"]);
    if (params.namespace !== AIBRAIN_DOCUMENT_TOOL_NAMESPACE || !["remember_preferences","remember","create","create_arnall_schedule","image_to_pdf","render","deliver","inspect_attachment","translation_status","translation_get_page","translation_save_page","translation_finish"].includes(params.tool)) {
      throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_TOOL_REJECTED", "Document tool is not in the closed allowlist.");
    }
    for (const value of [params.threadId, params.turnId, params.callId]) {
      if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
        throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_REQUEST_INVALID", "Document tool identity is invalid.");
      }
    }
    if (context.installation.installationId !== context.installationId ||
        !UUID_PATTERN.test(context.userId) || !UUID_PATTERN.test(context.projectId) ||
        !UUID_PATTERN.test(context.sourceThreadId) || !UUID_PATTERN.test(context.sourceTurnId) ||
        params.threadId !== context.runtimeThreadId || params.turnId !== context.runtimeTurnId ||
        context.permissions.installationId !== context.installationId || context.permissions.userId !== context.userId ||
        context.permissions.projectId !== context.projectId) {
      throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_IDENTITY_MISMATCH", "Document tool call does not belong to this turn.");
    }
    if (params.tool === "inspect_attachment") {
      const rules = context.permissions.rules.filter(rule => rule.ruleId === "documents.read" && rule.action === "consult");
      if (rules.some(rule => rule.effect === "deny") || !rules.some(rule => rule.effect === "allow"))
        return failure("LOCAL_DOCUMENT_PERMISSION_DENIED", "La política de este usuario no permite leer los adjuntos.");
      if (!isRecord(params.arguments)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Selecciona un adjunto y una página.");
      exactKeys(params.arguments,["fileName","page"]);
      const {fileName,page}=params.arguments;
      if (typeof fileName !== "string" || !fileName.length || fileName.length > 500 ||
          typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > 500 || !context.inspectAttachment)
        throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Selecciona un PDF original de este turno y una página entre 1 y 500.");
      const {png,...review}=await context.inspectAttachment(fileName,page);
      return {artifacts:[],response:{success:true,contentItems:[
        {type:"inputText",text:JSON.stringify({status:"attachment_review",...review})},
        {type:"inputImage",imageUrl:`data:image/png;base64,${png.toString("base64")}`},
      ]}};
    }
    if (!permissionAllowsLocalDocumentCreation(context.permissions)) {
      return failure("LOCAL_DOCUMENT_PERMISSION_DENIED", "La política de este usuario no permite crear archivos locales.");
    }
    if (["translation_status","translation_get_page","translation_save_page","translation_finish"].includes(params.tool)) {
      const rules=context.permissions.rules.filter(rule=>rule.ruleId==="documents.read" && rule.action==="consult");
      if(rules.some(rule=>rule.effect==="deny") || !rules.some(rule=>rule.effect==="allow")) return failure("LOCAL_DOCUMENT_PERMISSION_DENIED","La política de este usuario no permite leer los adjuntos.");
      if (!isRecord(params.arguments)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID","Faltan los datos del documento.");
      const expected=params.tool==="translation_save_page"?["fileName","targetLanguage","page","translation"]:params.tool==="translation_get_page"?["fileName","targetLanguage","page"]:params.tool==="translation_finish"?["fileName","targetLanguage","outputFileName"]:["fileName","targetLanguage"];
      exactKeys(params.arguments,expected,params.tool==="translation_save_page"?["expectedTranslationSha256"]:[]);
      const {fileName,targetLanguage,page,translation,outputFileName,expectedTranslationSha256}=params.arguments;
      if(typeof fileName!=="string" || !FILE_NAME_PATTERN.test(fileName) || typeof targetLanguage!=="string" || !context.translationSource || !context.translationNotice)
        throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID","Selecciona el PDF original de este turno y el idioma de destino.");
      const original=await context.translationSource(fileName);
      const progress=new TranslationProgress(path.dirname(context.receiptRoot),{installationId:context.installationId,userId:context.userId,threadId:context.sourceThreadId,...original,targetLanguage});
      const current=await progress.status();
      context.translationNotice({uploadId:original.uploadId,completedPages:current.savedPages.length,totalPages:current.totalPages,delivered:false});
      if(params.tool==="translation_save_page") {
        if(typeof page!=="number" || !Number.isSafeInteger(page) || typeof translation!=="string" || (expectedTranslationSha256!==undefined && (typeof expectedTranslationSha256!=="string" || !/^[a-f0-9]{64}$/u.test(expectedTranslationSha256))) || !context.translationInspection)
          throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID","Falta la página inspeccionada o su traducción.");
        const coverage=await progress.save(context.translationInspection(fileName,page),translation,expectedTranslationSha256 as string|undefined);
        context.translationNotice({uploadId:original.uploadId,completedPages:coverage.savedPages.length,totalPages:coverage.totalPages,delivered:false});
        return {artifacts:[],response:{success:true,contentItems:[{type:"inputText",text:JSON.stringify({status:"translation_page_saved",coverage})}]}};
      }
      if(params.tool==="translation_status") {
        return {artifacts:[],response:{success:true,contentItems:[{type:"inputText",text:JSON.stringify({status:"translation_progress",coverage:current})}]}};
      }
      if(params.tool==="translation_get_page") {
        if(typeof page!=="number" || !Number.isSafeInteger(page)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID","Selecciona una página válida.");
        const saved=await progress.page(page);
        return {artifacts:[],response:{success:true,contentItems:[{type:"inputText",text:JSON.stringify({status:"translation_page",untrustedData:true,...saved})}]}};
      }
      if(typeof outputFileName!=="string" || !FILE_NAME_PATTERN.test(outputFileName) || !/\.docx$/iu.test(outputFileName))
        throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID","El nombre del Word debe terminar en .docx.");
      const assembled=await progress.assemble();
      const title=`Traducción: ${fileName}`;
      const generated=await generateLocalDocument({format:"docx",title,content:assembled.text,verbatim:true});
      await verifyTranslatedDocx(generated.data,title,assembled.text);
      validateUploadedDocument({fileName:outputFileName,declaredMimeType:generated.mimeType,data:generated.data});
      const rechecked=await context.translationSource(fileName);
      if(rechecked.uploadId!==original.uploadId || rechecked.sourceSha256!==original.sourceSha256 || rechecked.pages!==original.pages)
        throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_VERIFY_FAILED","El original o sus permisos han cambiado; no se ha entregado la traducción.");
      const artifactId=generatedDocumentArtifactId(context.sourceThreadId,`translation/${assembled.sourceSha256}/${assembled.targetLanguage}/${assembled.contentSha256}/${outputFileName}`);
      const locks=new ResourceLockManager({rootDirectory:path.join(path.dirname(context.receiptRoot),"document-translation-delivery-locks")});
      const artifact=await locks.withLock(`translation-delivery:${artifactId}`,async()=>{
        const index=resourceLocationIndexForInstallation(context.installation);
        const existing=await index.binding("generated-document",artifactId);
        if(!existing) return persistGeneratedDocumentArtifact({artifactId,relativePath:outputFileName,contents:generated.data,pages:null,
          context:{installation:context.installation,projectId:context.projectId,threadId:context.sourceThreadId,messageId:context.sourceTurnId,storageOwnerId:context.userId}});
        const relativePath=`generated-document-artifacts/${context.userId}/${artifactId}/${outputFileName}`;
        if(existing.storageOwnerId!==context.userId || existing.projectId!==context.projectId || existing.threadId!==context.sourceThreadId ||
          existing.relativePath!==relativePath || existing.fileName!==outputFileName || existing.size!==generated.data.length || existing.sha256!==generated.sha256 || existing.mediaType!==generated.mimeType ||
          !(await readRegularFileWithin(context.installation.paths.dataRoot,relativePath,20_000_000)).equals(generated.data))
          throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_VERIFY_FAILED","El documento anterior no supera la comprobación de integridad.");
        const route=`/api/threads/${context.sourceThreadId}/artifacts/${artifactId}`;
        return {id:artifactId,type:"document" as const,name:outputFileName,url:`${route}?download=1`,kind:"docx" as const,mimeType:generated.mimeType,size:generated.data.length,status:"ready" as const,pages:null,previewUrl:`${route}?preview=1`,publicationStatus:null,publicationError:null,targetLabel:null,error:null};
      });
      context.translationNotice({uploadId:original.uploadId,completedPages:assembled.coverage.savedPages.length,totalPages:assembled.coverage.totalPages,delivered:true});
      return {artifacts:[artifact],response:{success:true,contentItems:[{type:"inputText",text:JSON.stringify({status:"translation_delivered",artifact,sourceSha256:assembled.sourceSha256,contentSha256:assembled.contentSha256,coverage:assembled.coverage,layoutPreserved:false,semanticAccuracyIndependentlyVerified:false})}]}};
    }
    if (params.tool === "remember_preferences") {
      if (!isRecord(params.arguments)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Preference fields are invalid.");
      exactKeys(params.arguments, ["notes"]);
      if (typeof params.arguments.notes !== "string" || !context.rememberProjectPreferences) return failure("PROJECT_PREFERENCES_UNAVAILABLE", "No se pueden guardar los criterios de este proyecto.");
      try {
        const receipt = await context.rememberProjectPreferences(params.arguments.notes);
        return { artifacts: [], response: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(receipt) }] } };
      } catch (error) { return failure("PROJECT_PREFERENCES_NOT_SAVED", error instanceof Error && !/(?:\/var\/|\/Users\/|ENOENT)/.test(error.message) ? error.message : "No se han podido guardar los criterios. No está confirmado."); }
    }
    if (params.tool === "remember") {
      if (!isRecord(params.arguments)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Reference fields are invalid.");
      exactKeys(params.arguments, ["fileName"]);
      if (typeof params.arguments.fileName !== "string" || !FILE_NAME_PATTERN.test(params.arguments.fileName) || !context.rememberProjectFile) return failure("PROJECT_REFERENCE_UNAVAILABLE", "No se puede guardar esta referencia en el proyecto.");
      try {
        const receipt = await context.rememberProjectFile(params.arguments.fileName);
        return { artifacts: [], response: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(receipt) }] } };
      } catch (error) { return failure("PROJECT_REFERENCE_NOT_SAVED", error instanceof Error && !/(?:\/var\/|\/Users\/|ENOENT)/.test(error.message) ? error.message : "No se ha podido guardar el original como referencia. No está confirmado."); }
    }
    if (params.tool !== "render") context.assertAttachmentReviewComplete?.();
    if (params.tool === "deliver") {
      if (!isRecord(params.arguments)) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Delivery fields are invalid.");
      exactKeys(params.arguments, ["relativePath"]);
      const relativePath = params.arguments.relativePath;
      if (typeof relativePath !== "string" || relativePath.length > 1024 ||
          !/^documents\/.+\.(pdf|pptx|docx|xlsx)$/u.test(relativePath) ||
          /[\\\0\r\n]/u.test(relativePath) || relativePath.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment === ".aibrain-drafts")) {
        throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_ARGUMENTS_INVALID", "Delivery requires a final project-relative document under documents/.");
      }
      // Reject linked components before the bounded safe-file read; the worker
      // cannot choose an owner, root, conversation or external destination.
      let current = context.projectWorkspace;
      if (await realpath(current) !== current) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_SOURCE_INVALID", "Delivery workspace is unsafe.");
      for (const segment of relativePath.split("/")) {
        current = path.join(current, segment);
        if ((await lstat(current)).isSymbolicLink()) throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_SOURCE_INVALID", "Delivery source may not contain symbolic links.");
      }
      const contents = await readRegularFileWithin(context.projectWorkspace, relativePath, 50 * 1024 * 1024);
      const fileName = path.basename(relativePath);
      const format = path.extname(relativePath).slice(1) as LocalDocumentFormat;
      const mimeTypes: Record<LocalDocumentFormat, string> = {
        pdf: "application/pdf",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
      const validated = validateUploadedDocument({ fileName, declaredMimeType: mimeTypes[format], data: contents });
      const artifact = await persistGeneratedDocumentArtifact({
        artifactId: generatedDocumentArtifactId(context.sourceTurnId, relativePath), relativePath, contents, pages: null,
        context: { installation: context.installation, projectId: context.projectId, threadId: context.sourceThreadId, messageId: context.sourceTurnId, storageOwnerId: context.userId },
      });
      const attachmentCoverage = context.attachmentReviewCoverage?.();
      return { artifacts: [artifact], response: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({
        status: "delivered", artifact, sha256: validated.sha256, externalConnectorUsed: false,
        ...(attachmentCoverage?.started ? { attachmentReview: attachmentCoverage } : {}),
      }) }] } };
    }
    if (params.tool === "render") {
      const { png, ...review } = await renderPresentationDraft(params.arguments, context.projectWorkspace, context.renderPresentation);
      return { artifacts: [], response: { success: true, contentItems: [
        { type: "inputText", text: JSON.stringify({ status: "review", ...review }) },
        { type: "inputImage", imageUrl: `data:image/png;base64,${png.toString("base64")}` },
      ] } };
    }
    if (params.tool === "create_arnall_schedule" && context.installation.companySlug !== "arnall") {
      throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_TOOL_REJECTED", "Esta plantilla solo está disponible en Arnall.");
    }
    const fictional = params.tool === "create_arnall_schedule" ? parseFictionalArnallSchedule(params.arguments) : null;
    const input = fictional?.input ?? (params.tool === "image_to_pdf" ? parseImageToPdfArguments(params.arguments) : parseArguments(params.arguments));
    const reviewCoverage = context.attachmentReviewCoverage?.();
    const reviewNotice = reviewCoverage?.started && reviewCoverage.scope === "partial" ? context.attachmentReviewNotice?.() : undefined;
    const spreadsheetLayout = fictional ? "schedule" : context.spreadsheetLayout;
    const arnallSchedule = fictional?.schedule ?? context.arnallSchedule;
    const inputFingerprint = createHash("sha256").update(canonicalInput(input) + (spreadsheetLayout ? `|layout:${spreadsheetLayout}` : "") + (arnallSchedule ? `|arnall-schedule-v2-original-formulas:${JSON.stringify(arnallSchedule)}` : "")).digest("hex");
    const receiptName = receiptNameFor(params.callId);
    const receiptPath = path.join(context.receiptRoot, receiptName);
    await mkdir(context.receiptRoot, { recursive: true, mode: 0o700 });
    const claimPath = path.join(context.receiptRoot, `${receiptName}.claim`);
    let claimed = false;
    try {
      await mkdir(claimPath, { mode: 0o700 });
      claimed = true;
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      const existing = await readReceipt(receiptPath);
      if (!existing) {
        return failure(
          "LOCAL_DOCUMENT_CALL_INDETERMINATE",
          "La creación de este documento ya está en curso o quedó en un estado incierto; no se repetirá automáticamente.",
          "indeterminate",
        );
      }
      await verifyReceipt(existing, inputFingerprint, context);
      return { response: responseFor(existing, fictional?.review, reviewCoverage), artifacts: [await artifactFromReceipt(existing, context)] };
    }
    try {
      const existing = await readReceipt(receiptPath);
      if (existing) {
        await verifyReceipt(existing, inputFingerprint, context);
        return { response: responseFor(existing, fictional?.review, reviewCoverage), artifacts: [await artifactFromReceipt(existing, context)] };
      }
      const documents = await secureDirectory(context.projectWorkspace);
      const sourcePng = await sourcePngFor(input, context);
      const generated = await generateLocalDocument({
        format: input.format,
        title: input.title,
        content: reviewNotice ? `${reviewNotice}\n\n${input.content}` : input.content,
        rows: input.rows,
        spreadsheetLayout,
        arnallSchedule,
        slides: input.slides,
        sourcePng,
      });
      validateUploadedDocument({ fileName: input.fileName, declaredMimeType: generated.mimeType, data: generated.data });
      const selected = await availableTarget(documents, input.fileName);
      let written = false;
      try {
        // This runtime-owned, ACL-validated workspace path must not make the
        // production bundler trace the repository as a build-time asset.
        const handle = await open(/* turbopackIgnore: true */ selected.target, "wx", 0o600);
        try {
          await handle.writeFile(generated.data);
          await handle.sync();
          written = true;
        } finally {
          await handle.close();
        }
        const relativePath = path.posix.join("documents", selected.name);
        const verified = await readRegularFileWithin(context.projectWorkspace, relativePath, 20_000_000);
        const verifiedDocument = validateUploadedDocument({ fileName: selected.name, declaredMimeType: generated.mimeType, data: verified });
        if (verified.length !== generated.data.length || verifiedDocument.sha256 !== generated.sha256) {
          throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_VERIFY_FAILED", "Created document failed server readback.");
        }
        const receipt: Receipt = Object.freeze({
          schemaVersion: 1,
          installationId: context.installationId,
          userId: context.userId,
          projectId: context.projectId,
          runtimeThreadId: context.runtimeThreadId,
          runtimeTurnId: context.runtimeTurnId,
          callId: params.callId,
          inputFingerprint,
          relativePath,
          format: generated.format,
          mimeType: generated.mimeType,
          size: verified.length,
          sha256: generated.sha256,
          pages: generated.pages,
          createdAt: (context.now ?? (() => new Date()))().toISOString(),
        });
        await atomicWriteFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
        return { response: responseFor(receipt, fictional?.review, reviewCoverage), artifacts: [await artifactFromReceipt(receipt, context)] };
      } catch (error) {
        if (written) await rm(selected.target, { force: true }).catch(() => undefined);
        throw error;
      }
    } finally {
      if (claimed) await rm(claimPath, { recursive: true, force: false }).catch(() => undefined);
    }
  } catch (error) {
    return error instanceof LocalDocumentDynamicToolError || error instanceof LocalDocumentGenerationError || error instanceof PresentationRenderError || error instanceof AttachmentReviewError || error instanceof TranslationProgressError
      ? failure(error.code, error.message, "failed", error instanceof AttachmentReviewError ? error.coverage : undefined)
      : params.tool === "inspect_attachment" ? failure("ATTACHMENT_REVIEW_FAILED", "No se ha podido revisar esta página del adjunto; su contenido sigue sin verificar.")
      : failure("LOCAL_DOCUMENT_GENERATION_FAILED", "No se ha podido crear y verificar el documento local.");
  }
}

function responsePayload(response: DynamicToolCallResponse) {
  const text = response.contentItems.find((item) => item.type === "inputText")?.text;
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function handleLocalDocumentDynamicToolCall(
  params: DynamicToolCallParams,
  context: LocalDocumentDynamicToolContext,
): Promise<LocalDocumentDynamicToolResult> {
  if (!isRecord(params) || params.tool !== "create_batch") {
    return handleSingleLocalDocumentDynamicToolCall(params, context);
  }
  try {
    exactKeys(params, ["threadId", "turnId", "callId", "namespace", "tool", "arguments"]);
    if (params.namespace !== AIBRAIN_DOCUMENT_TOOL_NAMESPACE) {
      throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_TOOL_REJECTED", "Document tool is not in the closed allowlist.");
    }
    for (const value of [params.threadId, params.turnId, params.callId]) {
      if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
        throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_REQUEST_INVALID", "Document tool identity is invalid.");
      }
    }
    if (context.installation.installationId !== context.installationId ||
        !UUID_PATTERN.test(context.userId) || !UUID_PATTERN.test(context.projectId) ||
        !UUID_PATTERN.test(context.sourceThreadId) ||
        !UUID_PATTERN.test(context.sourceTurnId) || params.threadId !== context.runtimeThreadId ||
        params.turnId !== context.runtimeTurnId || context.permissions.installationId !== context.installationId ||
        context.permissions.userId !== context.userId || context.permissions.projectId !== context.projectId) {
      throw new LocalDocumentDynamicToolError("LOCAL_DOCUMENT_IDENTITY_MISMATCH", "Document tool call does not belong to this turn.");
    }
    if (!permissionAllowsLocalDocumentCreation(context.permissions)) {
      return failure("LOCAL_DOCUMENT_PERMISSION_DENIED", "La política de este usuario no permite crear archivos locales.");
    }
    const files = parseBatchArguments(params.arguments);
    context.assertAttachmentReviewComplete?.();
    const inputFingerprint = createHash("sha256").update(canonicalBatchInput(files)).digest("hex");
    const childCallIds = files.map((_, index) =>
      `batch-${createHash("sha256").update(`${params.callId}\0${index}`).digest("hex").slice(0, 48)}`);
    await mkdir(context.receiptRoot, { recursive: true, mode: 0o700 });
    const receiptPath = path.join(context.receiptRoot, receiptNameFor(params.callId));
    const claimPath = `${receiptPath}.claim`;
    let claimed = false;
    try {
      try {
        await mkdir(claimPath, { mode: 0o700 });
        claimed = true;
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
        const existing = await readBatchReceipt(receiptPath);
        if (!existing) {
          return failure(
            "LOCAL_DOCUMENT_CALL_INDETERMINATE",
            "La creación del lote ya está en curso o quedó en un estado incierto; no se repetirá automáticamente.",
            "indeterminate",
          );
        }
        verifyBatchReceipt(existing, inputFingerprint, childCallIds, context);
        return existing.status === "completed"
          ? completedBatchResult(files, childCallIds, context)
          : failure("LOCAL_DOCUMENT_CALL_INDETERMINATE", "El lote quedó en un estado incierto; no se repetirá automáticamente.", "indeterminate");
      }

      const existing = await readBatchReceipt(receiptPath);
      if (existing) {
        verifyBatchReceipt(existing, inputFingerprint, childCallIds, context);
        return existing.status === "completed"
          ? completedBatchResult(files, childCallIds, context)
          : failure("LOCAL_DOCUMENT_CALL_INDETERMINATE", "El lote quedó en un estado incierto; no se repetirá automáticamente.", "indeterminate");
      }

      const started: BatchReceipt = Object.freeze({
        schemaVersion: 1,
        kind: "document_batch",
        installationId: context.installationId,
        userId: context.userId,
        projectId: context.projectId,
        runtimeThreadId: context.runtimeThreadId,
        runtimeTurnId: context.runtimeTurnId,
        callId: params.callId,
        inputFingerprint,
        childCallIds,
        status: "started",
        createdAt: (context.now ?? (() => new Date()))().toISOString(),
      });
      await atomicWriteFile(receiptPath, `${JSON.stringify(started, null, 2)}\n`, { mode: 0o600 });

      const results: LocalDocumentDynamicToolResult[] = [];
      for (const [index, file] of files.entries()) {
        results.push(await handleSingleLocalDocumentDynamicToolCall({
          ...params,
          callId: childCallIds[index],
          tool: "create",
          arguments: {
            ...file,
            rows: file.rows?.map((row) => [...row]),
            slides: file.slides?.map((slide) => ({ ...slide })),
          },
        }, context));
      }
      if (results.every(({ response }) => response.success)) {
        await atomicWriteFile(receiptPath, `${JSON.stringify({ ...started, status: "completed" }, null, 2)}\n`, { mode: 0o600 });
      }
      return batchResult(results);
    } finally {
      if (claimed) await rm(claimPath, { recursive: true, force: false }).catch(() => undefined);
    }
  } catch (error) {
    return error instanceof LocalDocumentDynamicToolError || error instanceof LocalDocumentGenerationError || error instanceof AttachmentReviewError
      ? failure(error.code, error.message, "failed", error instanceof AttachmentReviewError ? error.coverage : undefined)
      : failure("LOCAL_DOCUMENT_GENERATION_FAILED", "No se ha podido crear y verificar el lote documental local.");
  }
}
