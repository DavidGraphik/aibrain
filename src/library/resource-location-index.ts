import "server-only";

import path from "node:path";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectOneOf,
  expectString,
  readValidatedJson,
  ResourceLockManager,
  type ValidationContext,
} from "@/storage";

export type LibraryResourceKind =
  | "upload"
  | "generated-image"
  | "generated-document"
  | "workspace-file"
  | "advanced-artifact";

export type LibraryResourceLocation = {
  schemaVersion: 1;
  kind: LibraryResourceKind;
  resourceId: string;
  projectId: string;
  threadId: string;
  messageId: string | null;
  storageOwnerId: string;
  relativePath: string | null;
  fileName: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
};

type LibraryResourceLocationState = {
  schemaVersion: 1;
  installationId: string;
  updatedAt: string;
  resources: LibraryResourceLocation[];
};

export type RegisterLibraryResourceLocation = Omit<
  LibraryResourceLocation,
  "schemaVersion" | "createdAt" | "updatedAt"
>;

export class LibraryResourceLocationConflictError extends Error {}
export class LibraryResourceLocationNotFoundError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAXIMUM_INDEXED_RESOURCE_BYTES = 100 * 1024 * 1024;

function nullableUuid(value: unknown, context: ValidationContext) {
  return value === null
    ? null
    : expectString(value, context, { minLength: 36, maxLength: 36, pattern: UUID });
}

function nullableRelativePath(value: unknown, context: ValidationContext) {
  if (value === null) return null;
  const candidate = expectString(value, context, { minLength: 1, maxLength: 2_048 });
  if (path.posix.isAbsolute(candidate) || candidate.includes("\\") || candidate.includes("\0") ||
      candidate.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    context.fail("expected a normalized relative POSIX path");
  }
  return candidate;
}

const locationSchema = defineVersionedSchema<LibraryResourceLocation>({
  name: "LibraryResourceLocation",
  schemaVersion: 1,
  keys: [
    "kind", "resourceId", "projectId", "threadId", "messageId", "storageOwnerId",
    "relativePath", "fileName", "mediaType", "size", "sha256", "createdAt", "updatedAt",
  ],
  parse(record, context) {
    return {
      schemaVersion: 1,
      kind: expectOneOf(record.kind, [
        "upload", "generated-image", "generated-document", "workspace-file", "advanced-artifact",
      ] as const, context.at("kind")),
      resourceId: expectString(record.resourceId, context.at("resourceId"), { pattern: UUID }),
      projectId: expectString(record.projectId, context.at("projectId"), { pattern: UUID }),
      threadId: expectString(record.threadId, context.at("threadId"), { pattern: UUID }),
      messageId: nullableUuid(record.messageId, context.at("messageId")),
      storageOwnerId: expectString(record.storageOwnerId, context.at("storageOwnerId"), { pattern: UUID }),
      relativePath: nullableRelativePath(record.relativePath, context.at("relativePath")),
      fileName: expectString(record.fileName, context.at("fileName"), {
        minLength: 1,
        maxLength: 160,
        pattern: /^[^/\\\u0000-\u001f\u007f]+$/u,
      }),
      mediaType: expectString(record.mediaType, context.at("mediaType"), {
        minLength: 1,
        maxLength: 180,
        pattern: /^[^\u0000-\u001f\u007f]+$/u,
      }),
      size: expectInteger(record.size, context.at("size"), {
        minimum: 0,
        maximum: MAXIMUM_INDEXED_RESOURCE_BYTES,
      }),
      sha256: expectString(record.sha256, context.at("sha256"), { pattern: SHA256 }),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
      updatedAt: expectIsoDate(record.updatedAt, context.at("updatedAt")),
    };
  },
});

const stateSchema = defineVersionedSchema<LibraryResourceLocationState>({
  name: "LibraryResourceLocationState",
  schemaVersion: 1,
  keys: ["installationId", "updatedAt", "resources"],
  parse(record, context) {
    const resources = expectArray(
      record.resources,
      context.at("resources"),
      (value, item) => locationSchema.parse(value, `${item.source}${item.path}`),
      { maxLength: 100_000 },
    );
    const keys = resources.map((resource) => `${resource.kind}:${resource.resourceId}`);
    if (new Set(keys).size !== keys.length) context.at("resources").fail("resource keys must be unique");
    return {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 1,
        maxLength: 120,
        pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
      }),
      updatedAt: expectIsoDate(record.updatedAt, context.at("updatedAt")),
      resources,
    };
  },
});

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function resourceKey(kind: LibraryResourceKind, resourceId: string) {
  return `${kind}:${resourceId}`;
}

function sameStableBinding(
  current: LibraryResourceLocation,
  next: RegisterLibraryResourceLocation,
) {
  return current.kind === next.kind && current.resourceId === next.resourceId &&
    current.projectId === next.projectId && current.threadId === next.threadId &&
    current.messageId === next.messageId && current.storageOwnerId === next.storageOwnerId &&
    current.relativePath === next.relativePath && current.fileName === next.fileName &&
    current.mediaType === next.mediaType;
}

export class FileLibraryResourceLocationIndex {
  private readonly filePath: string;
  private readonly locks: ResourceLockManager;
  private readonly installationId: string;
  private readonly now: () => number;

  constructor(options: { dataRoot: string; installationId: string; now?: () => number }) {
    if (!path.isAbsolute(options.dataRoot) || options.dataRoot === path.parse(options.dataRoot).root) {
      throw new Error("Library resource location dataRoot must be an absolute non-root path.");
    }
    const root = path.join(path.resolve(options.dataRoot), "library-resource-locations");
    this.filePath = path.join(root, "index.json");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(root, "locks") });
    this.installationId = options.installationId;
    this.now = options.now ?? Date.now;
  }

  private emptyState(): LibraryResourceLocationState {
    return {
      schemaVersion: 1,
      installationId: this.installationId,
      updatedAt: new Date(this.now()).toISOString(),
      resources: [],
    };
  }

  private async read() {
    try {
      const state = await readValidatedJson(this.filePath, stateSchema);
      if (state.installationId !== this.installationId) {
        throw new Error("Library resource location index belongs to another installation.");
      }
      return state;
    } catch (error) {
      if (isMissing(error)) return this.emptyState();
      throw error;
    }
  }

  async register(input: RegisterLibraryResourceLocation) {
    const parsed = locationSchema.parse({
      schemaVersion: 1,
      ...input,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    });
    return this.locks.withLock(`library-resource-locations:${this.installationId}`, async () => {
      const state = await this.read();
      const key = resourceKey(parsed.kind, parsed.resourceId);
      const current = state.resources.find((resource) => resourceKey(resource.kind, resource.resourceId) === key);
      if (current) {
        if (!sameStableBinding(current, input)) {
          throw new LibraryResourceLocationConflictError("El recurso ya está ligado a otra ubicación o contenido.");
        }
        if (current.size !== input.size || current.sha256 !== input.sha256) {
          if (current.kind !== "workspace-file") {
            throw new LibraryResourceLocationConflictError("El recurso ya está ligado a otra ubicación o contenido.");
          }
          const updated = locationSchema.parse({
            ...current,
            size: input.size,
            sha256: input.sha256,
            updatedAt: parsed.updatedAt,
          });
          const next = {
            ...state,
            updatedAt: parsed.updatedAt,
            resources: state.resources.map((resource) =>
              resourceKey(resource.kind, resource.resourceId) === key ? updated : resource),
          };
          await atomicWriteJson(this.filePath, next, stateSchema, { mode: 0o600 });
          return updated;
        }
        return current;
      }
      const next = {
        ...state,
        updatedAt: parsed.updatedAt,
        resources: [...state.resources, parsed],
      };
      await atomicWriteJson(this.filePath, next, stateSchema, { mode: 0o600 });
      return parsed;
    });
  }

  async updateIntegrity(
    kind: LibraryResourceKind,
    resourceId: string,
    input: { size: number; sha256: string },
  ) {
    if (kind !== "advanced-artifact") {
      throw new LibraryResourceLocationConflictError("Los blobs indexados son inmutables.");
    }
    return this.locks.withLock(`library-resource-locations:${this.installationId}`, async () => {
      const state = await this.read();
      const key = resourceKey(kind, resourceId);
      const current = state.resources.find((resource) => resourceKey(resource.kind, resource.resourceId) === key);
      if (!current) throw new LibraryResourceLocationNotFoundError("Recurso no indexado.");
      const updatedAt = new Date(this.now()).toISOString();
      const updated = locationSchema.parse({ ...current, ...input, updatedAt });
      const next = {
        ...state,
        updatedAt,
        resources: state.resources.map((resource) =>
          resourceKey(resource.kind, resource.resourceId) === key ? updated : resource),
      };
      await atomicWriteJson(this.filePath, next, stateSchema, { mode: 0o600 });
      return updated;
    });
  }

  async binding(kind: LibraryResourceKind, resourceId: string) {
    const state = await this.read();
    return state.resources.find((resource) => resource.kind === kind && resource.resourceId === resourceId) ?? null;
  }

  async resolve(
    kind: LibraryResourceKind,
    resourceId: string,
    expected: { projectId: string; threadId?: string },
  ) {
    const state = await this.read();
    const resource = state.resources.find((candidate) =>
      candidate.kind === kind && candidate.resourceId === resourceId &&
      candidate.projectId === expected.projectId &&
      (expected.threadId === undefined || candidate.threadId === expected.threadId));
    if (!resource) throw new LibraryResourceLocationNotFoundError("Recurso no indexado.");
    return resource;
  }

  async listForProjects(projectIds: ReadonlySet<string>, kind?: LibraryResourceKind) {
    const state = await this.read();
    return state.resources.filter((resource) => projectIds.has(resource.projectId) &&
      (kind === undefined || resource.kind === kind));
  }
}
