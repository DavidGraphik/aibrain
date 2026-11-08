import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(candidate));
    else if (/\.(?:ts|tsx)$/u.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(candidate);
  }
  return files;
}

describe("production logging boundary", () => {
  it("forbids direct console output in production source", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(path.resolve("src"))) {
      const contents = await readFile(file, "utf8");
      if (/\bconsole\.(?:log|info|warn|error|debug)\s*\(/u.test(contents)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
