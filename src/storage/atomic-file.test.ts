import { mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicTemporaryPath,
  atomicWriteFile,
  atomicWriteFileChunks,
  atomicWriteJson,
  listAtomicTemporaryFiles,
  readValidatedJson,
  recoverAtomicJsonFile,
  type AtomicWriteStage,
} from "@/storage/atomic-file";
import { StorageCorruptionError, StorageError } from "@/storage/errors";
import {
  defineVersionedSchema,
  expectInteger,
  expectString,
} from "@/storage/schema";

type TestDocument = { schemaVersion: 1; name: string; revision: number };

const testDocumentSchema = defineVersionedSchema<TestDocument>({
  name: "AtomicTestDocument",
  schemaVersion: 1,
  keys: ["name", "revision"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      name: expectString(record.name, context.at("name"), { minLength: 1 }),
      revision: expectInteger(record.revision, context.at("revision"), { minimum: 1 }),
    };
  },
});

describe("atomic file storage", () => {
  let root: string;
  let target: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aibrain-atomic-"));
    target = path.join(root, "state.json");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes bounded chunks through the same atomic stages", async () => {
    const stages: AtomicWriteStage[] = [];
    async function* chunks() { yield "first — €\n"; yield new TextEncoder().encode("last\n"); }
    await atomicWriteFileChunks(target, chunks(), { onStage: (stage) => { stages.push(stage); } });
    expect(await readFile(target, "utf8")).toBe("first — €\nlast\n");
    expect(stages).toEqual(["temporary-created", "temporary-synced", "renamed", "directory-synced"]);
  });

  it("keeps the previous canonical file and removes a partial temporary when a chunk producer fails", async () => {
    await atomicWriteFile(target, "previous canonical");
    async function* chunks() { yield "partial replacement"; throw new Error("bounded producer failed"); }
    await expect(atomicWriteFileChunks(target, chunks())).rejects.toThrow("bounded producer failed");
    expect(await readFile(target, "utf8")).toBe("previous canonical");
    expect(await listAtomicTemporaryFiles(target)).toEqual([]);
  });

  it("syncs the temporary before rename and the directory after rename", async () => {
    const stages: AtomicWriteStage[] = [];
    await atomicWriteJson(
      target,
      { schemaVersion: 1, name: "ready", revision: 1 },
      testDocumentSchema,
      { onStage: (stage) => { stages.push(stage); } },
    );

    expect(stages).toEqual([
      "temporary-created",
      "temporary-synced",
      "renamed",
      "directory-synced",
    ]);
    expect(await readValidatedJson(target, testDocumentSchema)).toEqual({
      schemaVersion: 1,
      name: "ready",
      revision: 1,
    });
    expect(await listAtomicTemporaryFiles(target)).toEqual([]);
  });

  it("keeps the previous target and cleans the temporary after a pre-rename failure", async () => {
    await atomicWriteFile(target, "old\n");
    await expect(atomicWriteFile(target, "new\n", {
      onStage(stage) {
        if (stage === "temporary-synced") throw new Error("simulated power loss");
      },
    })).rejects.toThrow("simulated power loss");

    expect(await readFile(target, "utf8")).toBe("old\n");
    expect(await listAtomicTemporaryFiles(target)).toEqual([]);
  });

  it("recovers a fully-synced crash temporary when no target exists", async () => {
    await expect(atomicWriteJson(
      target,
      { schemaVersion: 1, name: "recovered", revision: 2 },
      testDocumentSchema,
      {
        preserveTemporaryOnError: true,
        onStage(stage) {
          if (stage === "temporary-synced") throw new Error("simulated process crash");
        },
      },
    )).rejects.toThrow("simulated process crash");

    const [temporary] = await listAtomicTemporaryFiles(target);
    expect(temporary).toBeTruthy();
    const recovery = await recoverAtomicJsonFile(target, testDocumentSchema);
    expect(recovery.recovered).toBe(true);
    expect(recovery.recoveredFrom).toBe(temporary);
    expect(recovery.value.revision).toBe(2);
    expect(await listAtomicTemporaryFiles(target)).toEqual([]);
  });

  it("considers every temporary when the recovery safety window is zero", async () => {
    const temporary = atomicTemporaryPath(target, "future-mtime");
    await writeFile(
      temporary,
      JSON.stringify({ schemaVersion: 1, name: "future", revision: 3 }),
    );
    const slightlyFuture = new Date(Date.now() + 1);
    await utimes(temporary, slightlyFuture, slightlyFuture);

    const recovery = await recoverAtomicJsonFile(target, testDocumentSchema, {
      minimumTemporaryAgeMs: 0,
    });

    expect(recovery.recovered).toBe(true);
    expect(recovery.value.revision).toBe(3);
  });

  it("keeps a valid target authoritative and quarantines orphaned temporaries", async () => {
    await atomicWriteJson(
      target,
      { schemaVersion: 1, name: "committed", revision: 1 },
      testDocumentSchema,
    );
    const validTemporary = atomicTemporaryPath(target, "valid");
    const corruptTemporary = atomicTemporaryPath(target, "corrupt");
    await writeFile(validTemporary, JSON.stringify({ schemaVersion: 1, name: "new", revision: 2 }));
    await writeFile(corruptTemporary, "not-json");

    const recovery = await recoverAtomicJsonFile(target, testDocumentSchema);
    expect(recovery).toMatchObject({
      recovered: false,
      recoveredFrom: null,
      value: { schemaVersion: 1, name: "committed", revision: 1 },
    });
    expect(recovery.quarantined).toHaveLength(2);
    expect(recovery.quarantined.some((file) => file.includes(".corrupt."))).toBe(true);
    expect(recovery.quarantined.some((file) => file.includes(".orphaned."))).toBe(true);
  });

  it("quarantines a corrupt target and promotes the newest valid temporary", async () => {
    await writeFile(target, "corrupt-target");
    const older = atomicTemporaryPath(target, "older");
    const newer = atomicTemporaryPath(target, "newer");
    await writeFile(older, JSON.stringify({ schemaVersion: 1, name: "older", revision: 1 }));
    await writeFile(newer, JSON.stringify({ schemaVersion: 1, name: "newer", revision: 2 }));
    const now = Date.now();
    await utimes(older, new Date(now - 5_000), new Date(now - 5_000));
    await utimes(newer, new Date(now), new Date(now));

    const recovery = await recoverAtomicJsonFile(target, testDocumentSchema);
    expect(recovery.recovered).toBe(true);
    expect(recovery.recoveredFrom).toBe(newer);
    expect(recovery.value.name).toBe("newer");
    expect(recovery.quarantined.some((file) => file.startsWith(`${target}.corrupt.`))).toBe(true);
    expect(recovery.quarantined.some((file) => file.includes("older.tmp.orphaned"))).toBe(true);
  });

  it("fails closed when neither target nor temporaries validate", async () => {
    await writeFile(target, "broken-target");
    await writeFile(atomicTemporaryPath(target, "broken"), "broken-temporary");

    await expect(recoverAtomicJsonFile(target, testDocumentSchema))
      .rejects.toBeInstanceOf(StorageCorruptionError);
    expect(await readFile(target, "utf8")).toBe("broken-target");
    expect(await readdir(root)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.corrupt\./)]),
    );
  });

  it("never follows an existing target symlink", async () => {
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "sensitive");
    await symlink(outside, target);

    await expect(atomicWriteFile(target, "replacement"))
      .rejects.toMatchObject({ code: "STORAGE_SYMLINK_REJECTED" } satisfies Partial<StorageError>);
    expect(await readFile(outside, "utf8")).toBe("sensitive");
  });
});
