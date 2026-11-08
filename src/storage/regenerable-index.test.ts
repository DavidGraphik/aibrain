import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RegenerableFileIndex,
  fingerprintJson,
} from "@/storage/regenerable-index";
import { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectString,
} from "@/storage/schema";

type TestIndexEntry = { schemaVersion: 1; id: string; title: string };

const entrySchema = defineVersionedSchema<TestIndexEntry>({
  name: "TestIndexEntry",
  schemaVersion: 1,
  keys: ["id", "title"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      id: expectString(record.id, context.at("id"), { minLength: 1, maxLength: 40 }),
      title: expectString(record.title, context.at("title"), { minLength: 1, maxLength: 120 }),
    };
  },
});

describe("regenerable file index", () => {
  let root: string;
  let indexPath: string;
  let lockManager: ResourceLockManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aibrain-index-"));
    indexPath = path.join(root, "indexes", "threads.json");
    lockManager = new ResourceLockManager({
      rootDirectory: path.join(root, "locks"),
      staleAfterMs: 2_000,
      heartbeatIntervalMs: 100,
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      jitterRatio: 0,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a missing derived index and reads it through the strict schema", async () => {
    const sources = [{ id: "thread-1", title: "First" }];
    const index = new RegenerableFileIndex({
      filePath: indexPath,
      lockManager,
      entrySchema,
      build: () => ({
        sourceFingerprint: fingerprintJson(sources),
        entries: sources.map((source) => ({ schemaVersion: 1 as const, ...source })),
      }),
      now: () => 1_000,
    });

    const created = await index.ensureFresh();
    expect(created).toEqual({
      schemaVersion: 1,
      generatedAt: new Date(1_000).toISOString(),
      sourceFingerprint: fingerprintJson(sources),
      entries: [{ schemaVersion: 1, id: "thread-1", title: "First" }],
    });
    expect(await index.read()).toEqual(created);
  });

  it("does not rewrite an index whose source fingerprint is unchanged", async () => {
    let timestamp = 1_000;
    const sources = [{ id: "thread-1", title: "First" }];
    const index = new RegenerableFileIndex({
      filePath: indexPath,
      lockManager,
      entrySchema,
      build: () => ({
        sourceFingerprint: fingerprintJson(sources),
        entries: sources.map((source) => ({ schemaVersion: 1 as const, ...source })),
      }),
      now: () => timestamp,
    });
    const first = await index.ensureFresh();
    timestamp = 5_000;
    const second = await index.ensureFresh();

    expect(second.generatedAt).toBe(first.generatedAt);
    expect(JSON.parse(await readFile(indexPath, "utf8"))).toEqual(first);
  });

  it("rebuilds when source content changes", async () => {
    let sources = [{ id: "thread-1", title: "First" }];
    const index = new RegenerableFileIndex({
      filePath: indexPath,
      lockManager,
      entrySchema,
      build: () => ({
        sourceFingerprint: fingerprintJson(sources),
        entries: sources.map((source) => ({ schemaVersion: 1 as const, ...source })),
      }),
    });
    const first = await index.ensureFresh();
    sources = [...sources, { id: "thread-2", title: "Second" }];
    const second = await index.ensureFresh();

    expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(second.entries.map((entry) => entry.id)).toEqual(["thread-1", "thread-2"]);
  });

  it("regenerates a corrupt derived index instead of treating it as authoritative", async () => {
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(indexPath, "corrupt");
    const index = new RegenerableFileIndex({
      filePath: indexPath,
      lockManager,
      entrySchema,
      build: () => ({
        sourceFingerprint: fingerprintJson(["source"]),
        entries: [{ schemaVersion: 1, id: "thread-1", title: "Recovered" }],
      }),
    });

    await expect(index.read()).rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
    expect((await index.ensureFresh()).entries[0]?.title).toBe("Recovered");
    expect((await index.read()).entries[0]?.title).toBe("Recovered");
  });

  it("rejects generated entries with undeclared fields", async () => {
    const index = new RegenerableFileIndex({
      filePath: indexPath,
      lockManager,
      entrySchema,
      build: () => ({
        sourceFingerprint: fingerprintJson(["source"]),
        entries: [{
          schemaVersion: 1,
          id: "thread-1",
          title: "Unsafe",
          leaked: true,
        }] as unknown as TestIndexEntry[],
      }),
    });

    await expect(index.ensureFresh()).rejects.toThrow(/unexpected properties: leaked/);
  });

  it("keeps concurrent rebuild attempts atomic", async () => {
    const sources = Array.from({ length: 100 }, (_, index) => ({
      id: `thread-${index}`,
      title: `Thread ${index}`,
    }));
    const options = {
      filePath: indexPath,
      lockManager,
      entrySchema,
      build: () => ({
        sourceFingerprint: fingerprintJson(sources),
        entries: sources.map((source) => ({ schemaVersion: 1 as const, ...source })),
      }),
    };
    const first = new RegenerableFileIndex(options);
    const second = new RegenerableFileIndex(options);

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? first : second).ensureFresh()));

    const stored = await first.read();
    expect(stored.entries).toHaveLength(100);
    expect(JSON.parse(await readFile(indexPath, "utf8"))).toEqual(stored);
  });
});

describe("canonical JSON fingerprints", () => {
  it("is stable across object key order but sensitive to array order", () => {
    expect(fingerprintJson({ b: 2, a: { y: true, x: "value" } }))
      .toBe(fingerprintJson({ a: { x: "value", y: true }, b: 2 }));
    expect(fingerprintJson([1, 2])).not.toBe(fingerprintJson([2, 1]));
  });

  it("rejects cyclic and non-JSON values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => fingerprintJson(cyclic)).toThrow(/cyclic/);
    expect(() => fingerprintJson({ missing: undefined })).toThrow(/unsupported undefined/);
    expect(() => fingerprintJson(Number.NaN)).toThrow(/non-finite/);
  });
});
