import { defineConfig, devices } from "@playwright/test";
import config from "./playwright.config";
import path from "node:path";
const baseURL = "http://127.0.0.1:3100";
// A synthetic Arnall identity preserves real schedule-menu browser coverage;
// the main browser suite keeps the generic example and its client isolation.
// The Vercel browser-only preview deliberately omits connector reads.
export default defineConfig({
  ...config,
  use: { ...config.use, baseURL },
  projects: [
    { name: "chromium-recovery", use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/composer-editing-placement.spec.ts", "**/response-network-recovery.spec.ts"] },
    { name: "webkit-recovery", use: { ...devices["iPhone 13"], browserName: "webkit" },
      testMatch: ["**/connector-editing-webkit.spec.ts"] },
  ],
  webServer: {
    command: `node scripts/prepare-playwright-language.mjs config/installations/playwright-schedules.example.json && AIBRAIN_INSTALLATION_CONFIG=${JSON.stringify(path.resolve("config/installations/playwright-schedules.example.json"))} VERCEL_ENV= AIBRAIN_AUTH_MODE=demo AIBRAIN_ENABLE_PREVIEW_DEMO=0 CHAT_RUNTIME=demo npm run dev -- --hostname 127.0.0.1 --port 3100`,
    url: `${baseURL}/login`, reuseExistingServer: !process.env.CI, timeout: 120_000,
  },
});
