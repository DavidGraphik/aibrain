import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJSON,
  DIRECTORY_KINDS,
  DirectoryError,
  emptyDirectory,
  validateDirectory,
  validateRelationships,
  type DirectoryDataset,
} from "./directory";

/** Independent public directory; never opens the website or conversation stores. */
export class DirectoryStore {
  readonly db: DatabaseSync;
  constructor(
    dataRoot: string,
    private readonly allowSynthetic = false,
  ) {
    if (!path.isAbsolute(dataRoot))
      throw new DirectoryError("Invalid data root", 503);
    const directory = path.join(dataRoot, "insijets-directory");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink())
      throw new DirectoryError("Directory symlink denied", 503);
    const file = path.join(directory, "public-directory.sqlite");
    if (
      existsSync(file) &&
      (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
    )
      throw new DirectoryError("Database path denied", 503);
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, synthetic INTEGER);
      INSERT OR IGNORE INTO metadata VALUES(1,0,NULL);
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS imports (digest TEXT PRIMARY KEY,revision INTEGER NOT NULL,actor TEXT NOT NULL,imported_at TEXT NOT NULL,original_dataset TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id,revision));`);
  }
  close() {
    this.db.close();
  }
  snapshot(): { dataset: DirectoryDataset; revision: number } {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN");
    try {
      const meta = this.db
        .prepare("SELECT revision,synthetic FROM metadata WHERE id=1")
        .get()!;
      const dataset = emptyDirectory(meta.synthetic === 1);
      for (const kind of DIRECTORY_KINDS) {
        const records = this.db
          .prepare("SELECT payload FROM entities WHERE kind=? ORDER BY id")
          .all(kind)
          .map((r) => JSON.parse(r.payload as string));
        (dataset[kind] as unknown[]) = records;
      }
      if (ownsTransaction) this.db.exec("COMMIT");
      return { dataset, revision: meta.revision as number };
    } catch (error) {
      if (ownsTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  import(value: unknown, actor: string, expectedRevision: number) {
    const dataset = validateDirectory(value, this.allowSynthetic),
      serialized = canonicalJSON(dataset);
    const digest = createHash("sha256").update(serialized).digest("hex");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new DirectoryError("Current revision required");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare("SELECT revision FROM imports WHERE digest=?")
        .get(digest);
      if (previous) {
        this.db.exec("COMMIT");
        return {
          repeated: true,
          importRevision: previous.revision,
          revision: this.snapshot().revision,
          inserted: 0,
          updated: 0,
        };
      }
      const current = this.snapshot();
      if (current.revision !== expectedRevision)
        throw new DirectoryError(
          "The directory changed. Reload before importing.",
          409,
        );
      if (current.revision && dataset.synthetic !== current.dataset.synthetic)
        throw new DirectoryError(
          "Synthetic and public datasets cannot be mixed",
          409,
        );
      const merged = emptyDirectory(dataset.synthetic);
      let inserted = 0,
        updated = 0;
      for (const kind of DIRECTORY_KINDS) {
        const records = new Map(current.dataset[kind].map((r) => [r.id, r]));
        for (const record of dataset[kind]) {
          const old = records.get(record.id);
          if (
            old &&
            old.checkedAt > record.checkedAt &&
            canonicalJSON(old) !== canonicalJSON(record)
          )
            throw new DirectoryError(
              "An older source check cannot replace a newer record",
              409,
            );
          if (!old) inserted++;
          else if (canonicalJSON(old) !== canonicalJSON(record)) updated++;
          records.set(record.id, record);
        }
        (merged[kind] as unknown[]) = [...records.values()];
      }
      validateRelationships(merged);
      const revision = current.revision + 1;
      for (const kind of DIRECTORY_KINDS)
        for (const record of dataset[kind]) {
          const payload = canonicalJSON(record),
            old = this.db
              .prepare("SELECT payload FROM entities WHERE kind=? AND id=?")
              .get(kind, record.id);
          if (old?.payload === payload) continue;
          if (old)
            this.db
              .prepare("INSERT INTO versions VALUES(?,?,?,?)")
              .run(kind, record.id, current.revision, old.payload as string);
          this.db
            .prepare(
              "INSERT INTO entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
            )
            .run(kind, record.id, payload);
        }
      this.db
        .prepare("INSERT INTO imports VALUES(?,?,?,?,?)")
        .run(
          digest,
          revision,
          actor,
          new Date().toISOString(),
          JSON.stringify(dataset),
        );
      this.db
        .prepare("UPDATE metadata SET revision=?,synthetic=? WHERE id=1")
        .run(revision, Number(dataset.synthetic));
      this.db.exec("COMMIT");
      return { repeated: false, revision, inserted, updated };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
