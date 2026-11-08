import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import type { ResolvedPermissions } from "@/permissions";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { FileDocumentStagingStore, type StagedDocument } from "./staging-store";
import { ResourceLockManager } from "@/storage/resource-lock";
import { projectSourceStore } from "./project-sources";
import { validateUploadedDocumentFile } from "./upload-validation";
import type { ResolvedTurnDocument } from "./turn-attachments";

export function requestsFileRetention(message: string) {
  const text = message.replace(/```[\s\S]*?```|<untrusted[^>]*>[\s\S]*?<\/untrusted[^>]*>/giu, "").replace(/^\s*>.*$/gmu, "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return /\b(record[aei]\w*|recuerd\w*|remember|guardar?|desar?|conservar?|save|keep)\b/u.test(text)
    && /\b(arxiu\w*|fitxer\w*|archivo\w*|file\w*|pdfs?|document\w*|excel\w*|referenci\w*)\b/u.test(text)
    && !/\b(?:otro\s+proyecto|altre\s+projecte|another\s+project|other\s+project)\b/u.test(text)
    && !/\b(no|not|don't|do not)\s+(?:\w+\s+){0,2}(record[aei]\w*|recuerd\w*|remember|guardar?|desar?|conservar?|save|keep)\b/u.test(text);
}

/** Only server-authorized current uploads or the latest matching attachment in this same thread. */
export async function rememberProjectSource(input: {
  config: Readonly<InstallationConfig>; userId: string; ownerUserId?: string;
  projectId: string; threadId: string; message: string; fileName: string;
  permissions: ResolvedPermissions; currentDocuments: readonly ResolvedTurnDocument[];
}) {
  if (!requestsFileRetention(input.message)) throw new Error("Pide explícitamente recordar o guardar este archivo como referencia del proyecto.");
  const p = input.permissions;
  const rules = p.rules.filter(rule => rule.ruleId === "documents.read" && rule.action === "consult");
  if (p.installationId !== input.config.installationId || p.userId !== input.userId || p.projectId !== input.projectId ||
    !rules.some(rule => rule.effect === "allow") || rules.some(rule => rule.effect === "deny") || !input.ownerUserId || input.ownerUserId !== input.userId) throw new Error("No se puede autorizar esta referencia.");
  const ws = FileWorkbenchStore.fromInstallation(input.config);
  const thread = await ws.getThread(input.ownerUserId, input.threadId);
  if (thread.projectId !== input.projectId) throw new Error("La conversación no pertenece a este proyecto.");
  let candidates = input.currentDocuments.filter(item => item.document.fileName === input.fileName);
  if (!candidates.length) {
    const message = [...thread.messages].reverse().find(value => value.role === "user" && value.attachments.some(item => item.name === input.fileName));
    const root = path.join(input.config.paths.usersRoot, input.userId, "staging");
    const staging = new FileDocumentStagingStore(root, new ResourceLockManager({ rootDirectory: path.join(input.config.paths.usersRoot, input.userId, "state", ".locks", "documents") }));
    candidates = await Promise.all((message?.attachments.filter(item => item.name === input.fileName) ?? []).map(async item => {
      const document = await staging.readById(input.threadId, item.id);
      return { document, absolutePath: path.join(root, document.relativePath), codexInputs: [] };
    }));
  }
  if (!candidates.length || new Set(candidates.map(item => item.document.sha256)).size !== 1) throw new Error("No se ha identificado un único archivo original en esta conversación.");
  const selected = candidates[0];
  const original: StagedDocument = selected.document;
  const authorizedPath = path.join(input.config.paths.usersRoot, input.userId, "staging", original.relativePath);
  if (original.threadId !== input.threadId || original.fileName !== input.fileName || path.resolve(selected.absolutePath) !== path.resolve(authorizedPath)) throw new Error("El original no pertenece a esta conversación.");
  const validated = await validateUploadedDocumentFile({ filePath: selected.absolutePath, fileName: original.fileName, declaredMimeType: original.mediaType });
  if (validated.sha256 !== original.sha256 || validated.size > 20_000_000 || !["xlsx", "pdf", "docx", "pptx", "text"].includes(validated.kind)) throw new Error("El original no se puede guardar como referencia. Usa XLSX, PDF, DOCX, PPTX o texto de hasta 20 MB.");
  const { staging } = projectSourceStore(input.config, input.ownerUserId);
  const stored = await staging.stageFile({ threadId: input.projectId, uploadId: original.uploadId, validated, sourcePath: selected.absolutePath });
  const source = await ws.retainProjectSource(input.ownerUserId, input.projectId, { id: stored.uploadId, kind: "file", name: stored.fileName,
    url: null, mimeType: stored.mediaType, size: stored.size, excerpt: null, status: "ready", createdAt: stored.createdAt });
  return { status: "saved", name: source.name, projectId: input.projectId, sourceId: source.id, sha256: stored.sha256, size: stored.size,
    availableIn: "all conversations in this project" };
}
