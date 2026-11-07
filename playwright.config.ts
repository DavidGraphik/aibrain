import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
const installationConfig = path.resolve(
  process.cwd(),
  process.env.PLAYWRIGHT_INSTALLATION_CONFIG ?? "config/installations/playwright.example.json",
);

export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/*.spec.ts"],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "ca-ES",
    timezoneId: "Europe/Madrid",
    colorScheme: "light",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testIgnore: [
        "**/visual/**",
        "**/visual-matrix/**",
        "**/accessibility/**",
        "**/image-delivery-webkit.spec.ts",
        "**/connector-editing-webkit.spec.ts",
        "**/composer-editing-placement.spec.ts",
        "**/response-network-recovery.spec.ts",
      ],
    },
    {
      name: "webkit-iphone",
      testMatch: ["**/image-delivery-webkit.spec.ts"],
      use: { ...devices["iPhone 13"], browserName: "webkit" },
    },
    {
      name: "visual-desktop",
      testMatch: ["**/visual/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "visual-mobile",
      testMatch: ["**/visual/**/*.spec.ts"],
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "accessibility",
      testMatch: ["**/accessibility/**/*.spec.ts"],
      testIgnore: ["**/accessibility/mobile-overlays.spec.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "accessibility-mobile",
      testMatch: ["**/accessibility/mobile-overlays.spec.ts"],
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "visual-matrix",
      testMatch: ["**/visual-matrix/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `node scripts/prepare-playwright-language.mjs ${JSON.stringify(installationConfig)} && AIBRAIN_INSTALLATION_CONFIG=${JSON.stringify(installationConfig)} VERCEL_ENV=preview AIBRAIN_AUTH_MODE=demo AIBRAIN_ENABLE_PREVIEW_DEMO=1 CHAT_RUNTIME=demo npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
