import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { DocumentArtifact } from "@/lib/chat-contract";
import { resourceLocationIndexForInstallation } from "@/library/server-resource-access";
import { readRegularFileWithin } from "@/security/safe-file";
import { FileDocumentStorageGate } from "@/documents/storage-gate";
import { persistImmutableDocument, generatedDocumentArtifactId, type GeneratedDocumentArtifactContext } from "./generated-document-artifacts";

export const TRINALUM_FILE_MAXIMUM = 30 * 1024 * 1024;

/** A bounded file header check, never a filename/MIME assertion or a search
 * for an embedded marker in HTML. Parsing still requires the isolated reader. */
export function hasPdfOriginalHeader(bytes: Buffer) {
  return /^(?:\xEF\xBB\xBF)?[\x09\x0A\x0C\x0D\x20]*%PDF-[12]\.\d(?:[\x09\x0A\x0C\x0D\x20]|$)/.test(bytes.subarray(0, 1024).toString("latin1"));
}

export async function resolveTrinalumArtifactAttachment(id: string, context: GeneratedDocumentArtifactContext) {
  if(!/^[0-9a-f-]{36}$/i.test(id))throw Error('ATTACHMENT_REFERENCE_INVALID');
  const record=await resourceLocationIndexForInstallation(context.installation).binding('generated-document',id);
  if(!record||record.storageOwnerId!==context.storageOwnerId||record.projectId!==context.projectId||!record.relativePath||
    ![ `trinalum-connector-files/${context.storageOwnerId}/${id}/`, `generated-document-artifacts/${context.storageOwnerId}/${id}/` ].some(prefix=>record.relativePath!.startsWith(prefix)))throw Error('ATTACHMENT_ACCESS_DENIED');
  const bytes=await readRegularFileWithin(context.installation.paths.dataRoot,record.relativePath,TRINALUM_FILE_MAXIMUM);
  if(bytes.length!==record.size||createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw Error('ATTACHMENT_SOURCE_CHANGED');
  return {name:record.fileName,contentType:record.mediaType,contentBytes:bytes.toString('base64')};
}

/** Copies only provider-returned bytes into an authenticated, immutable artifact. */
export async function persistTrinalumFile(file: Record<string, unknown>, context: GeneratedDocumentArtifactContext, sourceRead = false): Promise<DocumentArtifact> {
  if (typeof file.content_base64 !== "string" || file.content_base64.length > Math.ceil(TRINALUM_FILE_MAXIMUM / 3) * 4 + 4) throw Error("CONNECTOR_FILE_INVALID");
  const contents = Buffer.from(file.content_base64, "base64");
  if (contents.toString("base64") !== file.content_base64 || contents.length > TRINALUM_FILE_MAXIMUM) throw Error("CONNECTOR_FILE_INVALID");
  const sha256 = createHash("sha256").update(contents).digest("hex");
  if (file.sha256 !== undefined && file.sha256 !== sha256 || file.bytes !== undefined && file.bytes !== contents.length) throw Error("CONNECTOR_FILE_CHANGED");
  const rawName = file.filename ?? file.fileName ?? "adjunto.bin";
  if(typeof rawName!=="string"||rawName.length>4096)throw Error("CONNECTOR_FILENAME_INVALID");
  let name=rawName.replace(/[\x00-\x1f\\/]/g,"_").trim();
  if(!name||name==='.'||name==='..')name='adjunto.bin';
  if(name.length>160){const ext=path.extname(name).slice(0,24);name=name.slice(0,160-ext.length-10)+'-'+sha256.slice(0,8)+ext;}
  const rawType = file.mimeType ?? file.content_type ?? file.contentType ?? "application/octet-stream";
  const declaredType = typeof rawType === "string" && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(rawType) ? rawType : "application/octet-stream";
  const pdfHeaderVerified = hasPdfOriginalHeader(contents);
  const mimeType = pdfHeaderVerified ? "application/pdf" : declaredType;
  const artifactId = generatedDocumentArtifactId(context.messageId, `connector/${sha256}/${name}`);
  const base = await realpath(context.installation.paths.dataRoot);
  for (const part of [context.storageOwnerId, artifactId]) {
    if (!/^[\w-]+$/.test(part)) throw Error("CONNECTOR_FILE_IDENTITY_INVALID");
  }
  const admission = new FileDocumentStorageGate({
    rootDirectory: path.join(base, "locks", "document-storage"),
    capacityDirectories: [path.join(base, "trinalum-connector-files", context.storageOwnerId)],
  });
  return admission.run(async () => {
  let directory = base;
  for (const part of ["trinalum-connector-files", context.storageOwnerId, artifactId]) {
    if (!/^[\w-]+$/.test(part)) throw Error("CONNECTOR_FILE_IDENTITY_INVALID");
    directory = path.join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const meta = await lstat(directory);
    if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(directory) !== directory) throw Error("CONNECTOR_FILE_PATH_UNSAFE");
  }
  const target = path.join(directory, name);
  const metadata = await lstat(directory);
  try {
    await persistImmutableDocument({ path: directory, device: metadata.dev, inode: metadata.ino, dataRoot: base }, name, contents);
  } catch (error) {
    if (error instanceof Error && error.message === "Generated document content changed for a stable id.") throw Error("CONNECTOR_FILE_CHANGED");
    throw error;
  }
  if (!(await readRegularFileWithin(directory, name, TRINALUM_FILE_MAXIMUM)).equals(contents)) throw Error("CONNECTOR_FILE_CHANGED");
  const relativePath = path.relative(base, target).split(path.sep).join("/");
  await resourceLocationIndexForInstallation(context.installation).register({ kind: "generated-document", resourceId: artifactId,
    projectId: context.projectId, threadId: context.threadId, messageId: context.messageId, storageOwnerId: context.storageOwnerId,
    relativePath, fileName: name, mediaType: mimeType, size: contents.length, sha256 });
  const ext = path.extname(name).slice(1).toLowerCase();
  const kind = pdfHeaderVerified ? "pdf" : ["docx", "xlsx", "xls", "pptx"].includes(ext) ? ext as DocumentArtifact["kind"] : "text";
  return { id: artifactId, type: "document", name, url: `/api/threads/${context.threadId}/connector-files/${artifactId}`,
    kind, mimeType, size: contents.length, status: "ready", pages: null, previewUrl: null,
    publicationStatus: null, publicationError: null, targetLabel: null, error: null,
    ...(sourceRead ? { provenance: "source-read" as const } : {}) };
  });
}
