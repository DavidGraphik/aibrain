import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { StagedDocument } from "@/documents/staging-store";
import { ensurePrivateDirectoryTree } from "@/documents/staging-store";
import { atomicWriteJson, readValidatedJson } from "@/storage/atomic-file";
import { StorageError } from "@/storage/errors";
import type { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectOneOf,
  expectStrictRecord,
  expectString,
  type ValidationContext,
} from "@/storage/schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAXIMUM_VERSIONS = 100;
const MAXIMUM_MANIFEST_BYTES = 512 * 1024;

export type DocumentScope = Readonly<{
  kind: "private" | "project" | "company";
  id: string;
}>;

export type DocumentVersionAuthor = Readonly<{
  userId: string;
  name: string;
}>;

export type StoredDocumentVersion = Readonly<{
  versionId: string;
  number: number;
  contentUploadId: string;
  etag: string;
  fileName: string;
  kind: StagedDocument["kind"];
  mediaType: string;
  size: number;
  sha256: string;
  author: DocumentVersionAuthor;
  createdAt: string;
  provenance: Readonly<{
    type: "original_upload" | "roundtrip_upload" | "restore";
    sourceVersionId: string | null;
  }>;
}>;

export type VersionedDocument = Readonly<{
  schemaVersion: 1;
  documentId: string;
  threadId: string;
  title: string;
  scope: DocumentScope;
  originalVersionId: string;
  latestVersionId: string;
  createdAt: string;
  updatedAt: string;
  versions: StoredDocumentVersion[];
}>;

function parseScope(value: unknown, context: ValidationContext): DocumentScope {
  const record = expectStrictRecord(value, ["kind", "id"], context);
  return {
    kind: expectOneOf(record.kind, ["private", "project", "company"] as const, context.at("kind")),
    id: expectString(record.id, context.at("id"), { minLength: 1, maxLength: 120, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ }),
  };
}

function parseAuthor(value: unknown, context: ValidationContext): DocumentVersionAuthor {
  const record = expectStrictRecord(value, ["userId", "name"], context);
  return {
    userId: expectString(record.userId, context.at("userId"), {
      minLength: 1,
      maxLength: 120,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    }),
    name: expectString(record.name, context.at("name"), { minLength: 1, maxLength: 120, pattern: /^[^\u0000-\u001f\u007f]+$/u }),
  };
}

function parseProvenance(value: unknown, context: ValidationContext) {
  const record = expectStrictRecord(value, ["type", "sourceVersionId"], context);
  return {
    type: expectOneOf(record.type, ["original_upload", "roundtrip_upload", "restore"] as const, context.at("type")),
    sourceVersionId: record.sourceVersionId === null
      ? null
      : expectString(record.sourceVersionId, context.at("sourceVersionId"), { pattern: UUID }),
  };
}

function parseVersion(value: unknown, context: ValidationContext): StoredDocumentVersion {
  const record = expectStrictRecord(value, [
    "versionId", "number", "contentUploadId", "etag", "fileName", "kind", "mediaType",
    "size", "sha256", "author", "createdAt", "provenance",
  ], context);
  return {
    versionId: expectString(record.versionId, context.at("versionId"), { pattern: UUID }),
    number: expectInteger(record.number, context.at("number"), { minimum: 1, maximum: MAXIMUM_VERSIONS }),
    contentUploadId: expectString(record.contentUploadId, context.at("contentUploadId"), { pattern: UUID }),
    etag: expectString(record.etag, context.at("etag"), { pattern: SHA256 }),
    fileName: expectString(record.fileName, context.at("fileName"), { minLength: 1, maxLength: 120 }),
    kind: expectOneOf(record.kind, ["docx", "xlsx", "xls", "pptx", "pdf", "text", "image", "audio"] as const, context.at("kind")),
    mediaType: expectString(record.mediaType, context.at("mediaType"), { minLength: 1, maxLength: 180 }),
    size: expectInteger(record.size, context.at("size"), { minimum: 1, maximum: 50 * 1024 * 1024 }),
    sha256: expectString(record.sha256, context.at("sha256"), { pattern: SHA256 }),
    author: parseAuthor(record.author, context.at("author")),
    createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
    provenance: parseProvenance(record.provenance, context.at("provenance")),
  };
}

const versionedDocumentSchema = defineVersionedSchema<VersionedDocument>({
  name: "VersionedDocument",
  schemaVersion: 1,
  keys: [
    "documentId", "threadId", "title", "scope", "originalVersionId", "latestVersionId",
    "createdAt", "updatedAt", "versions",
  ],
  parse(record, context) {
    const parsed: VersionedDocument = {
      schemaVersion: 1,
      documentId: expectString(record.documentId, context.at("documentId"), { pattern: UUID }),
      threadId: expectString(record.threadId, context.at("threadId"), { pattern: UUID }),
      title: expectString(record.title, context.at("title"), { minLength: 1, maxLength: 120 }),
      scope: parseScope(record.scope, context.at("scope")),
      originalVersionId: expectString(record.originalVersionId, context.at("originalVersionId"), { pattern: UUID }),
      latestVersionId: expectString(record.latestVersionId, context.at("latestVersionId"), { pattern: UUID }),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
      updatedAt: expectIsoDate(record.updatedAt, context.at("updatedAt")),
      versions: expectArray(record.versions, context.at("versions"), parseVersion, { maxLength: MAXIMUM_VERSIONS }),
    };
    if (parsed.versions.length < 1) context.at("versions").fail("must contain the original version");
    if (parsed.versions.some((version, index) => version.number !== index + 1)) {
      context.at("versions").fail("must be contiguous and ordered");
    }
    if (new Set(parsed.versions.map((version) => version.versionId)).size !== parsed.versions.length) {
      context.at("versions").fail("must contain unique version ids");
    }
    if (parsed.versions[0]?.versionId !== parsed.originalVersionId ||
        parsed.versions.at(-1)?.versionId !== parsed.latestVersionId) {
      context.fail("version pointers do not match the version history");
    }
    for (const version of parsed.versions) {
      const source = version.provenance.sourceVersionId;
      if (version.number === 1 && (version.provenance.type !== "original_upload" || source !== null)) {
        context.at("versions").at(0).fail("must be the original upload");
      }
      if (version.number > 1 && version.provenance.type === "original_upload") {
        context.at("versions").at(version.number - 1).fail("cannot repeat original provenance");
      }
      if (source && !parsed.versions.slice(0, version.number - 1).some((candidate) => candidate.versionId === source)) {
        context.at("versions").at(version.number - 1).fail("references a non-prior source version");
      }
    }
    return parsed;
  },
});

function versionEtag(documentId: string, versionId: string, sha256: string, number: number) {
  return createHash("sha256").update(`${documentId}\0${versionId}\0${sha256}\0${number}`).digest("hex");
}

function versionFromStaged(input: {
  documentId: string;
  versionId: string;
  number: number;
  document: StagedDocument;
  author: DocumentVersionAuthor;
  createdAt: string;
  provenance: StoredDocumentVersion["provenance"];
}): StoredDocumentVersion {
  return {
    versionId: input.versionId,
    number: input.number,
    contentUploadId: input.document.uploadId,
    etag: versionEtag(input.documentId, input.versionId, input.document.sha256, input.number),
    fileName: input.document.fileName,
    kind: input.document.kind,
    mediaType: input.document.mediaType,
    size: input.document.size,
    sha256: input.document.sha256,
    author: input.author,
    createdAt: input.createdAt,
    provenance: input.provenance,
  };
}

function sameContent(version: StoredDocumentVersion, document: StagedDocument) {
  return version.contentUploadId === document.uploadId && version.fileName === document.fileName &&
    version.kind === document.kind && version.mediaType === document.mediaType &&
    version.size === document.size && version.sha256 === document.sha256;
}

export class FileDocumentVersionStore {
  readonly rootDirectory: string;

  constructor(
    rootDirectory: string,
    private readonly lockManager: ResourceLockManager,
    private readonly now: () => number = Date.now,
  ) {
    if (!path.isAbsolute(rootDirectory) || rootDirectory === path.parse(rootDirectory).root) {
      throw new StorageError("DOCUMENT_VERSION_OPTIONS_INVALID", "Document history root must be a non-root absolute path.");
    }
    this.rootDirectory = path.resolve(rootDirectory);
  }

  private locations(threadId: string, documentId: string) {
    if (!UUID.test(threadId) || !UUID.test(documentId)) {
      throw new StorageError("DOCUMENT_VERSION_ID_INVALID", "Document history ids must be UUIDs.");
    }
    const directory = path.join(this.rootDirectory, threadId, documentId);
    return { directory, manifestPath: path.join(directory, "document.json") };
  }

  private async readManifest(manifestPath: string) {
    const relativeDirectory = path.relative(this.rootDirectory, path.dirname(manifestPath));
    if (!relativeDirectory || relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
      throw new StorageError("DOCUMENT_VERSION_MANIFEST_UNSAFE", "Document history path escapes its private root.");
    }
    let directory = this.rootDirectory;
    for (const segment of ["", ...relativeDirectory.split(path.sep)]) {
      if (segment) directory = path.join(directory, segment);
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
        throw new StorageError("DOCUMENT_VERSION_MANIFEST_UNSAFE", "Document history contains an unsafe directory.");
      }
    }
    const metadata = await lstat(manifestPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
        metadata.size > MAXIMUM_MANIFEST_BYTES || (metadata.mode & 0o077) !== 0) {
      throw new StorageError("DOCUMENT_VERSION_MANIFEST_UNSAFE", "Document history is not a private regular file.");
    }
    return readValidatedJson(manifestPath, versionedDocumentSchema);
  }

  async create(input: {
    threadId: string;
    documentId: string;
    document: StagedDocument;
    author: DocumentVersionAuthor;
    scope: DocumentScope;
  }) {
    const locations = this.locations(input.threadId, input.documentId);
    return this.lockManager.withLock(`document-history:${locations.manifestPath}`, async () => {
      try {
        const existing = await this.readManifest(locations.manifestPath);
        if (existing.threadId !== input.threadId || existing.documentId !== input.documentId ||
            existing.scope.kind !== input.scope.kind || existing.scope.id !== input.scope.id ||
            !sameContent(existing.versions[0]!, input.document)) {
          throw new StorageError("DOCUMENT_VERSION_CONFLICT", "Document id already identifies different history.");
        }
        return existing;
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      const createdAt = new Date(this.now()).toISOString();
      const original = versionFromStaged({
        documentId: input.documentId,
        versionId: input.document.uploadId,
        number: 1,
        document: input.document,
        author: input.author,
        createdAt,
        provenance: { type: "original_upload", sourceVersionId: null },
      });
      const manifest: VersionedDocument = {
        schemaVersion: 1,
        documentId: input.documentId,
        threadId: input.threadId,
        title: input.document.fileName,
        scope: input.scope,
        originalVersionId: original.versionId,
        latestVersionId: original.versionId,
        createdAt,
        updatedAt: createdAt,
        versions: [original],
      };
      await ensurePrivateDirectoryTree(this.rootDirectory, [input.threadId, input.documentId]);
      await atomicWriteJson(locations.manifestPath, manifest, versionedDocumentSchema);
      return manifest;
    });
  }

  async read(threadId: string, documentId: string) {
    const locations = this.locations(threadId, documentId);
    const manifest = await this.readManifest(locations.manifestPath);
    if (manifest.threadId !== threadId || manifest.documentId !== documentId) {
      throw new StorageError("DOCUMENT_VERSION_MISMATCH", "Document history identity does not match its path.");
    }
    return manifest;
  }

  async appendUpload(input: {
    threadId: string;
    documentId: string;
    versionId: string;
    baseEtag: string;
    document: StagedDocument;
    author: DocumentVersionAuthor;
  }) {
    if (!UUID.test(input.versionId) || !SHA256.test(input.baseEtag)) {
      throw new StorageError("DOCUMENT_VERSION_REQUEST_INVALID", "Version request is invalid.");
    }
    const locations = this.locations(input.threadId, input.documentId);
    return this.lockManager.withLock(`document-history:${locations.manifestPath}`, async () => {
      const manifest = await this.readManifest(locations.manifestPath);
      const original = manifest.versions[0]!;
      if (input.document.kind !== original.kind || input.document.mediaType !== original.mediaType) {
        throw new StorageError("DOCUMENT_VERSION_TYPE_MISMATCH", "A new version must retain the original document format.");
      }
      const replay = manifest.versions.find((version) => version.versionId === input.versionId);
      if (replay) {
        if (!sameContent(replay, input.document)) {
          throw new StorageError("DOCUMENT_VERSION_CONFLICT", "Version id already identifies different content.");
        }
        return manifest;
      }
      const latest = manifest.versions.at(-1)!;
      if (latest.etag !== input.baseEtag) {
        throw new StorageError("DOCUMENT_VERSION_CONFLICT", "The document changed after the selected base version.");
      }
      if (manifest.versions.length >= MAXIMUM_VERSIONS) {
        throw new StorageError("DOCUMENT_VERSION_LIMIT", "Document version history reached its safety limit.");
      }
      const createdAt = new Date(this.now()).toISOString();
      const version = versionFromStaged({
        documentId: input.documentId,
        versionId: input.versionId,
        number: manifest.versions.length + 1,
        document: input.document,
        author: input.author,
        createdAt,
        provenance: { type: "roundtrip_upload", sourceVersionId: latest.versionId },
      });
      const updated: VersionedDocument = {
        ...manifest,
        title: input.document.fileName,
        latestVersionId: version.versionId,
        updatedAt: createdAt,
        versions: [...manifest.versions, version],
      };
      await atomicWriteJson(locations.manifestPath, updated, versionedDocumentSchema);
      return updated;
    });
  }

  async restore(input: {
    threadId: string;
    documentId: string;
    sourceVersionId: string;
    restoreVersionId: string;
    baseEtag: string;
    author: DocumentVersionAuthor;
  }) {
    if (!UUID.test(input.sourceVersionId) || !UUID.test(input.restoreVersionId) || !SHA256.test(input.baseEtag)) {
      throw new StorageError("DOCUMENT_VERSION_REQUEST_INVALID", "Restore request is invalid.");
    }
    const locations = this.locations(input.threadId, input.documentId);
    return this.lockManager.withLock(`document-history:${locations.manifestPath}`, async () => {
      const manifest = await this.readManifest(locations.manifestPath);
      const replay = manifest.versions.find((version) => version.versionId === input.restoreVersionId);
      if (replay) {
        if (replay.provenance.type !== "restore" || replay.provenance.sourceVersionId !== input.sourceVersionId) {
          throw new StorageError("DOCUMENT_VERSION_CONFLICT", "Restore id already identifies a different version.");
        }
        return manifest;
      }
      const latest = manifest.versions.at(-1)!;
      if (latest.etag !== input.baseEtag) {
        throw new StorageError("DOCUMENT_VERSION_CONFLICT", "The document changed after the selected base version.");
      }
      const source = manifest.versions.find((version) => version.versionId === input.sourceVersionId);
      if (!source) throw new StorageError("DOCUMENT_VERSION_NOT_FOUND", "Source version was not found.");
      if (manifest.versions.length >= MAXIMUM_VERSIONS) {
        throw new StorageError("DOCUMENT_VERSION_LIMIT", "Document version history reached its safety limit.");
      }
      const createdAt = new Date(this.now()).toISOString();
      const version: StoredDocumentVersion = {
        ...source,
        versionId: input.restoreVersionId,
        number: manifest.versions.length + 1,
        etag: versionEtag(input.documentId, input.restoreVersionId, source.sha256, manifest.versions.length + 1),
        author: input.author,
        createdAt,
        provenance: { type: "restore", sourceVersionId: source.versionId },
      };
      const updated: VersionedDocument = {
        ...manifest,
        title: source.fileName,
        latestVersionId: version.versionId,
        updatedAt: createdAt,
        versions: [...manifest.versions, version],
      };
      await atomicWriteJson(locations.manifestPath, updated, versionedDocumentSchema);
      return updated;
    });
  }
}

export function quotedDocumentEtag(value: string) {
  return `"${value}"`;
}

export function parseIfMatch(value: string | null) {
  if (!value) return null;
  const match = value.match(/^"([0-9a-f]{64})"$/);
  return match?.[1] ?? null;
}
