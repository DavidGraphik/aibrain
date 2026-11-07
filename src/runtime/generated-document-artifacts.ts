import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import type { DocumentArtifact } from "@/lib/chat-contract";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { resourceLocationIndexForInstallation } from "@/library/server-resource-access";
import { readRegularFileWithin } from "@/security/safe-file";
import { validateGeneratedXlsxXml } from "@/documents/generated-xlsx-validation";

const MAXIMUM_DOCUMENT_BYTES = 50 * 1024 * 1024;

export type GeneratedDocumentArtifactContext = Readonly<{
  installation: Pick<InstallationConfig, "installationId" | "paths">;
  projectId: string;
  threadId: string;
  messageId: string;
  storageOwnerId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function generatedDocumentArtifactId(turnId: string, relativePath: string) {
  const digest = createHash("sha256").update(`${turnId}\0${relativePath}`).digest("hex").slice(0, 32).split("");
  digest[12] = "4";
  digest[16] = "8";
  const hex = digest.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function secureDocumentRoot(dataRoot: string, storageOwnerId: string, artifactId: string) {
  if (!path.isAbsolute(dataRoot) || !/^[0-9a-f-]{36}$/iu.test(storageOwnerId) || !/^[0-9a-f-]{36}$/iu.test(artifactId)) {
    throw new Error("Generated document storage boundary is unsafe.");
  }
  const canonicalDataRoot = await realpath(dataRoot);
  const dataMetadata = await lstat(canonicalDataRoot);
  if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink()) throw new Error("Generated document storage boundary is unsafe.");
  const segments = ["generated-document-artifacts", storageOwnerId, artifactId];
  let current = canonicalDataRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
    const [metadata, canonical] = await Promise.all([lstat(current), realpath(current)]);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== current || !inside(canonicalDataRoot, canonical)) {
      throw new Error("Generated document artifact directory is unsafe.");
    }
    await chmod(current, 0o700);
  }
  const metadata = await lstat(current);
  return { path: current, device: metadata.dev, inode: metadata.ino, dataRoot: canonicalDataRoot };
}

async function persistImmutableDocument(
  root: Awaited<ReturnType<typeof secureDocumentRoot>>,
  fileName: string,
  contents: Buffer,
) {
  const temporaryName = `.${fileName}.${randomUUID()}.tmp`;
  const temporary = path.join(root.path, temporaryName);
  const target = path.join(root.path, fileName);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const before = await lstat(root.path);
    if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== root.device || before.ino !== root.inode) {
      throw new Error("Generated document artifact directory changed.");
    }
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, target);
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      const current = await readRegularFileWithin(root.path, fileName, MAXIMUM_DOCUMENT_BYTES);
      if (!current.equals(contents)) throw new Error("Generated document content changed for a stable id.");
      return;
    }
    const published = await readRegularFileWithin(root.path, fileName, MAXIMUM_DOCUMENT_BYTES);
    if (!published.equals(contents)) throw new Error("Generated document immutable publication failed.");
    const directory = await open(root.path, constants.O_RDONLY | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0) | noFollow);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    });
  }
}

export async function persistGeneratedDocumentArtifact(input: {
  artifactId: string;
  relativePath: string;
  contents: Buffer;
  pages: number | null;
  context: GeneratedDocumentArtifactContext;
}): Promise<DocumentArtifact> {
  const fileName = path.basename(input.relativePath);
  const extension = path.extname(fileName).toLocaleLowerCase() as keyof typeof GENERATED_FORMATS;
  const format = GENERATED_FORMATS[extension];
  if (!format) throw new Error("Generated document format is unsupported.");
  const validated = validateUploadedDocument({ fileName, declaredMimeType: format.mimeType, data: input.contents });
  if (validated.kind !== format.kind || validated.sha256 !== createHash("sha256").update(input.contents).digest("hex")) {
    throw new Error("Generated document validation changed its identity.");
  }
  if (format.kind === "xlsx") await validateGeneratedXlsxXml(input.contents);
  const root = await secureDocumentRoot(input.context.installation.paths.dataRoot, input.context.storageOwnerId, input.artifactId);
  await persistImmutableDocument(root, fileName, input.contents);
  const relativePath = path.posix.join("generated-document-artifacts", input.context.storageOwnerId, input.artifactId, fileName);
  await resourceLocationIndexForInstallation(input.context.installation).register({
    kind: "generated-document",
    resourceId: input.artifactId,
    projectId: input.context.projectId,
    threadId: input.context.threadId,
    messageId: input.context.messageId,
    storageOwnerId: input.context.storageOwnerId,
    relativePath,
    fileName,
    mediaType: format.mimeType,
    size: input.contents.byteLength,
    sha256: validated.sha256,
  });
  const route = `/api/threads/${input.context.threadId}/artifacts/${input.artifactId}`;
  return Object.freeze({
    id: input.artifactId,
    type: "document",
    name: fileName,
    url: `${route}?download=1`,
    kind: format.kind,
    mimeType: format.mimeType,
    size: input.contents.byteLength,
    status: "ready",
    pages: input.pages,
    previewUrl: `${route}?preview=1`,
    publicationStatus: null,
    publicationError: null,
    targetLabel: null,
    error: null,
  });
}

const GENERATED_FORMATS = {
  ".pdf": { kind: "pdf", mimeType: "application/pdf" },
  ".docx": { kind: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ".pptx": { kind: "pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  ".xlsx": { kind: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
} as const;
