import { g03PublicationTarget } from "@/g03/publication-target";

export type PublicationStatus =
  | "awaiting_confirmation"
  | "publishing"
  | "published"
  | "declined"
  | "expired"
  | "conflict";

export type PublicationOperationView = {
  schemaVersion: 1;
  operationId: string;
  threadId: string;
  turnId: string;
  targetRelativePath: string;
  status: PublicationStatus;
  candidate: { fileName: string; size: number; sha256: string };
  original: { exists: boolean; size: number | null; sha256: string | null; mtimeMs: number | null };
  confirmationExpiresAt: string;
  version: { size: number; sha256: string; createdAt: string } | null;
  result: { size: number; sha256: string; publishedAt: string; recoveredAfterInterruption: boolean } | null;
};

export type DocumentPublicationDraft = {
  id: string;
  threadId: string;
  turnId: string;
  uploadId: string;
  fileName: string;
  size: number;
  targetRelativePath: string;
  phase: "ready" | "freezing" | "awaiting_confirmation" | "uncertain" | "deciding" | "published" | "declined" | "expired" | "conflict" | "error";
  operation: PublicationOperationView | null;
  confirmationToken: string | null;
  permissionFingerprint: string | null;
  error: string | null;
};

type FreezeReceipt = {
  operation: PublicationOperationView;
  confirmationToken: string;
  permissionFingerprint: string;
};

type DecisionReceipt = {
  operation: PublicationOperationView;
  permissionFingerprint: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const INSTALLATION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PREVIEW_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STATUS = new Set<PublicationStatus>([
  "awaiting_confirmation", "publishing", "published", "declined", "expired", "conflict",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function isSafePublicationTarget(value: string) {
  if (!value || value.length > 500 || value.startsWith("/") || value.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function iso(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeSize(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 200 * 1024 * 1024;
}

function parseOperation(value: unknown): PublicationOperationView | null {
  const operation = record(value);
  if (!operation || !exactKeys(operation, [
    "schemaVersion", "operationId", "installationId", "userId", "threadId", "turnId",
    "targetRelativePath", "status", "candidate", "preview", "original",
    "confirmationExpiresAt", "version", "result", "createdAt", "updatedAt",
  ])) return null;
  const candidate = record(operation.candidate);
  const preview = record(operation.preview);
  const original = record(operation.original);
  const version = operation.version === null ? null : record(operation.version);
  const result = operation.result === null ? null : record(operation.result);
  const artifacts = preview && Array.isArray(preview.artifacts) ? preview.artifacts : null;
  if (operation.schemaVersion !== 1 || !UUID.test(String(operation.operationId)) ||
      !UUID.test(String(operation.threadId)) || !UUID.test(String(operation.turnId)) ||
      typeof operation.installationId !== "string" || !INSTALLATION_ID.test(operation.installationId) ||
      typeof operation.userId !== "string" || !UUID.test(operation.userId) ||
      !isSafePublicationTarget(String(operation.targetRelativePath)) ||
      typeof operation.status !== "string" || !STATUS.has(operation.status as PublicationStatus) ||
      !iso(operation.confirmationExpiresAt) || !iso(operation.createdAt) || !iso(operation.updatedAt) ||
      !candidate || !exactKeys(candidate, ["fileName", "size", "sha256"]) ||
      typeof candidate.fileName !== "string" || !candidate.fileName || candidate.fileName.length > 160 ||
      /[/\\\u0000-\u001f\u007f]/.test(candidate.fileName) ||
      !safeSize(candidate.size) || candidate.size === 0 || !SHA256.test(String(candidate.sha256)) ||
      !preview || !exactKeys(preview, [
        "schemaVersion", "previewId", "threadId", "turnId", "candidateSha256",
        "status", "artifacts", "createdAt",
      ]) || preview.schemaVersion !== 1 || !UUID.test(String(preview.previewId)) ||
      preview.threadId !== operation.threadId || preview.turnId !== operation.turnId ||
      preview.candidateSha256 !== candidate.sha256 || preview.status !== "ready" ||
      !artifacts || artifacts.length === 0 || artifacts.length > 32 ||
      !artifacts.every((artifact) => typeof artifact === "string" && PREVIEW_ARTIFACT.test(artifact)) ||
      new Set(artifacts).size !== artifacts.length || !iso(preview.createdAt) ||
      "snapshotRelativePath" in candidate || !original ||
      !exactKeys(original, ["exists", "size", "sha256", "mtimeMs"]) ||
      typeof original.exists !== "boolean" ||
      !(original.size === null || safeSize(original.size)) ||
      !(original.sha256 === null || SHA256.test(String(original.sha256))) ||
      !(original.mtimeMs === null || (typeof original.mtimeMs === "number" && Number.isFinite(original.mtimeMs) && original.mtimeMs >= 0))) {
    return null;
  }
  if (!original.exists && (original.size !== null || original.sha256 !== null || original.mtimeMs !== null)) return null;
  if (version && (!exactKeys(version, ["size", "sha256", "createdAt"]) ||
      !safeSize(version.size) || !SHA256.test(String(version.sha256)) || !iso(version.createdAt) ||
      "versionRelativePath" in version)) return null;
  if (result && (!exactKeys(result, ["size", "sha256", "publishedAt", "recoveredAfterInterruption"]) ||
      !safeSize(result.size) || result.size === 0 || !SHA256.test(String(result.sha256)) ||
      !iso(result.publishedAt) || typeof result.recoveredAfterInterruption !== "boolean")) return null;
  return {
    schemaVersion: 1,
    operationId: operation.operationId as string,
    threadId: operation.threadId as string,
    turnId: operation.turnId as string,
    targetRelativePath: operation.targetRelativePath as string,
    status: operation.status as PublicationStatus,
    candidate: candidate as PublicationOperationView["candidate"],
    original: original as PublicationOperationView["original"],
    confirmationExpiresAt: operation.confirmationExpiresAt as string,
    version: version as PublicationOperationView["version"],
    result: result as PublicationOperationView["result"],
  };
}

export function parsePublicationFreezeReceipt(value: unknown): FreezeReceipt | null {
  const root = record(value);
  if (!root || !exactKeys(root, ["operation", "confirmationToken", "permissionFingerprint"]) ||
      typeof root.confirmationToken !== "string" || !root.confirmationToken || root.confirmationToken.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(root.confirmationToken) || !SHA256.test(String(root.permissionFingerprint))) return null;
  const operation = parseOperation(root.operation);
  return operation ? {
    operation,
    confirmationToken: root.confirmationToken,
    permissionFingerprint: root.permissionFingerprint as string,
  } : null;
}

export function parsePublicationDecisionReceipt(value: unknown): DecisionReceipt | null {
  const root = record(value);
  if (!root || !exactKeys(root, ["operation", "permissionFingerprint"]) ||
      !(root.permissionFingerprint === null || SHA256.test(String(root.permissionFingerprint)))) return null;
  const operation = parseOperation(root.operation);
  return operation ? { operation, permissionFingerprint: root.permissionFingerprint as string | null } : null;
}

async function responseError(response: Response) {
  const body = record(await response.json().catch(() => null));
  return typeof body?.error === "string" ? body.error : "No se ha podido completar la publicación.";
}

export async function freezeDocumentPublication(draft: DocumentPublicationDraft, targetRelativePath: string) {
  if (!isSafePublicationTarget(targetRelativePath)) throw new Error("El destino debe ser una ruta relativa segura.");
  if (targetRelativePath.startsWith("server-g03/")) targetRelativePath = g03PublicationTarget(targetRelativePath);
  const operationId = crypto.randomUUID();
  const response = await fetch(`/api/threads/${encodeURIComponent(draft.threadId)}/publications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId,
      clientRequestId: crypto.randomUUID(),
      turnId: draft.turnId,
      uploadId: draft.uploadId,
      targetRelativePath,
    }),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const parsed = parsePublicationFreezeReceipt(await response.json().catch(() => null));
  if (!parsed || parsed.operation.operationId !== operationId || parsed.operation.threadId !== draft.threadId ||
      parsed.operation.turnId !== draft.turnId || parsed.operation.targetRelativePath !== targetRelativePath ||
      parsed.operation.status !== "awaiting_confirmation") {
    throw new Error("La respuesta de publicación no cumple el contrato seguro.");
  }
  return parsed;
}

export async function decideDocumentPublication(
  draft: DocumentPublicationDraft,
  action: "confirm" | "decline",
) {
  if (!draft.operation || !draft.confirmationToken) throw new Error("La confirmación ya no está disponible.");
  const response = await fetch(`/api/threads/${encodeURIComponent(draft.threadId)}/publications/${encodeURIComponent(draft.operation.operationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      clientRequestId: draft.operation.targetRelativePath.startsWith("server-g03/")
        ? `${action}:${draft.operation.operationId}` : crypto.randomUUID(),
      turnId: draft.turnId,
      confirmationToken: draft.confirmationToken,
    }),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const parsed = parsePublicationDecisionReceipt(await response.json().catch(() => null));
  if (!parsed || parsed.operation.operationId !== draft.operation.operationId ||
      parsed.operation.threadId !== draft.threadId || parsed.operation.turnId !== draft.turnId) {
    throw new Error("La decisión de publicación no cumple el contrato seguro.");
  }
  return parsed;
}

export async function recoverDocumentPublications(threadId: string, signal?: AbortSignal): Promise<DocumentPublicationDraft[]> {
  if (!UUID.test(threadId)) throw new Error("Conversación no válida.");
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/publications`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(await responseError(response));
  const body = record(await response.json());
  if (!body || !exactKeys(body, ["publications"]) || !Array.isArray(body.publications) || body.publications.length > 1000) throw new Error("Listado de publicaciones no válido.");
  const seen = new Set<string>();
  return body.publications.map((value: unknown) => {
    const entry = record(value); const op = parseOperation(entry?.operation);
    if (!entry || !exactKeys(entry, ["operation", "confirmationToken"]) || !op || op.threadId !== threadId ||
        g03PublicationTarget(op.targetRelativePath) !== op.targetRelativePath || seen.has(op.operationId) ||
        typeof entry.confirmationToken !== "string" || !SHA256.test(entry.confirmationToken)) throw new Error("Publicación recuperada no válida.");
    seen.add(op.operationId);
    const raw = entry.operation as { preview: { previewId: string } };
    return { id: `remote-${op.operationId}`, threadId, turnId: op.turnId, uploadId: raw.preview.previewId,
      fileName: op.candidate.fileName, size: op.candidate.size, targetRelativePath: op.targetRelativePath,
      phase: op.status === "publishing" ? "uncertain" : op.status,
      operation: op, confirmationToken: entry.confirmationToken, permissionFingerprint: null, error: null };
  });
}
