import { it, expect } from "vitest";
import { buildWorkerEnvironment } from "@/runtime/worker-environment";
import type { RuntimeConfig } from "@/runtime/config";
it("does not forward any MODTIME Shopify credentials to model worker environment", () => {
  const env = buildWorkerEnvironment({ workspace: "/tmp/synthetic-workspace" } as RuntimeConfig, {
    NODE_ENV: "production", MODTIME_SHOPIFY_CLIENT_SECRET: "synthetic-secret", MODTIME_SHOPIFY_OAUTH_ENCRYPTION_KEY: "synthetic-key", MODTIME_SHOPIFY_ADMIN_TOKEN: "synthetic-token", MODTIME_SHOPIFY_THEME_CLIENT_SECRET: "synthetic-theme-secret", MODTIME_SHOPIFY_THEME_ENCRYPTION_KEY: "synthetic-theme-key", PATH: "/usr/bin",
  });
  expect(Object.keys(env).some(key => key.startsWith("MODTIME_SHOPIFY"))).toBe(false);
  expect(JSON.stringify(env)).not.toContain("synthetic-secret");
});
