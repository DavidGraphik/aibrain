import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  loadInstallationConfig,
  loadInstallationConfigFromFile,
  resolveInstallationConfigPath,
} from "@/config/installation";
import {
  InstallationConfigValidationError,
  parseInstallationConfig,
} from "@/config/installation-schema";

const repositoryRoot = process.cwd();
const developmentFixture = path.join(
  repositoryRoot,
  "config/installations/development.example.json",
);
const qaFixture = path.join(repositoryRoot, "config/installations/qa.example.json");
const execFile = promisify(execFileCallback);

async function readFixture() {
  return JSON.parse(await readFile(developmentFixture, "utf8")) as Record<string, unknown>;
}

describe("InstallationConfig", () => {
  it("accepts opt-in company mail without credentials and rejects arbitrary hosts or credential fields", async () => {
    const fixture = await readFixture();
    const companyMail = { enabled: true, host: "hc65.infoselfcloud.com", emailDomain: "example-company.invalid" };
    expect(parseInstallationConfig({ ...fixture, connectors: { companyMail } }).connectors?.companyMail).toEqual(companyMail);
    for (const host of ["127.0.0.1", "localhost", "*.example.com", "imap.EXAMPLE.com", "imap.example.com:993", "imap.example.local"]) {
      expect(() => parseInstallationConfig({ ...fixture, connectors: { companyMail: { ...companyMail, host } } })).toThrow();
    }
    expect(() => parseInstallationConfig({ ...fixture, connectors: { companyMail: { ...companyMail, password: "never-here" } } })).toThrow();
  });

  it("pins native Instantly to an exact workspace and rejects credential configuration", async () => {
    const fixture = await readFixture();
    const instantly = { enabled: true, workspaceId: "11111111-1111-4111-8111-111111111111" };
    const parsed = parseInstallationConfig({ ...fixture, connectors: { instantly } });
    expect(parsed.connectors?.instantly).toEqual(instantly);
    expect(Object.isFrozen(parsed.connectors?.instantly)).toBe(true);
    for (const invalid of [null, {}, { ...instantly, workspaceId: "all" }, { ...instantly, apiKey: "secret" }, { ...instantly, enabled: "yes" }]) {
      expect(() => parseInstallationConfig({ ...fixture, connectors: { instantly: invalid } })).toThrow(InstallationConfigValidationError);
    }
  });
  it("accepts an immutable installation-wide token budget and rejects ambiguous policies", async () => {
    const fixture = await readFixture();
    expect(parseInstallationConfig(fixture).usageLimits).toBeUndefined();
    const usageLimits = { weeklyTokens: 7_500_000, timeZone: "Europe/Madrid", unlimitedUntil: "2026-10-31T23:00:00.000Z" };
    const parsed = parseInstallationConfig({ ...fixture, usageLimits });
    expect(parsed.usageLimits).toEqual(usageLimits);
    expect(Object.isFrozen(parsed.usageLimits)).toBe(true);
    for (const invalid of [null, {}, { ...usageLimits, weeklyTokens: 0 },
      { ...usageLimits, weeklyTokens: 1.5 }, { ...usageLimits, weeklyTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...usageLimits, timeZone: "UTC" }, { ...usageLimits, unlimitedUntil: "2026-11-01" },
      { ...usageLimits, excludeCache: true }]) {
      expect(() => parseInstallationConfig({ ...fixture, usageLimits: invalid })).toThrow(InstallationConfigValidationError);
    }
  });
  it("loads two genuinely different white-label installations", async () => {
    const development = await loadInstallationConfigFromFile(developmentFixture);
    const qa = await loadInstallationConfigFromFile(qaFixture);

    expect(development.schemaVersion).toBe(1);
    expect(qa.schemaVersion).toBe(1);
    expect(qa.installationId).not.toBe(development.installationId);
    expect(qa.companyName).not.toBe(development.companyName);
    expect(qa.publicUrl).not.toBe(development.publicUrl);
    expect(qa.branding).not.toEqual(development.branding);
    expect(qa.paths).not.toEqual(development.paths);
    expect(JSON.stringify([development, qa]).toLowerCase()).not.toMatch(/arnay|arnall|arnau/);
  });

  it("returns immutable normalized data", async () => {
    const config = await loadInstallationConfigFromFile(developmentFixture);

    expect(config.publicUrl).toBe("http://localhost:3000");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.branding)).toBe(true);
    expect(Object.isFrozen(config.paths)).toBe(true);
  });

  it("allows pending Outlook setup but accepts only an exact Microsoft Entra tenant", async () => {
    const fixture = await readFixture();
    fixture.connectors = { outlook: { enabled: true } };
    expect(parseInstallationConfig(fixture).connectors?.outlook).toEqual({ enabled: true });
    fixture.connectors = { outlook: { enabled: true, tenantId: "11111111-1111-4111-8111-111111111111" } };
    expect(parseInstallationConfig(fixture).connectors?.outlook).toEqual({ enabled: true, tenantId: "11111111-1111-4111-8111-111111111111" });
    fixture.connectors = { outlook: { enabled: true, tenantId: "common" } };
    expect(() => parseInstallationConfig(fixture)).toThrowError(expect.objectContaining<Partial<InstallationConfigValidationError>>({
      issues: expect.arrayContaining([expect.objectContaining({ path: "$.connectors.outlook.tenantId" })]),
    }));
  });

  it("rejects unknown fields at every configuration boundary", async () => {
    const fixture = await readFixture();
    const branding = fixture.branding as Record<string, unknown>;
    fixture.unexpected = true;
    branding.legacyTenant = "studio";

    expect(() => parseInstallationConfig(fixture)).toThrowError(
      expect.objectContaining<Partial<InstallationConfigValidationError>>({
        issues: expect.arrayContaining([
          { path: "$.unexpected", message: "campo desconocido" },
          { path: "$.branding.legacyTenant", message: "campo desconocido" },
        ]),
      }),
    );
  });

  it("rejects unsupported versions, insecure URLs and unsafe filesystem roots", async () => {
    const fixture = await readFixture();
    fixture.schemaVersion = 2;
    fixture.publicUrl = "http://brain.example.test/admin?token=1";
    fixture.paths = {
      ...(fixture.paths as Record<string, unknown>),
      dataRoot: "/",
      companyContextRoot: "/etc/aibrain-company",
      sourceReadRoot: "/mnt/company",
      publishWriteRoot: "/mnt/company/publish",
    };

    expect(() => parseInstallationConfig(fixture)).toThrowError(
      expect.objectContaining<Partial<InstallationConfigValidationError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "$.schemaVersion" }),
          expect.objectContaining({ path: "$.publicUrl" }),
          expect.objectContaining({ path: "$.paths.dataRoot" }),
          expect.objectContaining({ path: "$.paths.publishWriteRoot" }),
        ]),
      }),
    );
  });

  it("rejects overlapping private, source and publisher roots", async () => {
    const nestedPrivate = await readFixture();
    nestedPrivate.paths = {
      ...(nestedPrivate.paths as Record<string, unknown>),
      usersRoot: "/tmp/aibrain-example-lab/data/company/users",
      backupsRoot: "/tmp/aibrain-example-lab/data/company/users/backups",
    };
    expect(() => parseInstallationConfig(nestedPrivate)).toThrowError(
      expect.objectContaining<Partial<InstallationConfigValidationError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "$.paths.usersRoot" }),
          expect.objectContaining({ path: "$.paths.backupsRoot" }),
        ]),
      }),
    );

    const externalInsideData = await readFixture();
    externalInsideData.paths = {
      ...(externalInsideData.paths as Record<string, unknown>),
      sourceReadRoot: "/tmp/aibrain-example-lab/data/source-ro",
      publishWriteRoot: "/tmp/aibrain-example-lab/data/publish-rw",
    };
    expect(() => parseInstallationConfig(externalInsideData)).toThrowError(
      expect.objectContaining<Partial<InstallationConfigValidationError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "$.paths.sourceReadRoot" }),
          expect.objectContaining({ path: "$.paths.publishWriteRoot" }),
        ]),
      }),
    );

    const dataInsideSource = await readFixture();
    dataInsideSource.paths = {
      ...(dataInsideSource.paths as Record<string, unknown>),
      sourceReadRoot: "/tmp/aibrain-example-lab",
      publishWriteRoot: "/tmp/aibrain-example-lab-publish",
    };
    expect(() => parseInstallationConfig(dataInsideSource)).toThrowError(
      expect.objectContaining<Partial<InstallationConfigValidationError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "$.paths.sourceReadRoot" }),
        ]),
      }),
    );
  });

  it("fails closed when production has no absolute config path", () => {
    expect(() => resolveInstallationConfigPath({ env: { NODE_ENV: "production" } })).toThrow(
      "AIBRAIN_INSTALLATION_CONFIG es obligatorio en producción.",
    );
    expect(() => resolveInstallationConfigPath({
      env: {
        NODE_ENV: "production",
        AIBRAIN_INSTALLATION_CONFIG: "config/installations/qa.example.json",
      },
    })).toThrow("AIBRAIN_INSTALLATION_CONFIG debe ser una ruta absoluta.");
  });

  it("uses the synthetic development fixture only outside production", async () => {
    const loaded = await loadInstallationConfig({
      cwd: repositoryRoot,
      env: { NODE_ENV: "test" },
    });

    expect(loaded.installationId).toBe("example-lab-dev");
  });

  it("rejects symlinked configuration files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aibrain-installation-"));
    const target = path.join(directory, "target.json");
    const link = path.join(directory, "installation.json");
    await writeFile(target, await readFile(developmentFixture));
    await symlink(target, link);

    await expect(loadInstallationConfigFromFile(link)).rejects.toThrow(
      "InstallationConfig no puede ser un enlace simbólico.",
    );
  });

  it("creates a new installation through the operational command", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aibrain-installation-generator-"));
    const output = path.join(directory, "generated.json");
    try {
      await execFile(process.execPath, [
        path.join(repositoryRoot, "scripts/create-installation.mjs"),
        "--installation-id", "acme-test",
        "--company-name", "Acme Test Company",
        "--company-slug", "acme-test",
        "--public-url", "https://brain.acme.test",
        "--product-name", "Acme Brain",
        "--accent-color", "#123abc",
        "--data-root", "/srv/aibrain-acme-test/data",
        "--source-read-root", "/mnt/aibrain-acme-test/source-ro",
        "--publish-write-root", "/mnt/aibrain-acme-test/publish-rw",
        "--output", output,
      ], { cwd: repositoryRoot });

      const generated = await loadInstallationConfigFromFile(output);
      expect(generated).toMatchObject({
        schemaVersion: 1,
        installationId: "acme-test",
        companySlug: "acme-test",
        branding: {
          productName: "Acme Brain",
          logoPath: "/branding/acme-test/logo.svg",
          accentColor: "#123abc",
        },
        paths: {
          dataRoot: "/srv/aibrain-acme-test/data",
          usersRoot: "/srv/aibrain-acme-test/data/users",
        },
      });
      await expect(execFile(process.execPath, [
        path.join(repositoryRoot, "scripts/create-installation.mjs"),
        "--installation-id", "acme-test",
        "--company-name", "Acme Test Company",
        "--company-slug", "acme-test",
        "--public-url", "https://brain.acme.test",
        "--product-name", "Acme Brain",
        "--accent-color", "#123abc",
        "--data-root", "/srv/aibrain-acme-test/data",
        "--source-read-root", "/mnt/aibrain-acme-test/source-ro",
        "--publish-write-root", "/mnt/aibrain-acme-test/publish-rw",
        "--output", output,
      ], { cwd: repositoryRoot })).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
