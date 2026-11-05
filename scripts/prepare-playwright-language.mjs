import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
const configPath = process.argv[2];
if (!configPath) throw new Error("A synthetic Playwright installation config is required.");
const config = JSON.parse(await readFile(configPath, "utf8"));
const root = path.resolve(config.paths.dataRoot);
// Business templates use installation identity. This one checked-in fixture
// exercises Arnall's schedule menu with synthetic data and no live paths.
const isolatedSchedules = config.installationId === "arnall"
  && path.resolve(configPath) === path.resolve("config/installations/playwright-schedules.example.json")
  && root === "/tmp/aibrain-schedules-playwright/data"
  && Object.values(config.paths).every(value => typeof value === "string" && value.startsWith("/tmp/aibrain-schedules-playwright/"));
if ((!/^example-[a-z0-9-]+$/.test(config.installationId) && !isolatedSchedules) || !root.startsWith("/tmp/aibrain-") || root === "/tmp/aibrain-") throw new Error("Only isolated example Playwright data may be prepared.");
const directory = path.join(root, "settings");
await mkdir(directory, { recursive: true, mode: 0o700 });
if ((await lstat(directory)).isSymbolicLink()) throw new Error("Unsafe fixture settings directory.");
await writeFile(path.join(directory, "language.json"), JSON.stringify({ schemaVersion: 1, installationId: config.installationId, locale: "es", updatedBy: "playwright-fixture" }), { mode: 0o600 });
