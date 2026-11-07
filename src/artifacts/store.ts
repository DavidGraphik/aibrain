import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AdvancedArtifactKind,
  AdvancedArtifactSnapshot,
  AdvancedArtifactSummary,
  ArtifactPublication,
  ArtifactSource,
  InternalSiteSnapshotContent,
  VisualizationSnapshotContent,
} from "@/artifacts/contracts";
import { isVisualizationSpec } from "@/artifacts/contracts";
import { contentHash } from "@/artifacts/content-hash";
import { atomicWriteFile, fsyncDirectory, ResourceLockManager } from "@/storage";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 512 * 1024;

type StoredArtifactVersion = {
  version: number;
  createdAt: string;
  source: ArtifactSource;
  contentSha256: string;
};

type StoredArtifactManifest = {
  schemaVersion: 1;
  installationId: string;
  userId: string;
  id: string;
  kind: AdvancedArtifactKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  latestVersion: number;
  versions: StoredArtifactVersion[];
  publications: ArtifactPublication[];
};

export class AdvancedArtifactNotFoundError extends Error {}
export class AdvancedArtifactValidationError extends Error {}
export class AdvancedArtifactConflictError extends Error {}
export class AdvancedArtifactPersistenceError extends Error {}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code));
}

function iso(value: unknown): value is string {
  return typeof value === "string" && new Date(value).toISOString() === value;
}

function source(value: unknown): value is ArtifactSource {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 4 && "projectId" in value && typeof value.projectId === "string" && UUID_PATTERN.test(value.projectId) &&
    "threadId" in value && typeof value.threadId === "string" && UUID_PATTERN.test(value.threadId) &&
    "messageId" in value && typeof value.messageId === "string" && UUID_PATTERN.test(value.messageId) &&
    "messageSha256" in value && typeof value.messageSha256 === "string" && /^[0-9a-f]{64}$/.test(value.messageSha256));
}

function parseManifest(raw: string, expected: { installationId: string; userId: string; artifactId?: string }) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error) {
    throw new AdvancedArtifactPersistenceError("El registro del artefacto está dañado.", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdvancedArtifactPersistenceError("El registro del artefacto no es válido.");
  const item = value as Record<string, unknown>;
  const versions = item.versions;
  const publications = item.publications;
  if (Object.keys(item).length !== 11 || item.schemaVersion !== 1 || item.installationId !== expected.installationId ||
      item.userId !== expected.userId || typeof item.id !== "string" || !UUID_PATTERN.test(item.id) ||
      (expected.artifactId && item.id !== expected.artifactId) || !(item.kind === "visualization" || item.kind === "internal-site") ||
      typeof item.title !== "string" || !item.title.trim() || item.title.length > 120 || !iso(item.createdAt) || !iso(item.updatedAt) ||
      !Number.isSafeInteger(item.latestVersion) || (item.latestVersion as number) < 1 ||
      !Array.isArray(versions) || versions.length !== item.latestVersion || !Array.isArray(publications)) {
    throw new AdvancedArtifactPersistenceError("El registro del artefacto no es válido.");
  }
  if (!versions.every((version, index) => Boolean(version && typeof version === "object" && !Array.isArray(version) &&
      Object.keys(version).length === 4 && "version" in version && version.version === index + 1 &&
      "createdAt" in version && iso(version.createdAt) && "source" in version && source(version.source) &&
      "contentSha256" in version && typeof version.contentSha256 === "string" && /^[0-9a-f]{64}$/.test(version.contentSha256)))) {
    throw new AdvancedArtifactPersistenceError("El historial del artefacto no es válido.");
  }
  if (!publications.every((publication) => Boolean(publication && typeof publication === "object" && !Array.isArray(publication) &&
      Object.keys(publication).length === 3 && "version" in publication && Number.isSafeInteger(publication.version) &&
      (publication.version as number) >= 1 && (publication.version as number) <= (item.latestVersion as number) &&
      "publishedAt" in publication && iso(publication.publishedAt) && "htmlSha256" in publication &&
      typeof publication.htmlSha256 === "string" && /^[0-9a-f]{64}$/.test(publication.htmlSha256))) ||
      new Set(publications.map((publication) => (publication as { version: number }).version)).size !== publications.length) {
    throw new AdvancedArtifactPersistenceError("El historial de publicación no es válido.");
  }
  return item as StoredArtifactManifest;
}

function parseSnapshot(raw: string, manifest: StoredArtifactManifest, version: number) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error) {
    throw new AdvancedArtifactPersistenceError("La versión del artefacto está dañada.", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdvancedArtifactPersistenceError("La versión del artefacto no es válida.");
  const item = value as Record<string, unknown>;
  const content = item.content;
  if (Object.keys(item).length !== 8 || item.schemaVersion !== 1 || item.artifactId !== manifest.id || item.version !== version ||
      item.title !== manifest.title || !source(item.source) || !iso(item.createdAt) ||
      typeof item.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.contentSha256) ||
      !content || typeof content !== "object" || Array.isArray(content)) {
    throw new AdvancedArtifactPersistenceError("La versión del artefacto no es válida.");
  }
  const typedContent = content as Record<string, unknown>;
  const validContent = manifest.kind === "visualization"
    ? Object.keys(typedContent).length === 2 && typedContent.kind === "visualization" && isVisualizationSpec(typedContent.spec)
    : Object.keys(typedContent).length === 2 && typedContent.kind === "internal-site" && typeof typedContent.html === "string" && typedContent.html.length <= 250_000;
  if (!validContent || contentHash(content) !== item.contentSha256 || manifest.versions[version - 1]?.contentSha256 !== item.contentSha256) {
    throw new AdvancedArtifactPersistenceError("La versión del artefacto no supera la verificación de integridad.");
  }
  return item as unknown as AdvancedArtifactSnapshot;
}

async function readBounded(filePath: string, maximum: number) {
  let metadata;
  try { metadata = await lstat(filePath); } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new AdvancedArtifactNotFoundError("Artefacto no encontrado.");
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximum) {
    throw new AdvancedArtifactPersistenceError("El fichero del artefacto no es seguro.");
  }
  const handle = await open(filePath, constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0));
  try { return await handle.readFile("utf8"); } finally { await handle.close(); }
}

async function writeExclusive(filePath: string, data: string) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(filePath, "wx", 0o600); } catch (error) {
    if (isNodeError(error, "EEXIST")) throw new AdvancedArtifactConflictError("La versión ya existe y no puede sobrescribirse.");
    throw error;
  }
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await fsyncDirectory(path.dirname(filePath));
}

function summary(manifest: StoredArtifactManifest): AdvancedArtifactSummary {
  const latest = manifest.versions.at(-1)!;
  const prefix = `/api/artifacts/${manifest.id}`;
  const latestPublished = manifest.publications.at(-1)?.version ?? null;
  return {
    id: manifest.id,
    kind: manifest.kind,
    title: manifest.title,
    projectId: latest.source.projectId,
    threadId: latest.source.threadId,
    messageId: latest.source.messageId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    latestVersion: manifest.latestVersion,
    publishedVersions: manifest.publications.map((publication) => publication.version),
    previewUrl: `${prefix}/preview`,
    downloadHtmlUrl: `${prefix}/download?format=html`,
    downloadZipUrl: `${prefix}/download?format=zip`,
    internalSiteUrl: latestPublished ? `${prefix}/published/${latestPublished}` : null,
  };
}

export class FileAdvancedArtifactStore {
  private readonly rootDirectory: string;
  private readonly installationId: string;
  private readonly autoProvisionUsers: boolean;

  constructor(options: { rootDirectory: string; installationId: string; autoProvisionUsers?: boolean }) {
    if (!path.isAbsolute(options.rootDirectory) || !INSTALLATION_PATTERN.test(options.installationId)) {
      throw new AdvancedArtifactValidationError("La configuración del almacén de artefactos no es válida.");
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.installationId = options.installationId;
    this.autoProvisionUsers = options.autoProvisionUsers ?? false;
  }

  private async paths(userId: string, artifactId?: string, version?: number) {
    if (!UUID_PATTERN.test(userId) || (artifactId && !UUID_PATTERN.test(artifactId)) ||
        (version !== undefined && (!Number.isSafeInteger(version) || version < 1))) {
      throw new AdvancedArtifactValidationError("Identificador de artefacto no válido.");
    }
    if (this.autoProvisionUsers) {
      await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
      await mkdir(path.join(this.rootDirectory, userId), { recursive: true, mode: 0o700 });
    }
    let rootReal: string;
    let userReal: string;
    try { [rootReal, userReal] = await Promise.all([realpath(this.rootDirectory), realpath(path.join(this.rootDirectory, userId))]); }
    catch (error) { throw new AdvancedArtifactPersistenceError("El usuario no tiene un espacio de artefactos preparado.", { cause: error }); }
    if (!inside(rootReal, userReal)) throw new AdvancedArtifactPersistenceError("La ruta del artefacto sale del espacio del usuario.");
    const artifactsRoot = path.join(userReal, "state", "advanced-artifacts");
    const lockRoot = path.join(userReal, "state", ".artifact-locks");
    await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(artifactsRoot, 0o700), chmod(lockRoot, 0o700)]);
    const artifactRoot = artifactId ? path.join(artifactsRoot, artifactId) : null;
    return {
      artifactsRoot, lockRoot, artifactRoot,
      manifestPath: artifactRoot ? path.join(artifactRoot, "manifest.json") : null,
      versionPath: artifactRoot && version ? path.join(artifactRoot, "versions", `${version}.json`) : null,
      publicationPath: artifactRoot && version ? path.join(artifactRoot, "published", `${version}.html`) : null,
    };
  }

  private async manifest(userId: string, artifactId: string) {
    const paths = await this.paths(userId, artifactId);
    return parseManifest(await readBounded(paths.manifestPath!, MAX_MANIFEST_BYTES), {
      installationId: this.installationId, userId, artifactId,
    });
  }

  async list(userId: string) {
    const paths = await this.paths(userId);
    const entries = await readdir(paths.artifactsRoot, { withFileTypes: true });
    const items: AdvancedArtifactSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      items.push(summary(await this.manifest(userId, entry.name)));
    }
    return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(userId: string, artifactId: string, requestedVersion?: number) {
    const manifest = await this.manifest(userId, artifactId);
    const version = requestedVersion ?? manifest.latestVersion;
    if (version > manifest.latestVersion) throw new AdvancedArtifactNotFoundError("Versión no encontrada.");
    const paths = await this.paths(userId, artifactId, version);
    return { summary: summary(manifest), snapshot: parseSnapshot(await readBounded(paths.versionPath!, MAX_SNAPSHOT_BYTES), manifest, version) };
  }

  async create(userId: string, input: {
    title: string;
    source: ArtifactSource;
    content: VisualizationSnapshotContent | InternalSiteSnapshotContent;
  }) {
    const artifactId = randomUUID();
    const paths = await this.paths(userId, artifactId, 1);
    const createdAt = new Date().toISOString();
    const hash = contentHash(input.content);
    const snapshot: AdvancedArtifactSnapshot = {
      schemaVersion: 1, artifactId, version: 1, title: input.title, source: input.source,
      createdAt, content: input.content, contentSha256: hash,
    };
    const manifest: StoredArtifactManifest = {
      schemaVersion: 1, installationId: this.installationId, userId, id: artifactId,
      kind: input.content.kind, title: input.title, createdAt, updatedAt: createdAt, latestVersion: 1,
      versions: [{ version: 1, createdAt, source: input.source, contentSha256: hash }], publications: [],
    };
    await writeExclusive(paths.versionPath!, `${JSON.stringify(snapshot, null, 2)}\n`);
    await atomicWriteFile(paths.manifestPath!, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { summary: summary(manifest), snapshot };
  }

  async createVersion(userId: string, artifactId: string, input: {
    source: ArtifactSource;
    content: VisualizationSnapshotContent | InternalSiteSnapshotContent;
  }) {
    const base = await this.paths(userId, artifactId);
    return new ResourceLockManager({ rootDirectory: base.lockRoot }).withLock(`advanced-artifact:${artifactId}`, async () => {
      const manifest = await this.manifest(userId, artifactId);
      if (manifest.kind !== input.content.kind) throw new AdvancedArtifactValidationError("La versión debe conservar el tipo del artefacto.");
      const version = manifest.latestVersion + 1;
      const paths = await this.paths(userId, artifactId, version);
      const createdAt = new Date().toISOString();
      const hash = contentHash(input.content);
      const snapshot: AdvancedArtifactSnapshot = {
        schemaVersion: 1, artifactId, version, title: manifest.title, source: input.source,
        createdAt, content: input.content, contentSha256: hash,
      };
      await writeExclusive(paths.versionPath!, `${JSON.stringify(snapshot, null, 2)}\n`);
      manifest.latestVersion = version;
      manifest.updatedAt = createdAt;
      manifest.versions.push({ version, createdAt, source: input.source, contentSha256: hash });
      await atomicWriteFile(paths.manifestPath!, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      return { summary: summary(manifest), snapshot };
    });
  }

  async publish(userId: string, artifactId: string, render: (snapshot: AdvancedArtifactSnapshot) => string) {
    const base = await this.paths(userId, artifactId);
    return new ResourceLockManager({ rootDirectory: base.lockRoot }).withLock(`advanced-artifact:${artifactId}`, async () => {
      const manifest = await this.manifest(userId, artifactId);
      const version = manifest.latestVersion;
      const existing = manifest.publications.find((publication) => publication.version === version);
      if (existing) return { summary: summary(manifest), publication: existing };
      const snapshot = (await this.get(userId, artifactId, version)).snapshot;
      const html = render(snapshot);
      const htmlSha256 = createHash("sha256").update(html).digest("hex");
      const paths = await this.paths(userId, artifactId, version);
      await writeExclusive(paths.publicationPath!, html);
      const publication = { version, publishedAt: new Date().toISOString(), htmlSha256 };
      manifest.publications.push(publication);
      manifest.updatedAt = publication.publishedAt;
      await atomicWriteFile(paths.manifestPath!, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      return { summary: summary(manifest), publication };
    });
  }

  async readPublished(userId: string, artifactId: string, version: number) {
    const manifest = await this.manifest(userId, artifactId);
    const publication = manifest.publications.find((item) => item.version === version);
    if (!publication) throw new AdvancedArtifactNotFoundError("Publicación interna no encontrada.");
    const paths = await this.paths(userId, artifactId, version);
    const html = await readBounded(paths.publicationPath!, MAX_SNAPSHOT_BYTES * 2);
    if (createHash("sha256").update(html).digest("hex") !== publication.htmlSha256) {
      throw new AdvancedArtifactPersistenceError("La publicación interna no supera la verificación de integridad.");
    }
    return { html, summary: summary(manifest), publication };
  }
}
