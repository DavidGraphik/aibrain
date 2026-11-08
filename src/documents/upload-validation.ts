import { inspectOggOpus, MAX_AUDIO_BYTES } from "./audio-validation";
import { inspectLegacyExcel, isLegacyExcelContainer } from "./legacy-excel-validation";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { LegacyExcelProvenance, StoredLegacyExcelReceipt } from "./legacy-excel-policy";
import { createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";

export type SupportedUploadKind = "docx" | "xlsx" | "xls" | "pptx" | "pdf" | "text" | "image" | "audio";

export type ValidatedUpload = {
  kind: SupportedUploadKind;
  fileName: string;
  mediaType: string;
  size: number;
  sha256: string;
  officeEntries: number | null;
  legacyExcel?: LegacyExcelProvenance;
  storedLegacyExcel?: StoredLegacyExcelReceipt;
};

export class UploadValidationError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UploadValidationError";
  }
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_ZIP_RATIO = 100;

type OfficeInspection = { kind: "docx" | "xlsx" | "pptx"; entries: number };

export function safeFileName(value: string) {
  const normalized = value.normalize("NFC");
  if (
    normalized.length < 1
    || normalized.length > 120
    || normalized === "."
    || normalized === ".."
    || normalized !== path.basename(normalized)
    || normalized.includes("/")
    || normalized.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new UploadValidationError("UPLOAD_FILENAME_INVALID", "Upload filename is unsafe.");
  }
  return normalized;
}

function extension(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

function startsWith(data: Uint8Array, bytes: readonly number[]) {
  return bytes.every((value, index) => data[index] === value);
}

function findEndOfCentralDirectory(data: Buffer) {
  const lowerBound = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= lowerBound; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML archive has no valid central directory.");
}

function decodeZipName(value: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML archive contains a non-UTF-8 path.");
  }
}

function validateZipEntryName(name: string) {
  if (
    !name
    || name.startsWith("/")
    || name.includes("\\")
    || name.includes("\0")
    || path.posix.normalize(name) !== name
    || name.split("/").some((segment) => segment === "..")
  ) {
    throw new UploadValidationError("UPLOAD_ARCHIVE_TRAVERSAL", "OOXML archive contains an unsafe path.");
  }
}

function inspectOfficeArchive(data: Buffer): OfficeInspection {
  const end = findEndOfCentralDirectory(data);
  const disk = data.readUInt16LE(end + 4);
  const centralDisk = data.readUInt16LE(end + 6);
  const entriesOnDisk = data.readUInt16LE(end + 8);
  const entries = data.readUInt16LE(end + 10);
  const centralBytes = data.readUInt32LE(end + 12);
  const centralOffset = data.readUInt32LE(end + 16);
  const commentBytes = data.readUInt16LE(end + 20);
  if (
    disk !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entries
    || entries > MAX_ZIP_ENTRIES
    || end + 22 + commentBytes !== data.length
    || centralOffset + centralBytes !== end
    || centralOffset > data.length
  ) {
    throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML central directory is unsupported or inconsistent.");
  }

  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML central directory entry is truncated.");
    }
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const uncompressed = data.readUInt32LE(offset + 24);
    const nameBytes = data.readUInt16LE(offset + 28);
    const extraBytes = data.readUInt16LE(offset + 30);
    const entryCommentBytes = data.readUInt16LE(offset + 32);
    const next = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (
      next > end
      || compressed === 0xffffffff
      || uncompressed === 0xffffffff
      || (flags & 0x1) !== 0
      || (method !== 0 && method !== 8)
    ) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML entry is encrypted, Zip64, truncated or uses an unsafe codec.");
    }
    const name = decodeZipName(data.subarray(offset + 46, offset + 46 + nameBytes));
    validateZipEntryName(name);
    const lower = name.toLowerCase();
    if (
      lower.endsWith("vbaproject.bin")
      || lower.includes("/activex/")
      || lower.startsWith("customui/")
      || lower.includes("/macrosheets/")
    ) {
      throw new UploadValidationError("UPLOAD_MACROS_REJECTED", "Macro-enabled or active OOXML content is not accepted.");
    }
    names.add(name);
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new UploadValidationError("UPLOAD_ARCHIVE_BOMB", "OOXML archive expands beyond the safety limit.");
    }
    offset = next;
  }
  if (offset !== end || totalUncompressed / Math.max(1, totalCompressed) > MAX_ZIP_RATIO) {
    throw new UploadValidationError("UPLOAD_ARCHIVE_BOMB", "OOXML archive compression ratio exceeds the safety limit.");
  }
  if (!names.has("[Content_Types].xml")) {
    throw new UploadValidationError("UPLOAD_OFFICE_INVALID", "OOXML archive lacks [Content_Types].xml.");
  }
  if ([...names].some((name) => name.startsWith("word/"))) return { kind: "docx", entries };
  if ([...names].some((name) => name.startsWith("xl/"))) return { kind: "xlsx", entries };
  if ([...names].some((name) => name.startsWith("ppt/"))) return { kind: "pptx", entries };
  throw new UploadValidationError("UPLOAD_OFFICE_INVALID", "OOXML archive is not DOCX, XLSX or PPTX.");
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
) {
  const data = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(data, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML central directory is truncated.");
    }
    offset += result.bytesRead;
  }
  return data;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function updateCrc32(crc: number, data: Buffer) {
  let next = crc;
  for (const byte of data) next = CRC32_TABLE[(next ^ byte) & 0xff]! ^ (next >>> 8);
  return next >>> 0;
}

type FileZipEntry = {
  method: number;
  crc32: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
  dataStart: number;
  dataEnd: number;
  recordEnd: number;
};

async function verifyZipEntryPayload(
  handle: Awaited<ReturnType<typeof open>>,
  entry: FileZipEntry,
  totalOutput: { value: number },
) {
  if (entry.compressed === 0) {
    if (entry.uncompressed !== 0 || entry.crc32 !== 0) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML empty entry has inconsistent metadata.");
    }
    return;
  }
  const compressed = Readable.from((async function* () {
    for (let position = entry.dataStart; position < entry.dataEnd; position += 64 * 1024) {
      yield await readExactly(handle, position, Math.min(64 * 1024, entry.dataEnd - position));
    }
  })());
  const output = entry.method === 8 ? compressed.pipe(createInflateRaw()) : compressed;
  if (output !== compressed) compressed.on("error", (error) => output.destroy(error));
  let actualBytes = 0;
  let crc = 0xffffffff;
  try {
    for await (const chunk of output) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      actualBytes += data.length;
      totalOutput.value += data.length;
      if (
        actualBytes > MAX_ZIP_UNCOMPRESSED_BYTES
        || totalOutput.value > MAX_ZIP_UNCOMPRESSED_BYTES
        || actualBytes > entry.compressed * MAX_ZIP_RATIO
      ) {
        throw new UploadValidationError("UPLOAD_ARCHIVE_BOMB", "OOXML actual expansion exceeds the safety limit.");
      }
      crc = updateCrc32(crc, data);
    }
  } catch (error) {
    compressed.destroy();
    output.destroy();
    if (error instanceof UploadValidationError) throw error;
    throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML entry data is truncated or corrupt.", { cause: error });
  } finally {
    // Payload streams do not own the shared file handle. Release each pipeline
    // without retaining one FileHandle close listener for every ZIP entry.
    compressed.destroy();
    output.destroy();
  }
  if (actualBytes !== entry.uncompressed || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
    throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML entry size or CRC does not match its payload.");
  }
}

async function inspectOfficeArchiveFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  passiveWorkbook = false,
): Promise<OfficeInspection> {
  const tailBytes = Math.min(size, 65_557);
  const tailStart = size - tailBytes;
  const tail = await readExactly(handle, tailStart, tailBytes);
  const relativeEnd = findEndOfCentralDirectory(tail);
  const end = tailStart + relativeEnd;
  const disk = tail.readUInt16LE(relativeEnd + 4);
  const centralDisk = tail.readUInt16LE(relativeEnd + 6);
  const entriesOnDisk = tail.readUInt16LE(relativeEnd + 8);
  const entries = tail.readUInt16LE(relativeEnd + 10);
  const centralBytes = tail.readUInt32LE(relativeEnd + 12);
  const centralOffset = tail.readUInt32LE(relativeEnd + 16);
  const commentBytes = tail.readUInt16LE(relativeEnd + 20);
  if (
    disk !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entries
    || entries > MAX_ZIP_ENTRIES
    || end + 22 + commentBytes !== size
    || centralOffset + centralBytes !== end
    || centralOffset > size
  ) {
    throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML central directory is unsupported or inconsistent.");
  }

  let offset = centralOffset;
  let declaredCompressed = 0;
  let declaredUncompressed = 0;
  const names = new Set<string>();
  const officeKinds = new Set<OfficeInspection["kind"]>();
  const fileEntries: FileZipEntry[] = [];
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML central directory entry is truncated.");
    }
    const header = await readExactly(handle, offset, 46);
    if (header.readUInt32LE(0) !== 0x02014b50) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML central directory entry is truncated.");
    }
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    const crc32 = header.readUInt32LE(16);
    const compressed = header.readUInt32LE(20);
    const uncompressed = header.readUInt32LE(24);
    const nameBytes = header.readUInt16LE(28);
    const extraBytes = header.readUInt16LE(30);
    const entryCommentBytes = header.readUInt16LE(32);
    const localOffset = header.readUInt32LE(42);
    const next = offset + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (
      next > end
      || compressed === 0xffffffff
      || uncompressed === 0xffffffff
      || localOffset === 0xffffffff
      || (flags & 0x0001) !== 0
      || (flags & ~0x080e) !== 0
      || (method === 0 && (flags & 0x0006) !== 0)
      || (method !== 0 && method !== 8)
    ) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML entry uses unsupported flags, Zip64 or codec.");
    }
    const nameData = await readExactly(handle, offset + 46, nameBytes);
    const name = decodeZipName(nameData);
    validateZipEntryName(name);
    if (names.has(name)) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML archive contains duplicate paths.");
    }
    names.add(name);
    const lower = name.toLowerCase();
    if (!passiveWorkbook && (
      lower.endsWith("vbaproject.bin")
      || lower.includes("/activex/")
      || lower.startsWith("customui/")
      || lower.includes("/macrosheets/")
    )) {
      throw new UploadValidationError("UPLOAD_MACROS_REJECTED", "Macro-enabled or active OOXML content is not accepted.");
    }
    if (name.startsWith("word/")) officeKinds.add("docx");
    else if (name.startsWith("xl/")) officeKinds.add("xlsx");
    else if (name.startsWith("ppt/")) officeKinds.add("pptx");

    if (localOffset + 30 > centralOffset) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML local header points outside file data.");
    }
    const local = await readExactly(handle, localOffset, 30);
    const localNameBytes = local.readUInt16LE(26);
    const localExtraBytes = local.readUInt16LE(28);
    const dataStart = localOffset + 30 + localNameBytes + localExtraBytes;
    const dataEnd = dataStart + compressed;
    const hasDescriptor = (flags & 0x0008) !== 0;
    const matchesLocal = (position: number, value: number) => local.readUInt32LE(position) === value
      || hasDescriptor && local.readUInt32LE(position) === 0;
    if (
      local.readUInt32LE(0) !== 0x04034b50
      || local.readUInt16LE(6) !== flags
      || local.readUInt16LE(8) !== method
      || !matchesLocal(14, crc32)
      || !matchesLocal(18, compressed)
      || !matchesLocal(22, uncompressed)
      || localNameBytes !== nameBytes
      || dataStart > centralOffset
      || dataEnd > centralOffset
      || !(await readExactly(handle, localOffset + 30, localNameBytes)).equals(nameData)
    ) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML local and central headers are inconsistent.");
    }
    // Google Drive and other streaming Office exporters write the CRC and sizes
    // after the payload. Verify that record against the central directory; the
    // payload itself still undergoes bounded inflation and a complete CRC check.
    let recordEnd = dataEnd;
    if (hasDescriptor) {
      if (dataEnd + 12 > centralOffset) throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML data descriptor is truncated.");
      const descriptor = await readExactly(handle, dataEnd, Math.min(16, centralOffset - dataEnd));
      const matches = (base: number) => descriptor.length >= base + 12 && descriptor.readUInt32LE(base) === crc32
        && descriptor.readUInt32LE(base + 4) === compressed && descriptor.readUInt32LE(base + 8) === uncompressed;
      const signed = descriptor.readUInt32LE(0) === 0x08074b50 && matches(4);
      if (!signed && !matches(0)) {
        throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML data descriptor and central directory are inconsistent.");
      }
      recordEnd += signed ? 16 : 12;
    }
    fileEntries.push({ method, crc32, compressed, uncompressed, localOffset, dataStart, dataEnd, recordEnd });
    declaredCompressed += compressed;
    declaredUncompressed += uncompressed;
    if (declaredUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new UploadValidationError("UPLOAD_ARCHIVE_BOMB", "OOXML declared expansion exceeds the safety limit.");
    }
    offset = next;
  }
  if (
    offset !== end
    || declaredUncompressed / Math.max(1, declaredCompressed) > MAX_ZIP_RATIO
  ) {
    throw new UploadValidationError("UPLOAD_ARCHIVE_BOMB", "OOXML declared compression ratio exceeds the safety limit.");
  }
  const ranges = [...fileEntries].sort((left, right) => left.localOffset - right.localOffset);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.localOffset < ranges[index - 1]!.recordEnd) {
      throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML local entries overlap.");
    }
  }
  const totalOutput = { value: 0 };
  for (const entry of fileEntries) await verifyZipEntryPayload(handle, entry, totalOutput);
  if (totalOutput.value !== declaredUncompressed) {
    throw new UploadValidationError("UPLOAD_ZIP_INVALID", "OOXML actual total size is inconsistent.");
  }
  if (!names.has("[Content_Types].xml") || officeKinds.size !== 1) {
    throw new UploadValidationError("UPLOAD_OFFICE_INVALID", "OOXML archive is missing or mixes required package parts.");
  }
  return { kind: [...officeKinds][0]!, entries };
}

function detectedImageType(data: Buffer) {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function assertMimeAndExtension(
  fileName: string,
  declaredMimeType: string,
  kind: SupportedUploadKind,
  mediaType: string,
) {
  const ext = extension(fileName);
  const allowedExtensions: Record<SupportedUploadKind, readonly string[]> = {
    audio: [".ogg", ".opus"],
    docx: [".docx"],
    xlsx: [".xlsx", ".xltx"],
    xls: [".xls"],
    pptx: [".pptx"],
    pdf: [".pdf"],
    text: [".txt", ".md", ".csv", ".json", ".asc"],
    image: mediaType === "image/jpeg" ? [".jpg", ".jpeg"] : [`.${mediaType.slice("image/".length)}`],
  };
  const officeMime: Record<string, string> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  const mimeMatches = kind === "audio"
    ? ["audio/ogg", "audio/opus", "application/ogg", "application/octet-stream", ""].includes(declaredMimeType)
    : kind === "text"
    ? declaredMimeType.startsWith("text/") || declaredMimeType === "application/json"
      // Measurement exporters use ASC for inert text, often without a MIME
      // registration. Both validators still require bounded, NUL-free UTF-8.
      || (ext === ".asc" && ["application/octet-stream", ""].includes(declaredMimeType))
    : declaredMimeType === (officeMime[kind] ?? mediaType)
      // Browsers may report legacy Excel as generic binary data. Both entry
      // points inspect the complete CFB/BIFF8 before reaching this check.
      || (kind === "xls" && declaredMimeType === "application/octet-stream")
      // XLTX is the macro-free OOXML template variant; it follows the same
      // signature, archive, expansion and active-content checks as XLSX.
      || (kind === "xlsx" && ext === ".xltx" && [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.template", "application/octet-stream", "",
      ].includes(declaredMimeType));
  if (!allowedExtensions[kind].includes(ext) || !mimeMatches) {
    throw new UploadValidationError("UPLOAD_TYPE_MISMATCH", "Filename, declared MIME and file signature do not agree.");
  }
}

export function validateUploadedDocument(input: {
  fileName: string;
  declaredMimeType: string;
  data: Buffer;
}): ValidatedUpload {
  const fileName = safeFileName(input.fileName);
  const declaredMimeType = input.declaredMimeType.trim().toLowerCase();
  const data = input.data;
  if (data.length < 1 || data.length > MAX_FILE_BYTES) {
    throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Upload size is outside the safety limit.");
  }

  let kind: SupportedUploadKind;
  let mediaType: string;
  let officeEntries: number | null = null;
  if (data.subarray(0, 4).toString("ascii") === "OggS") {
    inspectOggOpus(data);
    kind = "audio";
    mediaType = "audio/ogg";
  } else if (data.subarray(0, 5).toString("ascii") === "%PDF-") {
    kind = "pdf";
    mediaType = "application/pdf";
  } else if (isLegacyExcelContainer(data)) {
    inspectLegacyExcel(data);
    kind = "xls";
    mediaType = "application/vnd.ms-excel";
  } else if (startsWith(data, [0x50, 0x4b])) {
    const office = inspectOfficeArchive(data);
    kind = office.kind;
    officeEntries = office.entries;
    mediaType = {
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }[kind];
    if (kind === "xlsx" && extension(fileName) === ".xltx") {
      mediaType = "application/vnd.openxmlformats-officedocument.spreadsheetml.template";
    }
  } else {
    const imageType = detectedImageType(data);
    if (imageType) {
      kind = "image";
      mediaType = imageType;
      if (data.length > MAX_IMAGE_BYTES) {
        throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Image exceeds the safety limit.");
      }
    } else {
      if (data.length > MAX_TEXT_BYTES || data.includes(0)) {
        throw new UploadValidationError("UPLOAD_TYPE_UNSUPPORTED", "Upload is not a supported text or document format.");
      }
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new UploadValidationError("UPLOAD_TYPE_UNSUPPORTED", "Text upload must be valid UTF-8.");
      }
      kind = "text";
      mediaType = declaredMimeType === "application/json" ? "application/json" : "text/plain";
    }
  }
  assertMimeAndExtension(fileName, declaredMimeType, kind, mediaType);
  return {
    kind,
    fileName,
    mediaType,
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    officeEntries,
  };
}

/** Validates a private regular file with bounded reads and streaming hashing. */
async function validateDocumentFile(input: {
  fileName: string;
  declaredMimeType: string;
  filePath: string;
}, passiveWorkbook = false): Promise<ValidatedUpload> {
  const fileName = safeFileName(input.fileName);
  const declaredMimeType = input.declaredMimeType.trim().toLowerCase();
  const pathMetadata = await lstat(input.filePath);
  if (
    pathMetadata.isSymbolicLink()
    || !pathMetadata.isFile()
    || pathMetadata.nlink !== 1
    || (pathMetadata.mode & 0o077) !== 0
  ) {
    throw new UploadValidationError("UPLOAD_SOURCE_UNSAFE", "Upload source must be a private regular file.");
  }
  const handle = await open(input.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o077) !== 0
      || before.dev !== pathMetadata.dev
      || before.ino !== pathMetadata.ino
    ) {
      throw new UploadValidationError("UPLOAD_SOURCE_CHANGED", "Upload changed before validation.");
    }
    if (before.size < 1 || before.size > MAX_FILE_BYTES) {
      throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Upload size is outside the safety limit.");
    }
    const head = await readExactly(handle, 0, Math.min(16, before.size));

    let kind: SupportedUploadKind;
    let mediaType: string;
    let officeEntries: number | null = null;
    if (head.subarray(0, 4).toString("ascii") === "OggS") {
      if (before.size > MAX_AUDIO_BYTES) throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Audio exceeds the safety limit.");
      if (typeof process.getuid === "function" && before.uid !== process.getuid()) throw new UploadValidationError("UPLOAD_SOURCE_UNSAFE", "Audio source owner is invalid.");
      inspectOggOpus(await readExactly(handle, 0, before.size));
      kind = "audio";
      mediaType = "audio/ogg";
    } else if (head.subarray(0, 5).toString("ascii") === "%PDF-") {
      kind = "pdf";
      mediaType = "application/pdf";
    } else if (isLegacyExcelContainer(head)) {
      if (before.size > 16 * 1024 * 1024) throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Legacy workbook exceeds the safety limit.");
      inspectLegacyExcel(await readExactly(handle, 0, before.size));
      kind = "xls";
      mediaType = "application/vnd.ms-excel";
    } else if (startsWith(head, [0x50, 0x4b])) {
      const office = await inspectOfficeArchiveFile(handle, before.size, passiveWorkbook);
      kind = office.kind;
      officeEntries = office.entries;
      mediaType = {
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }[kind];
      if (kind === "xlsx" && extension(fileName) === ".xltx") {
        mediaType = "application/vnd.openxmlformats-officedocument.spreadsheetml.template";
      }
    } else {
      const imageType = detectedImageType(head);
      if (imageType) {
        kind = "image";
        mediaType = imageType;
        if (before.size > MAX_IMAGE_BYTES) {
          throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Image exceeds the safety limit.");
        }
      } else {
        if (before.size > MAX_TEXT_BYTES) {
          throw new UploadValidationError("UPLOAD_TYPE_UNSUPPORTED", "Upload is not a supported text or document format.");
        }
        kind = "text";
        mediaType = declaredMimeType === "application/json" ? "application/json" : "text/plain";
      }
    }
    if (passiveWorkbook) {
      if (kind !== "xlsx") throw new UploadValidationError("UPLOAD_OFFICE_INVALID", "Expected a spreadsheet package.");
      mediaType = "application/vnd.ms-excel.sheet.macroenabled.12";
    } else assertMimeAndExtension(fileName, declaredMimeType, kind, mediaType);

    const hash = createHash("sha256");
    const decoder = kind === "text" ? new TextDecoder("utf-8", { fatal: true }) : null;
    let streamedBytes = 0;
    try {
      const source = handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 64 * 1024 });
      for await (const chunk of source) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        streamedBytes += data.length;
        if (streamedBytes > MAX_FILE_BYTES) {
          throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Upload grew beyond the safety limit.");
        }
        hash.update(data);
        if (decoder) {
          if (data.includes(0)) {
            throw new UploadValidationError("UPLOAD_TYPE_UNSUPPORTED", "Text upload contains NUL bytes.");
          }
          decoder.decode(data, { stream: true });
        }
      }
      decoder?.decode();
    } catch (error) {
      if (error instanceof UploadValidationError) throw error;
      if (error instanceof TypeError && decoder) {
        throw new UploadValidationError("UPLOAD_TYPE_UNSUPPORTED", "Text upload must be valid UTF-8.", { cause: error });
      }
      throw error;
    }
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.nlink !== 1
      || (after.mode & 0o077) !== 0
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || streamedBytes !== before.size
    ) {
      throw new UploadValidationError("UPLOAD_SOURCE_CHANGED", "Upload changed during validation.");
    }
    return {
      kind,
      fileName,
      mediaType,
      size: streamedBytes,
      sha256: hash.digest("hex"),
      officeEntries,
    };
  } finally {
    await handle.close();
  }
}

export const validateUploadedDocumentFile = (input: { fileName: string; declaredMimeType: string; filePath: string }) => validateDocumentFile(input);

/** Private-original admission only. Never feed this package to a converter or worker. */
export async function validateMacroWorkbookOriginal(input: { fileName: string; declaredMimeType: string; filePath: string }) {
  if (extension(safeFileName(input.fileName)) !== ".xlsm" || !["application/vnd.ms-excel.sheet.macroenabled.12", "application/octet-stream"].includes(input.declaredMimeType.trim().toLowerCase())) {
    throw new UploadValidationError("UPLOAD_TYPE_MISMATCH", "Expected XLSM filename and MIME.");
  }
  return validateDocumentFile(input, true);
}
