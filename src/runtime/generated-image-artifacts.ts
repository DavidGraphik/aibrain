import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { validateUploadedDocument } from "@/documents/upload-validation";
import type { ImageArtifact } from "@/lib/chat-contract";
import { resourceLocationIndexForInstallation } from "@/library/server-resource-access";
import { readRegularFileWithin } from "@/security/safe-file";

const MAXIMUM_GENERATED_IMAGE_BYTES = 20_000_000;
const MAXIMUM_GENERATED_IMAGE_BASE64_LENGTH = Math.ceil(MAXIMUM_GENERATED_IMAGE_BYTES / 3) * 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAXIMUM_PNG_DIMENSION = 8_192;
const MAXIMUM_PNG_PIXELS = 40_000_000;
const IMAGE_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

type GeneratedImageItem = Readonly<{
  id?: unknown;
  type?: unknown;
  result?: unknown;
  revisedPrompt?: unknown;
  savedPath?: unknown;
  failure?: unknown;
}>;

export type GeneratedImageArtifactContext = Readonly<{
  installation: Pick<InstallationConfig, "installationId" | "paths">;
  projectWorkspace: string;
  projectId: string;
  threadId: string;
  messageId: string;
  storageOwnerId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function generatedImageArtifactId(messageId: string, itemId: string) {
  const digest = createHash("sha256").update(`${messageId}\0${itemId}`).digest("hex").slice(0, 32).split("");
  digest[12] = "4";
  digest[16] = "8";
  const hex = digest.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isPng(contents: Uint8Array) {
  if (contents.byteLength < PNG_SIGNATURE.length + 12 ||
      !PNG_SIGNATURE.every((expected, index) => contents[index] === expected)) return false;
  const data = Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength);
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawPixels = false;
  while (offset + 12 <= data.byteLength) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.byteLength) return false;
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = data.readUInt32BE(offset + 8);
      const height = data.readUInt32BE(offset + 12);
      if (width < 1 || height < 1 || width > MAXIMUM_PNG_DIMENSION || height > MAXIMUM_PNG_DIMENSION ||
          width * height > MAXIMUM_PNG_PIXELS || data[offset + 18] !== 0 || data[offset + 19] !== 0 ||
          (data[offset + 20] !== 0 && data[offset + 20] !== 1)) return false;
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    } else if (type === "IDAT") {
      if (length === 0) return false;
      sawPixels = true;
    } else if (type === "IEND") {
      return length === 0 && sawPixels && end === data.byteLength;
    }
    offset = end;
  }
  return false;
}

export function decodeGeneratedPngResult(result: unknown) {
  if (typeof result !== "string") return null;
  const trimmed = result.trim();
  const encoded = trimmed.startsWith("data:image/png;base64,")
    ? trimmed.slice("data:image/png;base64,".length)
    : trimmed;
  if (!encoded || encoded.length % 4 !== 0 || encoded.length > MAXIMUM_GENERATED_IMAGE_BASE64_LENGTH) return null;
  const contents = Buffer.from(encoded, "base64");
  // Buffer's decoder is deliberately forgiving. A canonical round trip keeps
  // the accepted language strict without applying a backtracking regexp to a
  // multi-megabyte provider response.
  if (contents.toString("base64") !== encoded) return null;
  if (contents.byteLength < 64 || contents.byteLength > MAXIMUM_GENERATED_IMAGE_BYTES || !isPng(contents)) return null;
  try {
    const validated = validateUploadedDocument({
      fileName: "generated-image.png",
      declaredMimeType: "image/png",
      data: contents,
    });
    return validated.kind === "image" && validated.mediaType === "image/png" ? contents : null;
  } catch {
    return null;
  }
}

async function pngFromSavedPath(savedPath: unknown, projectWorkspace: string) {
  if (typeof savedPath !== "string" || !path.isAbsolute(savedPath)) return null;
  const relativePath = path.relative(projectWorkspace, savedPath);
  if (!relativePath || path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) return null;
  try {
    const contents = await readRegularFileWithin(projectWorkspace, relativePath, MAXIMUM_GENERATED_IMAGE_BYTES);
    return decodeGeneratedPngResult(contents.toString("base64"));
  } catch {
    return null;
  }
}

async function secureArtifactRoot(dataRoot: string) {
  if (!path.isAbsolute(dataRoot)) {
    throw new Error("Generated image server storage boundary is unsafe.");
  }
  const dataRootMetadata = await lstat(dataRoot);
  const canonicalDataRoot = await realpath(dataRoot);
  if (!dataRootMetadata.isDirectory() || dataRootMetadata.isSymbolicLink()) {
    throw new Error("Generated image server storage boundary is unsafe.");
  }

  const artifactRoot = path.join(canonicalDataRoot, "generated-image-artifacts");
  try {
    await mkdir(artifactRoot, { mode: 0o700 });
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
  }
  const [metadata, canonicalArtifactRoot] = await Promise.all([
    lstat(artifactRoot),
    realpath(artifactRoot),
  ]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      canonicalArtifactRoot !== artifactRoot || !inside(canonicalDataRoot, canonicalArtifactRoot)) {
    throw new Error("Generated image artifact directory is unsafe.");
  }
  return { path: artifactRoot, device: metadata.dev, inode: metadata.ino };
}

type SecureArtifactRoot = Awaited<ReturnType<typeof secureArtifactRoot>>;

async function assertSameArtifactRoot(root: SecureArtifactRoot) {
  const [metadata, canonical] = await Promise.all([
    lstat(root.path),
    realpath(root.path),
  ]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== root.path ||
      metadata.dev !== root.device || metadata.ino !== root.inode) {
    throw new Error("Generated image artifact directory changed during persistence.");
  }
}

async function persistImmutablePng(artifactRoot: SecureArtifactRoot, fileName: string, contents: Buffer) {
  const target = path.join(artifactRoot.path, fileName);
  const temporary = path.join(artifactRoot.path, `.${fileName}.${randomUUID()}.tmp`);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let temporaryCreated = false;
  try {
    await assertSameArtifactRoot(artifactRoot);
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    temporaryCreated = true;
    await handle.writeFile(contents);
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.isSymbolicLink() || written.size !== contents.byteLength) {
      throw new Error("Generated image artifact temporary write could not be verified.");
    }
    await handle.close();
    handle = null;

    await assertSameArtifactRoot(artifactRoot);
    try {
      // Linking publishes an already-fsynced inode without ever replacing an
      // existing immutable artifact. Readers therefore observe either ENOENT
      // or the complete PNG, never the bytes while they are still being written.
      await link(temporary, target);
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      await assertSameArtifactRoot(artifactRoot);
      const current = await readRegularFileWithin(
        artifactRoot.path,
        fileName,
        MAXIMUM_GENERATED_IMAGE_BYTES,
      );
      if (!current.equals(contents)) {
        throw new Error("Generated image artifact content changed for a stable id.");
      }
      return;
    }

    await assertSameArtifactRoot(artifactRoot);
    const published = await readRegularFileWithin(
      artifactRoot.path,
      fileName,
      MAXIMUM_GENERATED_IMAGE_BYTES,
    );
    if (!published.equals(contents)) {
      throw new Error("Generated image artifact failed immutable publication readback.");
    }
    const directory = await open(
      artifactRoot.path,
      constants.O_RDONLY | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0) | noFollow,
    );
    try {
      const opened = await directory.stat();
      if (!opened.isDirectory() || opened.dev !== artifactRoot.device || opened.ino !== artifactRoot.inode) {
        throw new Error("Generated image artifact directory changed before durable publication.");
      }
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (temporaryCreated) {
      // Never follow a replacement parent merely to clean up. An orphan in
      // the original private directory is safer than unlinking an attacker-
      // controlled path after its identity changed.
      await assertSameArtifactRoot(artifactRoot)
        .then(() => unlink(temporary).catch((error: unknown) => {
          if (!isRecord(error) || error.code !== "ENOENT") throw error;
        }))
        .catch(() => undefined);
    }
  }
}

export async function persistGeneratedImageArtifact(
  item: GeneratedImageItem,
  context: GeneratedImageArtifactContext,
): Promise<ImageArtifact | null> {
  if (item.type !== "imageGeneration" || item.failure ||
      typeof item.id !== "string" || !IMAGE_ITEM_ID.test(item.id)) return null;
  const contents = decodeGeneratedPngResult(item.result) ??
    await pngFromSavedPath(item.savedPath, context.projectWorkspace);
  if (!contents) return null;

  const artifactId = generatedImageArtifactId(context.messageId, item.id);
  const fileName = `imagen-${artifactId.slice(0, 8)}.png`;
  const relativePath = `generated-image-artifacts/${artifactId}.png`;
  const artifactRoot = await secureArtifactRoot(context.installation.paths.dataRoot);
  await persistImmutablePng(artifactRoot, `${artifactId}.png`, contents);
  await resourceLocationIndexForInstallation(context.installation).register({
    kind: "generated-image",
    resourceId: artifactId,
    projectId: context.projectId,
    threadId: context.threadId,
    messageId: context.messageId,
    storageOwnerId: context.storageOwnerId,
    relativePath,
    fileName,
    mediaType: "image/png",
    size: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
  return {
    id: artifactId,
    type: "image",
    name: fileName,
    url: `/api/projects/${context.projectId}/artifacts/${artifactId}`,
    prompt: typeof item.revisedPrompt === "string" ? item.revisedPrompt : null,
    // Contents have already passed PNG structure, dimensions and integrity checks.
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  };
}
