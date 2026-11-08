import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals.map((config) => config.name === "next/typescript"
    ? { ...config, files: [...config.files, "**/*.mts", "**/*.cts"] }
    : config),
  globalIgnores([
    ".next/**",
    "dist/**",
    "contracts/codex/**",
    "coverage/**",
    "out/**",
    "build/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
    "runtime/**",
    // Imported module has its own backend and frontend lint gates.
    "modules/horaria/**",
    // Immutable upstream skill snapshot; project integration is linted normally.
    "skills/impeccable/**",
    // Vendored by the Fluid Functionalism shadcn registry. Keep project code
    // linted without rewriting the upstream component's ref choreography.
    "src/components/ui/sidebar*.tsx",
    "src/hooks/use-proximity-hover.ts",
  ]),
]);
