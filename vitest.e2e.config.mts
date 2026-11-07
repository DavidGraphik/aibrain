import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Each suite starts a real copied Next application. Keep the files
    // serial so their short-lived dev servers and generated `.next` trees
    // cannot race on constrained CI or release hosts.
    fileParallelism: false,
    maxWorkers: 1,
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
