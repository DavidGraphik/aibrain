import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const releaseModule = pathToFileURL(path.join(process.cwd(), "scripts/manage-release.mjs")).href;
const { validInstallationConnectors } = await import(releaseModule);

it("allows the reviewed personal Nominalia configuration through the standalone release gate", () => {
  expect(validInstallationConnectors({ mail: { enabled: true, provider: "nominalia" } })).toBe(true);
  expect(validInstallationConnectors({ gmail: { enabled: true }, mail: { enabled: false, provider: "nominalia" } })).toBe(true);
});

it.each([
  { enabled: true, provider: "foreign" },
  { enabled: true, provider: "nominalia", password: "never-version-secrets" },
  { enabled: true, provider: "nominalia", host: "localhost" },
  { enabled: true, provider: "nominalia", port: 25 },
  { provider: "nominalia" },
  { enabled: "true", provider: "nominalia" },
])("rejects unreviewed mail settings before promotion: %o", mail => {
  expect(validInstallationConnectors({ mail })).toBe(false);
});
