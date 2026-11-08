import { execFileSync, spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/prepare-playwright-language.mjs";

describe("synthetic scheduling browser fixture", () => {
  it("prepares its isolated language state for the real business-template identity", async () => {
    execFileSync(process.execPath, [script, "config/installations/playwright-schedules.example.json"]);
    const state = JSON.parse(await readFile("/tmp/aibrain-schedules-playwright/data/settings/language.json", "utf8"));
    expect(state).toMatchObject({ installationId: "arnall", locale: "es", updatedBy: "playwright-fixture" });
  });

  it("rejects a real client config and an arbitrary copy of the synthetic config before writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "schedule-fixture-boundary-"));
    try {
      const copied = path.join(root, "installation.json");
      await writeFile(copied, await readFile("config/installations/playwright-schedules.example.json"));
      for (const config of ["config/installations/arnall.qa.example.json", copied]) {
        const result = spawnSync(process.execPath, [script, config], { encoding: "utf8" });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Only isolated example Playwright data may be prepared.");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
