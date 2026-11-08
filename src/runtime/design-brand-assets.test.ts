import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ARNALL_LOGO_WORKSPACE_PATH, prepareDesignBrandAssets } from "@/runtime/design-brand-assets";

const arnall = { companySlug: "arnall" };
const roots: string[] = [];

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-design-brand-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private design brand assets", () => {
  it("supplies the unchanged official logo and restores it on subsequent turns", async () => {
    const project = await workspace();
    const destination = path.join(project, ARNALL_LOGO_WORKSPACE_PATH);
    const official = await readFile(path.join(process.cwd(), "public/branding/approved/example-logo.jpg"));
    const instructions = await prepareDesignBrandAssets(arnall, project);

    expect(await readFile(destination)).toEqual(official);
    expect(instructions).toContain(JSON.stringify(destination));
    expect(instructions).toContain("include the official Example Company logo automatically");
    expect(instructions).toContain("each requested export");
    expect(instructions).toContain("inspect the actual rendered output");
    expect(instructions).not.toContain("could not be prepared");

    await writeFile(destination, "a generated substitute");
    expect(await prepareDesignBrandAssets(arnall, project)).toBe(instructions);
    expect(await readFile(destination)).toEqual(official);
  });

  it("uses a reviewed private mapping for a new installation without publishing its artwork", async () => {
    const source = await workspace();
    const project = await workspace();
    const registryFile = path.join(source, "brands.json");
    const bytes = await readFile("public/branding/approved/example-logo.jpg");
    await mkdir(path.join(source, "assets"));
    await writeFile(path.join(source, "assets/logo.jpg"), bytes);
    await writeFile(registryFile, JSON.stringify([{ companySlug: "new-company", label: "Synthetic Brand", sourcePath: "assets/logo.jpg", workspacePath: ".aibrain-brand/logo.jpg", sha256: createHash("sha256").update(bytes).digest("hex") }]), { mode: 0o600 });
    vi.stubEnv("AIBRAIN_DESIGN_BRAND_ASSETS_FILE", registryFile);
    const instructions = await prepareDesignBrandAssets({ companySlug: "new-company" }, project, source);
    expect(instructions).toContain("official Synthetic Brand logo automatically");
    expect(await readFile(path.join(project, ".aibrain-brand/logo.jpg"))).toEqual(bytes);
    expect(await prepareDesignBrandAssets({ companySlug: "other-company" }, await workspace(), source)).toBe("");
    await writeFile(path.join(source, "assets/logo.jpg"), "altered source");
    const fresh = await workspace();
    expect(await prepareDesignBrandAssets({ companySlug: "new-company" }, fresh, source)).toContain("could not be prepared safely");
    expect(await readdir(fresh)).toEqual([]);
  });

  it("rejects a malformed or symlinked registry without blocking unrelated work", async () => {
    const source = await workspace();
    const registry = path.join(source, "brands.json");
    await writeFile(registry, "invalid JSON", { mode: 0o600 });
    vi.stubEnv("AIBRAIN_DESIGN_BRAND_ASSETS_FILE", registry);
    const project = await workspace();
    expect(await prepareDesignBrandAssets(arnall, project)).toContain("Unrelated work may proceed");
    const alias = path.join(source, "alias.json");
    await symlink(registry, alias);
    vi.stubEnv("AIBRAIN_DESIGN_BRAND_ASSETS_FILE", alias);
    expect(await prepareDesignBrandAssets(arnall, project)).toContain("could not be prepared safely");
    expect(await readdir(project)).toEqual([]);
  });

  it("does not supply Arnall instructions or create files in another installation", async () => {
    const project = await workspace();
    expect(await prepareDesignBrandAssets({ companySlug: "other" }, project, "/unavailable")).toBe("");
    expect(await readdir(project)).toEqual([]);
  });

  it("keeps each project's copy within its own workspace", async () => {
    const first = await workspace();
    const second = await workspace();
    const firstInstructions = await prepareDesignBrandAssets(arnall, first);
    const secondInstructions = await prepareDesignBrandAssets(arnall, second);
    expect(firstInstructions).not.toContain(second);
    expect(secondInstructions).not.toContain(first);
    await writeFile(path.join(first, ARNALL_LOGO_WORKSPACE_PATH), "altered");
    expect((await readFile(path.join(second, ARNALL_LOGO_WORKSPACE_PATH))).length).toBe((await readFile("public/branding/approved/example-logo.jpg")).length);
  });

  it.each(["directory", "file"])("refuses a %s symlink without changing its target", async (kind) => {
    const project = await workspace();
    const foreign = await workspace();
    const foreignFile = path.join(foreign, "arnall-logo.jpg");
    await writeFile(foreignFile, "foreign asset");
    const brandDirectory = path.join(project, ".aibrain-brand");
    if (kind === "directory") {
      await symlink(foreign, brandDirectory);
    } else {
      await mkdir(brandDirectory);
      await symlink(foreignFile, path.join(project, ARNALL_LOGO_WORKSPACE_PATH));
    }
    const instructions = await prepareDesignBrandAssets(arnall, project);
    expect(instructions).toContain("could not be prepared safely");
    expect(instructions).toContain("do not claim completion");
    expect(await readFile(foreignFile, "utf8")).toBe("foreign asset");
  });

  it.each(["missing", "altered"])("does not use a %s packaged asset or break unrelated work", async (state) => {
    const project = await workspace();
    const source = await workspace();
    if (state === "altered") {
      await mkdir(path.join(source, "branding/approved"), { recursive: true });
      await writeFile(path.join(source, "branding/approved/example-logo.jpg"), "unverified source");
    }
    const instructions = await prepareDesignBrandAssets(arnall, project, source);
    expect(instructions).toContain("could not be prepared safely");
    expect(instructions).toContain("Unrelated work may proceed");
    expect(await readdir(project)).toEqual([]);
  });
});
