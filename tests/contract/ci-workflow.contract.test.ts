import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
const yaml = createRequire(import.meta.url)("js-yaml") as { load(source: string): Record<string, unknown> };

describe("independent public source quality contract", () => {
  it("runs pinned, read-only checks without enrolling a production installation", async () => {
    const source = await readFile(path.join(process.cwd(), ".github/workflows/quality.yml"), "utf8");
    const workflow = yaml.load(source) as { permissions: Record<string, string>; jobs: Record<string, { steps: { uses?: string; run?: string; "continue-on-error"?: boolean }[]; "continue-on-error"?: boolean }> };
    expect(workflow.permissions).toEqual({ contents: "read" });
    const jobs = Object.values(workflow.jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job["continue-on-error"]).toBeUndefined();
      for (const step of job.steps) {
        expect(step["continue-on-error"]).toBeUndefined();
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
      }
    }
    for (const command of ["node .github/scripts/check-public-source.mjs", "npm ci", "npm run typecheck", "node .github/scripts/run-quality-tests.mjs", "npm run build -- --webpack"]) expect(source).toContain(command);
    expect(source).not.toMatch(/pull_request_target|packages:\s*write|contents:\s*write|docker push|automatic-activation|secrets\./u);
    expect(await readdir(path.join(process.cwd(), ".github/workflows"))).toEqual(["quality.yml"]);
  });

  it("keeps the selected quality cases explicit and propagates every failed test process", async () => {
    const runner = await readFile(path.join(process.cwd(), ".github/scripts/run-quality-tests.mjs"), "utf8");
    const suites = JSON.parse(await readFile(path.join(process.cwd(), ".github/quality-tests.json"), "utf8")) as string[];
    expect(suites.length).toBeGreaterThan(0);
    expect(new Set(suites).size).toBe(suites.length);
    for (const suite of suites) {
      expect(suite).toMatch(/^(src|tests)\//u);
      expect(suite).not.toContain("..");
      await expect(readFile(path.join(process.cwd(), suite))).resolves.toBeDefined();
    }
    expect(runner).toContain("process.exit(result.status ?? 1)");
    expect(runner).not.toMatch(/process\.exit\(0\)|catch\s*\([^)]*\)\s*\{\s*\}/u);
  });
});
