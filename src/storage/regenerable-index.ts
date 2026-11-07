import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/canonical-json";
import path from "node:path";
import {
  atomicWriteJson,
  recoverAtomicJsonFile,
} from "@/storage/atomic-file";
import { StorageCorruptionError, StorageError } from "@/storage/errors";
import { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectArray,
  expectIsoDate,
  expectString,
  type StorageSchema,
} from "@/storage/schema";

export type RegenerableIndexSnapshot<Entry> = {
  schemaVersion: 1;
  generatedAt: string;
  sourceFingerprint: string;
  entries: Entry[];
};

export type IndexBuildResult<Entry> = {
  sourceFingerprint: string;
  entries: readonly Entry[];
};

export type RegenerableFileIndexOptions<Entry> = {
  filePath: string;
  lockManager: ResourceLockManager;
  entrySchema: StorageSchema<Entry>;
  build: () => IndexBuildResult<Entry> | Promise<IndexBuildResult<Entry>>;
  now?: () => number;
};

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code,
  );
}

export function fingerprintJson(value: unknown) {
  const serialized = canonicalJson(value, detail => new StorageError(
    "STORAGE_FINGERPRINT_INVALID", `Fingerprint input ${detail}`,
  ));
  return createHash("sha256").update(serialized).digest("hex");
}

function createIndexSchema<Entry>(entrySchema: StorageSchema<Entry>) {
  return defineVersionedSchema<RegenerableIndexSnapshot<Entry>>({
    name: `RegenerableIndex<${entrySchema.name}>`,
    schemaVersion: 1,
    keys: ["generatedAt", "sourceFingerprint", "entries"],
    parse(record, context) {
      return {
        schemaVersion: 1,
        generatedAt: expectIsoDate(record.generatedAt, context.at("generatedAt")),
        sourceFingerprint: expectString(
          record.sourceFingerprint,
          context.at("sourceFingerprint"),
          { minLength: 64, maxLength: 64, pattern: /^[0-9a-f]+$/ },
        ),
        entries: expectArray(
          record.entries,
          context.at("entries"),
          (entry, itemContext) => entrySchema.parse(entry, `${context.source}${itemContext.path}`),
        ),
      };
    },
  });
}

export class RegenerableFileIndex<Entry> {
  readonly filePath: string;
  private readonly lockManager: ResourceLockManager;
  private readonly schema: StorageSchema<RegenerableIndexSnapshot<Entry>>;
  private readonly buildIndex: RegenerableFileIndexOptions<Entry>["build"];
  private readonly now: () => number;

  constructor(options: RegenerableFileIndexOptions<Entry>) {
    if (!path.isAbsolute(options.filePath)) {
      throw new StorageError(
        "STORAGE_INDEX_OPTIONS_INVALID",
        "Index filePath must be absolute.",
      );
    }
    this.filePath = path.resolve(options.filePath);
    this.lockManager = options.lockManager;
    this.schema = createIndexSchema(options.entrySchema);
    this.buildIndex = options.build;
    this.now = options.now ?? Date.now;
  }

  private lockKey() {
    return `index:${this.filePath}`;
  }

  private async createSnapshot() {
    const built = await this.buildIndex();
    return this.schema.parse({
      schemaVersion: 1,
      generatedAt: new Date(this.now()).toISOString(),
      sourceFingerprint: built.sourceFingerprint,
      entries: [...built.entries],
    }, `${this.filePath}:generated`);
  }

  private async readUnlocked() {
    return (await recoverAtomicJsonFile(this.filePath, this.schema)).value;
  }

  async read() {
    return this.lockManager.withLock(this.lockKey(), () => this.readUnlocked());
  }

  async ensureFresh() {
    return this.lockManager.withLock(this.lockKey(), async () => {
      const generated = await this.createSnapshot();
      let current: RegenerableIndexSnapshot<Entry> | null = null;
      try {
        current = await this.readUnlocked();
      } catch (error) {
        if (!isNodeError(error, "ENOENT") && !(error instanceof StorageCorruptionError)) {
          throw error;
        }
      }
      if (current?.sourceFingerprint === generated.sourceFingerprint) return current;
      await atomicWriteJson(this.filePath, generated, this.schema);
      return generated;
    });
  }

  async rebuild() {
    return this.lockManager.withLock(this.lockKey(), async () => {
      const generated = await this.createSnapshot();
      await atomicWriteJson(this.filePath, generated, this.schema);
      return generated;
    });
  }
}
