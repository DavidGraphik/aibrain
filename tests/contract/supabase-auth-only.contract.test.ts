import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sourceRoot = path.join(repositoryRoot, "src");

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(absolute);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name) || entry.name.includes(".test.")) {
      return [];
    }
    return [absolute];
  }));
  return nested.flat();
}

describe("Supabase Auth-only architecture", () => {
  it("keeps the only Supabase SDK import inside the isolated identity provider", async () => {
    const files = await productionSources(sourceRoot);
    const imports: string[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      const relative = path.relative(repositoryRoot, file);
      if (contents.includes("@supabase/")) {
        imports.push(relative);
      }
      // Keep generic Supabase query-builder calls forbidden without mistaking
      // the built-in Node Buffer.from(...) constructor for a database query.
      const withoutNodeBufferConstructors = contents.replace(/\bBuffer\.from\s*\(/gu, "Buffer(");
      expect(withoutNodeBufferConstructors, relative).not.toMatch(/\.(?:from|rpc)\(\s*["']/);
      expect(contents, relative).not.toMatch(/\/(?:rest|graphql|storage|realtime)\/v1\b/iu);
      expect(contents, relative).not.toMatch(/\.supabase\.(?:from|rpc|storage|realtime|functions)\b/iu);
    }
    expect(imports).toEqual(["src/auth/supabase-identity-provider.ts"]);
  });

  it("does not ship a product database adapter or product migrations", async () => {
    const [workbenchEntries, libraryEntries, migrationEntries] = await Promise.all([
      readdir(path.join(sourceRoot, "workbench")),
      readdir(path.join(sourceRoot, "lib", "supabase")),
      readdir(path.join(repositoryRoot, "supabase", "migrations")).catch(() => []),
    ]);
    expect(workbenchEntries).not.toContain("supabase-store.ts");
    expect(libraryEntries.sort()).toEqual(["config.ts"]);
    expect(migrationEntries.filter((entry) => entry.endsWith(".sql"))).toEqual([]);
  });

  it("does not expose Supabase as a product persistence mode", async () => {
    const [workbenchTypes, uiContract] = await Promise.all([
      readFile(path.join(sourceRoot, "workbench", "types.ts"), "utf8"),
      readFile(path.join(repositoryRoot, "docs", "UI_BACKEND_CONTRACT.md"), "utf8"),
    ]);
    expect(workbenchTypes).not.toMatch(/WorkbenchPersistence\s*=\s*[^;]*["']supabase["']/);
    expect(uiContract).not.toMatch(/persistence:\s*[^;\n]*["']supabase["']/);
  });

  it("depends on the Auth client only and disables optional Supabase product services", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
    expect(packageJson.dependencies["@supabase/supabase-js"]).toBe("2.112.4");
    expect(packageJson.dependencies["@supabase/ssr"]).toBeUndefined();
    expect(packageJson.dependencies["@supabase/postgrest-js"]).toBeUndefined();
    expect(packageJson.dependencies["graphql-request"]).toBeUndefined();

    const config = await readFile(path.join(repositoryRoot, "supabase", "config.toml"), "utf8");
    expect(config).toMatch(/\[db\.migrations\]\s+[\s\S]*?enabled = false/);
    expect(config).toMatch(/\[realtime\]\s+[\s\S]*?enabled = false/);
    expect(config).toMatch(/\[storage\]\s+[\s\S]*?enabled = false/);
    expect(config).toMatch(/\[auth\]\s+[\s\S]*?enable_signup = false/);
  });
});
