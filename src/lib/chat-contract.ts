import { MAX_FILES_PER_MESSAGE } from "@/lib/chat-attachment-limits";
import { isServerReferenceList, type ServerReference } from "@/documents/server-reference-contract";
import type { RuntimeReasoningEffort } from "@/lib/runtime-status";
import type { ComposerExperience } from "@/lib/composer-experience";
import { validPublicReferences } from "@/lib/public-references";

export type ActivityKind =
  | "system"
  | "reasoning"
  | "plan"
  | "command"
  | "file"
  | "tool"
  | "web"
  | "agent";

export type ActivityStatus =
  | "pending"
  | "running"
  | "waiting"
  | "complete"
  | "failed"
  | "stopped";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  output?: string;
  files?: ActivityFileChange[];
  /** Monotonic display order within one assistant message, not a replay cursor. */
  sequence?: number;
  status: ActivityStatus;
};

export type ActivityFileChange = {
  path: string;
  change: "add" | "update" | "delete";
};

export type TurnSourceKind = "web" | "file" | "app";

/** A source observed in runtime metadata. Null fields are deliberately honest. */
export type TurnSource = {
  id: string;
  kind: TurnSourceKind;
  title: string;
  url: string | null;
  domain: string | null;
  snippet: string | null;
  publishedAt: string | null;
};

export type ToolResultKind = "command" | "file" | "web" | "app" | "browser";

export type ToolResult = {
  id: string;
  kind: ToolResultKind;
  title: string;
  status: "running" | "complete" | "failed" | "stopped";
  summary: string | null;
  output: string | null;
  sourceIds: string[];
  createdAt: string;
  /** Monotonic display order within one assistant message, not a replay cursor. */
  sequence?: number;
  /** Server-observed record references; optional for older persisted results. */
  publicReferences?: string[];
};

export type PlanStep = {
  step: string;
  status: "pending" | "in_progress" | "completed";
};

export type ApprovalDecision = "accept" | "acceptForSession" | "decline";

export type ComposerMode = "agent" | "plan" | "ask";

export type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

export type ChatInputAttachment = ChatAttachment & {
  dataUrl: string;
};

export type ImageArtifact = {
  id: string;
  type: "image";
  name: string;
  url: string;
  prompt: string | null;
  /** Intrinsic PNG dimensions, omitted by older persisted messages. */
  width?: number;
  height?: number;
};

export type DocumentKind = "docx" | "xlsx" | "xls" | "pptx" | "pdf" | "text";
export type PublicationStatus = "awaiting_confirmation" | "publishing" | "published" | "declined" | "conflict";

export type DocumentArtifact = {
  id: string;
  type: "document";
  name: string;
  url: string;
  kind: DocumentKind;
  mimeType: string;
  size: number;
  status: "processing" | "ready" | "error";
  pages: number | null;
  previewUrl: string | null;
  previewFormat?: "spreadsheet";
  publicationStatus: PublicationStatus | null;
  publicationError: string | null;
  targetLabel: string | null;
  error: string | null;
  /** Set by authenticated server read adapters, never copied from provider/model JSON. */
  provenance?: "source-read";
};

export type BrowserArtifact = {
  id: string;
  type: "browser";
  name: string;
  status: "starting" | "ready" | "active" | "reconnecting" | "disconnected" | "closed" | "error";
  control: "agent" | "employee" | "awaiting_approval" | null;
  viewerUrl: string | null;
  captureUrl: string | null;
  downloadUrl: string | null;
  error: string | null;
};

export type GeneratedArtifact = ImageArtifact | DocumentArtifact | BrowserArtifact;

export type TurnOptions = {
  mode: ComposerMode;
  /** Employee-facing product choice. Provider settings are resolved server-side. */
  experience?: ComposerExperience | "fast";
  model: string | null;
  effort: RuntimeReasoningEffort | null;
  autoApprove?: boolean;
  webSearch: boolean;
  imageGeneration: boolean;
  skill: string | null;
  /** Server-owned scheduled turns may request every currently authorized
   * managed skill. Browser clients can only request this boolean; catalog and
   * user policy are still revalidated by the server. */
  inheritAuthorizedSkills?: boolean;
  /** Catalog resource IDs selected through the @ connector autocomplete. */
  connectorMentions?: string[];
  attachments: ChatInputAttachment[];
  documentUploadIds?: string[];
  serverReferences?: ServerReference[];
};

export type ApprovalItem = {
  id: string;
  threadId: string;
  turnId: string;
  itemId: string;
  kind: "command" | "file" | "browser";
  title: string;
  detail: string;
  fileReview?: { filename: string; changes: Array<{ before: string; after: string }> };
  command?: string;
  cwd?: string;
  permissionFingerprint?: string;
  connectorAuthorizationFingerprint?: string;
  authorizationFingerprint?: string;
  status: "pending" | "accepted" | "accepted_session" | "declined";
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** Server-observed elapsed time from request admission to terminal event. */
  durationMs?: number;
  status: "complete" | "streaming" | "error" | "stopped";
  activity: ActivityItem[];
  plan: PlanStep[];
  approvals: ApprovalItem[];
  diff: string;
  attachments: ChatAttachment[];
  connectorMentions?: string[];
  serverReferences?: ServerReference[];
  artifacts: GeneratedArtifact[];
  /** Optional while schema-v1 conversations are migrated on read. */
  sources?: TurnSource[];
  /** Optional while schema-v1 conversations are migrated on read. */
  toolResults?: ToolResult[];
};

export type ChatRequest = {
  projectId: string;
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  message: string;
  displayMessage?: string;
  preferences: {
    tone: "direct" | "balanced" | "detailed";
    language: "ca" | "es" | "en";
    showActivity: boolean;
  };
  options: TurnOptions;
};

export type ApprovalResolutionRequest = {
  approvalId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  decision: ApprovalDecision;
};

/** Connector resolution is always bound to the authorization fingerprint. */
export type ConnectorApprovalResolutionRequest = {
  approvalId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  decision: "accept" | "decline" | "cancel" | "acceptForSession";
  authorizationFingerprint: string;
};

export function approvalResolutionForItem(item: ApprovalItem, decision: ApprovalDecision): ApprovalResolutionRequest | ConnectorApprovalResolutionRequest {
  const routing = { approvalId: item.id, threadId: item.threadId, turnId: item.turnId, itemId: item.itemId, decision };
  if (item.connectorAuthorizationFingerprint && item.authorizationFingerprint && item.connectorAuthorizationFingerprint !== item.authorizationFingerprint) {
    throw new Error("Conflicting connector authorization fingerprints.");
  }
  const fingerprint = item.connectorAuthorizationFingerprint ?? item.authorizationFingerprint;
  return fingerprint ? { ...routing, authorizationFingerprint: fingerprint } : routing;
}

export type TurnControlRequest =
  | {
      action: "stop";
      threadId: string;
      assistantMessageId: string;
      clientRequestId: string;
    }
  | {
      action: "steer";
      threadId: string;
      assistantMessageId: string;
      clientRequestId: string;
      userMessageId: string;
      message: string;
    };

export type ChatStreamEvent =
  | { type: "snapshot"; message: ChatMessage }
  | { type: "content"; value: string }
  | { type: "activity"; item: ActivityItem }
  | { type: "plan"; explanation: string | null; steps: PlanStep[] }
  | { type: "approval"; item: ApprovalItem }
  | { type: "diff"; value: string }
  | { type: "delta"; value: string }
  | { type: "artifact"; item: GeneratedArtifact }
  | { type: "source"; item: TurnSource }
  | { type: "toolResult"; item: ToolResult }
  | { type: "done"; durationMs?: number }
  | { type: "stopped"; durationMs?: number }
  | { type: "error"; message: string; durationMs?: number };

type ChatStreamProjectionMetadata = {
  sequence?: number;
  terminalDurationMs?: number;
};

/** Adds public ordering and duration metadata before live and durable projection. */
export function projectChatStreamEvent(
  event: ChatStreamEvent,
  metadata: ChatStreamProjectionMetadata,
): ChatStreamEvent {
  const sequence = metadata.sequence;
  if (event.type === "activity" && sequence !== undefined) {
    return { ...event, item: { ...event.item, sequence: event.item.sequence ?? sequence } };
  }
  if (event.type === "toolResult" && sequence !== undefined) {
    return { ...event, item: { ...event.item, sequence: event.item.sequence ?? sequence } };
  }
  if ((event.type === "done" || event.type === "stopped" || event.type === "error") &&
      metadata.terminalDurationMs !== undefined) {
    return { ...event, durationMs: event.durationMs ?? metadata.terminalDurationMs };
  }
  return event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function hasOptionalString(value: Record<string, unknown>, key: string) {
  return !(key in value) || value[key] === undefined || typeof value[key] === "string";
}

function isOpaqueRuntimeId(value: unknown) {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function isUuidString(value: unknown) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isIsoDate(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isSafeNullableText(value: unknown, maximum: number) {
  return value === null || (
    typeof value === "string" && value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

export function isTurnSource(value: unknown): value is TurnSource {
  if (!isRecord(value)) return false;
  const url = value.url;
  let validUrl = url === null;
  if (typeof url === "string" && url.length <= 2_048) {
    try {
      const parsed = new URL(url);
      validUrl = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      validUrl = false;
    }
  }
  return typeof value.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.id) &&
    (value.kind === "web" || value.kind === "file" || value.kind === "app") &&
    typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 240 &&
    !/\p{C}/u.test(value.title) && validUrl &&
    isSafeNullableText(value.domain, 255) &&
    isSafeNullableText(value.snippet, 2_000) &&
    (value.publishedAt === null || isIsoDate(value.publishedAt));
}

export function isToolResult(value: unknown): value is ToolResult {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.id) &&
    (value.kind === "command" || value.kind === "file" || value.kind === "web" ||
      value.kind === "app" || value.kind === "browser") &&
    typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 240 &&
    !/\p{C}/u.test(value.title) &&
    (value.status === "running" || value.status === "complete" || value.status === "failed" || value.status === "stopped") &&
    isSafeNullableText(value.summary, 4_000) &&
    isSafeNullableText(value.output, 64_000) &&
    Array.isArray(value.sourceIds) && value.sourceIds.length <= 100 &&
    value.sourceIds.every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) &&
    new Set(value.sourceIds).size === value.sourceIds.length &&
    (value.publicReferences === undefined || validPublicReferences(value.publicReferences)
      && (value.publicReferences.length === 0 || value.kind === "app" && value.status === "complete")) &&
    (!("sequence" in value) || value.sequence === undefined ||
      (Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0)) &&
    isIsoDate(value.createdAt);
}

export function isChatAttachment(value: unknown): value is ChatAttachment {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(value.id) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    value.name.length <= 120 &&
    typeof value.mimeType === "string" &&
    /^(?:audio\/ogg|image\/(?:png|jpeg|webp|gif)|application\/(?:pdf|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.(?:sheet|template)|presentationml\.presentation))|text\/(?:plain|markdown|csv)|application\/json)$/.test(value.mimeType) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    value.size <= 50 * 1024 * 1024
  );
}

export function isChatInputAttachment(value: unknown): value is ChatInputAttachment {
  if (!isRecord(value) || !isChatAttachment(value)) return false;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(value.mimeType) || value.size > 2_000_000) return false;
  const dataUrl = (value as Record<string, unknown>).dataUrl;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(`data:${value.mimeType};base64,`) ||
      dataUrl.length > 2_700_000) return false;
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return false;
  }
  if (binary.length !== value.size) return false;
  const byte = (index: number) => binary.charCodeAt(index);
  if (value.mimeType === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((expected, index) => byte(index) === expected);
  }
  if (value.mimeType === "image/jpeg") return byte(0) === 0xff && byte(1) === 0xd8 && byte(binary.length - 2) === 0xff && byte(binary.length - 1) === 0xd9;
  if (value.mimeType === "image/gif") return binary.startsWith("GIF87a") || binary.startsWith("GIF89a");
  return binary.startsWith("RIFF") && binary.slice(8, 12) === "WEBP";
}

export function isTurnOptions(value: unknown): value is TurnOptions {
  if (!isRecord(value)) return false;
  const documentUploadIds = value.documentUploadIds;
  const connectorMentions = value.connectorMentions;
  const validDocumentUploadIds = documentUploadIds === undefined || (
    Array.isArray(documentUploadIds) && documentUploadIds.length <= MAX_FILES_PER_MESSAGE &&
    documentUploadIds.every((uploadId) => typeof uploadId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uploadId)) &&
    new Set(documentUploadIds).size === documentUploadIds.length
  );
  return (
    (value.mode === "agent" || value.mode === "plan" || value.mode === "ask") &&
    (value.experience === undefined || value.experience === "fast" || value.experience === "smart" || value.experience === "expert") &&
    (value.model === null || (typeof value.model === "string" && value.model.length <= 100)) &&
    (value.effort === null || value.effort === "none" || value.effort === "minimal" ||
      value.effort === "low" || value.effort === "medium" || value.effort === "high" ||
      value.effort === "xhigh" || value.effort === "max" || value.effort === "ultra") &&
    (value.autoApprove === undefined || typeof value.autoApprove === "boolean") &&
    typeof value.webSearch === "boolean" &&
    typeof value.imageGeneration === "boolean" &&
    (value.skill === null || (typeof value.skill === "string" && value.skill.length <= 100)) &&
    (value.inheritAuthorizedSkills === undefined || typeof value.inheritAuthorizedSkills === "boolean") &&
    (connectorMentions === undefined || (
      Array.isArray(connectorMentions) && connectorMentions.length <= 20 &&
      connectorMentions.every((id) => typeof id === "string" && /^[a-z][a-z0-9]*(?:[-.:][a-z0-9]+)*$/.test(id)) &&
      new Set(connectorMentions).size === connectorMentions.length
    )) &&
    Array.isArray(value.attachments) &&
    value.attachments.length <= MAX_FILES_PER_MESSAGE &&
    value.attachments.every(isChatInputAttachment) &&
    value.attachments.reduce((total, attachment) => total + attachment.size, 0) <= 5_000_000 &&
    validDocumentUploadIds &&
    value.attachments.length + (Array.isArray(documentUploadIds) ? documentUploadIds.length : 0) <= MAX_FILES_PER_MESSAGE &&
    (value.serverReferences === undefined || isServerReferenceList(value.serverReferences))
  );
}

export function isGeneratedArtifact(value: unknown): value is GeneratedArtifact {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id) ||
    typeof value.name !== "string" || !value.name.trim() || value.name.length > 120) return false;
  if (value.type === "image") {
    return /^[^/\\\u0000-\u001f\u007f]+\.png$/u.test(value.name) &&
      typeof value.url === "string" &&
      new RegExp(`^/api/projects/[0-9a-f-]{36}/artifacts/${value.id}$`, "iu").test(value.url) &&
      (value.prompt === null || typeof value.prompt === "string") &&
      ((value.width === undefined && value.height === undefined) ||
        (Number.isSafeInteger(value.width) && Number(value.width) >= 1 && Number(value.width) <= 8192 &&
          Number.isSafeInteger(value.height) && Number(value.height) >= 1 && Number(value.height) <= 8192));
  }
  if (value.type === "document") {
    return (value.provenance === undefined || value.provenance === "source-read") &&
      typeof value.url === "string" && (value.url.startsWith("/api/projects/") || value.url.startsWith("/api/threads/")) &&
      (value.kind === "docx" || value.kind === "xlsx" || value.kind === "xls" || value.kind === "pptx" || value.kind === "pdf" || value.kind === "text") &&
      typeof value.mimeType === "string" && value.mimeType.length <= 180 &&
      typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 50 * 1024 * 1024 &&
      (value.status === "processing" || value.status === "ready" || value.status === "error") &&
      (value.pages === null || (typeof value.pages === "number" && Number.isSafeInteger(value.pages) && value.pages >= 1 && value.pages <= 500)) &&
      (value.previewUrl === null || (typeof value.previewUrl === "string" &&
        (value.previewUrl.startsWith("/api/projects/") || value.previewUrl.startsWith("/api/threads/")))) &&
      (value.previewFormat === undefined || (value.previewFormat === "spreadsheet" && value.kind === "text" && value.mimeType === "application/json")) &&
      (value.publicationStatus === null || value.publicationStatus === "awaiting_confirmation" || value.publicationStatus === "publishing" || value.publicationStatus === "published" || value.publicationStatus === "declined" || value.publicationStatus === "conflict") &&
      (value.publicationError === null || (typeof value.publicationError === "string" && value.publicationError.length <= 500)) &&
      (value.targetLabel === null || (typeof value.targetLabel === "string" && value.targetLabel.length <= 160)) &&
      (value.error === null || (typeof value.error === "string" && value.error.length <= 500));
  }
  if (value.type === "browser") {
    return (value.status === "starting" || value.status === "ready" || value.status === "active" || value.status === "reconnecting" || value.status === "disconnected" || value.status === "closed" || value.status === "error") &&
      (value.control === null || value.control === "agent" || value.control === "employee" || value.control === "awaiting_approval") &&
      (value.viewerUrl === null || (typeof value.viewerUrl === "string" && value.viewerUrl.startsWith("/api/browser/sessions/"))) &&
      (value.captureUrl === null || (typeof value.captureUrl === "string" && value.captureUrl.startsWith("/api/browser/sessions/"))) &&
      (value.downloadUrl === null || (typeof value.downloadUrl === "string" && value.downloadUrl.startsWith("/api/browser/sessions/"))) &&
      (value.error === null || (typeof value.error === "string" && value.error.length <= 500));
  }
  return false;
}

export function isActivityItem(value: unknown): value is ActivityItem {
  if (!isRecord(value)) return false;
  const validFiles = !("files" in value) || value.files === undefined || (
    value.kind === "file" &&
    Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 100 && value.files.every((file) =>
      isRecord(file) &&
      typeof file.path === "string" &&
      file.path.length > 0 &&
      file.path.length <= 2_048 &&
      !file.path.includes("\0") &&
      (file.change === "add" || file.change === "update" || file.change === "delete")
    )
  );
  return (
    typeof value.id === "string" &&
    (value.kind === "system" ||
      value.kind === "reasoning" ||
      value.kind === "plan" ||
      value.kind === "command" ||
      value.kind === "file" ||
      value.kind === "tool" ||
      value.kind === "web" ||
      value.kind === "agent") &&
    typeof value.label === "string" &&
    hasOptionalString(value, "detail") &&
    hasOptionalString(value, "output") &&
    (!("sequence" in value) || value.sequence === undefined ||
      (Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0)) &&
    validFiles &&
    (value.status === "pending" ||
      value.status === "running" ||
      value.status === "waiting" ||
      value.status === "complete" ||
      value.status === "failed" ||
      value.status === "stopped")
  );
}

export function isPlanStep(value: unknown): value is PlanStep {
  if (!isRecord(value)) return false;
  return (
    typeof value.step === "string" &&
    (value.status === "pending" ||
      value.status === "in_progress" ||
      value.status === "completed")
  );
}

export function isApprovalItem(value: unknown): value is ApprovalItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    isOpaqueRuntimeId(value.id) &&
    isOpaqueRuntimeId(value.threadId) &&
    isOpaqueRuntimeId(value.turnId) &&
    isOpaqueRuntimeId(value.itemId) &&
    (value.kind === "command" || value.kind === "file" || value.kind === "browser") &&
    typeof value.title === "string" &&
    typeof value.detail === "string" &&
    (!("fileReview" in value) || value.fileReview === undefined ||
      (isRecord(value.fileReview) && typeof value.fileReview.filename === "string" && value.fileReview.filename.length > 0 && value.fileReview.filename.length <= 180 &&
        Array.isArray(value.fileReview.changes) && value.fileReview.changes.length > 0 && value.fileReview.changes.length <= 40 &&
        value.fileReview.changes.every((change) => isRecord(change) && typeof change.before === "string" && typeof change.after === "string") &&
        value.fileReview.changes.reduce((length, change) => length + (change as { before: string; after: string }).before.length + (change as { before: string; after: string }).after.length, 0) <= 32_000)) &&
    hasOptionalString(value, "command") &&
    hasOptionalString(value, "cwd") &&
    (!("permissionFingerprint" in value) || value.permissionFingerprint === undefined ||
      (typeof value.permissionFingerprint === "string" && /^[0-9a-f]{64}$/u.test(value.permissionFingerprint))) &&
    (!("connectorAuthorizationFingerprint" in value) || value.connectorAuthorizationFingerprint === undefined ||
      (typeof value.connectorAuthorizationFingerprint === "string" && /^[0-9a-f]{64}$/u.test(value.connectorAuthorizationFingerprint))) &&
    (!("authorizationFingerprint" in value) || value.authorizationFingerprint === undefined ||
      (typeof value.authorizationFingerprint === "string" && /^[0-9a-f]{64}$/u.test(value.authorizationFingerprint))) &&
    (!value.connectorAuthorizationFingerprint || !value.authorizationFingerprint || value.connectorAuthorizationFingerprint === value.authorizationFingerprint) &&
    (value.status === "pending" ||
      value.status === "accepted" ||
      value.status === "accepted_session" ||
      value.status === "declined")
  );
}

export function isApprovalResolutionRequest(
  value: unknown,
): value is ApprovalResolutionRequest {
  if (!isRecord(value)) return false;
  return (
    isOpaqueRuntimeId(value.approvalId) &&
    isOpaqueRuntimeId(value.threadId) &&
    isOpaqueRuntimeId(value.turnId) &&
    isOpaqueRuntimeId(value.itemId) &&
    (value.decision === "accept" ||
      value.decision === "acceptForSession" ||
      value.decision === "decline")
  );
}

export function isConnectorApprovalResolutionRequest(
  value: unknown,
): value is ConnectorApprovalResolutionRequest {
  if (!isRecord(value) || Object.keys(value).length !== 6) return false;
  return (
    isOpaqueRuntimeId(value.approvalId) &&
    isOpaqueRuntimeId(value.threadId) &&
    isOpaqueRuntimeId(value.turnId) &&
    isOpaqueRuntimeId(value.itemId) &&
    (value.decision === "accept" ||
      value.decision === "decline" ||
      value.decision === "cancel" ||
      value.decision === "acceptForSession") &&
    typeof value.authorizationFingerprint === "string" &&
    /^[0-9a-f]{64}$/u.test(value.authorizationFingerprint)
  );
}

export function isTurnControlRequest(value: unknown): value is TurnControlRequest {
  if (!isRecord(value)) return false;
  const common =
    isUuidString(value.threadId) &&
    isUuidString(value.assistantMessageId) &&
    isUuidString(value.clientRequestId);
  if (!common) return false;
  if (value.action === "stop") {
    return Object.keys(value).length === 4;
  }
  if (value.action === "steer") {
    return Object.keys(value).length === 6 &&
      isUuidString(value.userMessageId) &&
      typeof value.message === "string" &&
      value.message.trim().length > 0 &&
      value.message.length <= 32_000 &&
      !value.message.includes("\0");
  }
  return false;
}

export function isChatStreamEvent(value: unknown): value is ChatStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  const validDuration = !("durationMs" in value) || value.durationMs === undefined ||
    (Number.isSafeInteger(value.durationMs) && Number(value.durationMs) >= 0);
  if (value.type === "done" || value.type === "stopped") return validDuration;
  if (value.type === "snapshot") return isChatMessage(value.message);
  if (value.type === "delta" || value.type === "diff" || value.type === "content") {
    return typeof value.value === "string";
  }
  if (value.type === "error") return typeof value.message === "string" && validDuration;
  if (value.type === "artifact") return isGeneratedArtifact(value.item);
  if (value.type === "source") return isTurnSource(value.item);
  if (value.type === "toolResult") return isToolResult(value.item);
  if (value.type === "activity") return isActivityItem(value.item);
  if (value.type === "approval") return isApprovalItem(value.item);
  if (value.type === "plan") {
    return (
      (value.explanation === null || typeof value.explanation === "string") &&
      Array.isArray(value.steps) &&
      value.steps.every(isPlanStep)
    );
  }

  return false;
}

export function isChatMessage(message: unknown): message is ChatMessage {
  if (!isRecord(message)) return false;
  if (typeof message.id !== "string") return false;
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (typeof message.content !== "string") return false;
  if (typeof message.createdAt !== "string") return false;
  if (message.durationMs !== undefined &&
      (typeof message.durationMs !== "number" ||
        !Number.isSafeInteger(message.durationMs) || message.durationMs < 0)) return false;
  if (
    message.status !== "complete" &&
    message.status !== "streaming" &&
    message.status !== "error" &&
    message.status !== "stopped"
  ) {
    return false;
  }
  if (!Array.isArray(message.activity) || !message.activity.every(isActivityItem)) return false;
  if (!Array.isArray(message.plan) || !message.plan.every(isPlanStep)) return false;
  if (!Array.isArray(message.approvals) || !message.approvals.every(isApprovalItem)) return false;
  if (message.connectorMentions !== undefined && (!Array.isArray(message.connectorMentions) || message.connectorMentions.length > 20 || new Set(message.connectorMentions).size !== message.connectorMentions.length || !message.connectorMentions.every(id => typeof id === "string" && /^[a-z][a-z0-9]*(?:[-.:][a-z0-9]+)*$/.test(id)))) return false;
  if (message.serverReferences !== undefined && !isServerReferenceList(message.serverReferences)) return false;
  if (!Array.isArray(message.attachments) || !message.attachments.every(isChatAttachment)) return false;
  if (!Array.isArray(message.artifacts) || !message.artifacts.every(isGeneratedArtifact)) return false;
  if (message.sources !== undefined &&
      (!Array.isArray(message.sources) || !message.sources.every(isTurnSource))) return false;
  if (message.toolResults !== undefined &&
      (!Array.isArray(message.toolResults) || !message.toolResults.every(isToolResult))) return false;
  return typeof message.diff === "string";
}

export function applyChatStreamEvent(message: ChatMessage, event: ChatStreamEvent): ChatMessage {
  if (event.type === "snapshot") return event.message;
  if (event.type === "content") return { ...message, content: event.value };
  if (event.type === "delta") return { ...message, content: message.content + event.value };
  if (event.type === "activity") {
    const index = message.activity.findIndex((item) => item.id === event.item.id);
    if (index === -1) return { ...message, activity: [...message.activity, event.item] };
    const activity = [...message.activity];
    activity[index] = {
      ...event.item,
      ...(activity[index]?.sequence !== undefined || event.item.sequence !== undefined
        ? { sequence: activity[index]?.sequence ?? event.item.sequence }
        : {}),
    };
    return { ...message, activity };
  }
  if (event.type === "plan") return { ...message, plan: event.steps };
  if (event.type === "approval") {
    const index = message.approvals.findIndex((item) => item.id === event.item.id);
    if (index === -1) return { ...message, approvals: [...message.approvals, event.item] };
    const approvals = [...message.approvals];
    approvals[index] = event.item;
    return { ...message, approvals };
  }
  if (event.type === "diff") return { ...message, diff: event.value };
  if (event.type === "artifact") {
    const index = message.artifacts.findIndex((artifact) => artifact.id === event.item.id);
    if (index === -1) return { ...message, artifacts: [...message.artifacts, event.item] };
    const artifacts = [...message.artifacts];
    artifacts[index] = event.item;
    return { ...message, artifacts };
  }
  if (event.type === "source") {
    const sources = message.sources ?? [];
    const index = sources.findIndex((source) => source.id === event.item.id);
    if (index === -1) return { ...message, sources: [...sources, event.item] };
    const next = [...sources];
    next[index] = event.item;
    return { ...message, sources: next };
  }
  if (event.type === "toolResult") {
    const toolResults = message.toolResults ?? [];
    const index = toolResults.findIndex((result) => result.id === event.item.id);
    if (index === -1) return { ...message, toolResults: [...toolResults, event.item] };
    const next = [...toolResults];
    next[index] = {
      ...event.item,
      ...(next[index]?.sequence !== undefined || event.item.sequence !== undefined
        ? { sequence: next[index]?.sequence ?? event.item.sequence }
        : {}),
    };
    return { ...message, toolResults: next };
  }
  if (event.type === "done") {
    const durationMs = event.durationMs ?? message.durationMs;
    return { ...message, status: "complete", ...(durationMs !== undefined ? { durationMs } : {}) };
  }
  if (event.type === "stopped") {
    const durationMs = event.durationMs ?? message.durationMs;
    return { ...message, status: "stopped", ...(durationMs !== undefined ? { durationMs } : {}) };
  }
  if (event.type === "error") {
    const durationMs = event.durationMs ?? message.durationMs;
    return {
      ...message,
      status: "error",
      content: message.content || event.message,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  return message;
}
