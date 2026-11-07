import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRegularFileWithin, UnsafeFilePathError } from "@/security/safe-file";

describe("readRegularFileWithin", () => {
  it("reads a regular file inside the declared root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-safe-file-"));
    await writeFile(path.join(root, "artifact.png"), "safe");

    await expect(readRegularFileWithin(root, "artifact.png", 10)).resolves.toEqual(Buffer.from("safe"));
  });

  it("rejects traversal and symlinks even when they resolve to a regular file", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "aibrain-safe-file-"));
    const root = path.join(parent, "root");
    await mkdir(root);
    await writeFile(path.join(parent, "outside.txt"), "secret");
    await symlink(path.join(parent, "outside.txt"), path.join(root, "link.txt"));

    await expect(readRegularFileWithin(root, "../outside.txt", 100)).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(readRegularFileWithin(root, "link.txt", 100)).rejects.toBeInstanceOf(UnsafeFilePathError);
  });

  it("rejects files above the endpoint-specific maximum", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-safe-file-"));
    await writeFile(path.join(root, "large.bin"), Buffer.alloc(11));

    await expect(readRegularFileWithin(root, "large.bin", 10)).rejects.toBeInstanceOf(UnsafeFilePathError);
  });
});
