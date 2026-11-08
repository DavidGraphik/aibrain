import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const userFacingSources = [
  "src/app/admin/page.tsx",
  "src/admin/workspace-admin-store.ts",
  "src/app/api/threads/[threadId]/messages/[messageId]/result/route.ts",
  "src/app/shared/[shareId]/page.tsx",
  "src/components/automations-panel.tsx",
  "src/components/brain-app.tsx",
  "src/components/customization-panel.tsx",
  "src/components/project-panel.tsx",
  "src/components/task-center-panel.tsx",
  "src/components/turn-activity.tsx",
  "src/components/turn-sources.tsx",
  "src/components/voice-controls.tsx",
  "src/config/brain.ts",
  "src/runtime/permission-turn.ts",
  "src/runtime/worker-codex-turn.ts",
  "src/runtime/worker-runtime-service.ts",
  "src/ui/installation-branding.ts",
  "src/workbench/demo-store.ts",
  "config/installations/development.example.json",
  "config/installations/playwright.example.json",
  "config/installations/playwright-isolated.example.json",
  "config/installations/qa.example.json",
  "config/installations/vercel-preview.example.json",
  "public/branding/aibrain/logo.svg",
  "public/branding/aibrain/favicon.svg",
  "public/branding/example-lab/logo.svg",
  "public/branding/northwind-qa/logo.svg",
] as const;

const stringLiteral = /(["'`])([^"'`\n]*)\1/gu;
const forbiddenVisibleBrand = /Ai[ -]?Brain|\bBrain\b/u;

describe("user-facing branding", () => {
  it("contains no legacy product name in declared UI, modal, error, metadata, automation or asset copy", async () => {
    const matches = (await Promise.all(userFacingSources.map(async (source) => {
      const content = await readFile(path.join(process.cwd(), source), "utf8");
      return content.split("\n").flatMap((line, index) => [...line.matchAll(stringLiteral)].some((match) => forbiddenVisibleBrand.test(match[2])) ? [`${source}:${index + 1}`] : []);
    }))).flat();
    expect(matches).toEqual([]);
  });
});
