import { describe, expect, it } from "vitest";
import { baseBrainManifest, customAccentTokens } from "@/config/brain";
import {
  applyInstallationBranding,
  publicInstallationBranding,
} from "@/config/installation-branding";
import { parseInstallationConfig } from "@/config/installation-schema";
import { resolveUiInstallationBranding } from "@/ui/installation-branding";

function installation(accentColor: string) {
  return parseInstallationConfig({
    schemaVersion: 1,
    installationId: "branding-qa",
    companyName: "Branding QA",
    companySlug: "branding-qa",
    publicUrl: "https://brain.branding.test",
    branding: {
      productName: "Configured Brain",
      logoPath: "/branding/qa/logo.svg",
      faviconPath: "/branding/qa/favicon.svg",
      accentColor,
    },
    paths: {
      dataRoot: "/srv/branding-qa/data",
      companyContextRoot: "/srv/branding-qa/data/company",
      usersRoot: "/srv/branding-qa/data/users",
      sourceReadRoot: "/srv/branding-qa/source-ro",
      publishWriteRoot: "/srv/branding-qa/publish-rw",
      backupsRoot: "/srv/branding-qa/data/backups",
    },
  });
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => [1, 3, 5]
    .map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function mixHex(background: string, foreground: string, foregroundAmount: number) {
  const channels = [1, 3, 5].map((offset) => {
    const from = Number.parseInt(background.slice(offset, offset + 2), 16);
    const to = Number.parseInt(foreground.slice(offset, offset + 2), 16);
    return Math.round(from + (to - from) * foregroundAmount).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

describe("installation branding", () => {
  it("applies product and exact accent without mutating the shared manifest", () => {
    const config = installation("#0f766e");
    const branded = applyInstallationBranding(baseBrainManifest, config);
    expect(branded.identity.productName).toBe("Configured Brain");
    expect(branded.identity.assistantName).toBe("Configured Brain");
    expect(branded.interface.accentColor).toBe("#0f766e");
    expect(baseBrainManifest.interface.accentColor).toBeUndefined();
    expect(publicInstallationBranding(config)).toMatchObject({
      installationId: "branding-qa",
      productName: "Configured Brain",
      accentColor: "#0f766e",
    });
  });

  it("chooses readable contrast for dark and light configured colors", () => {
    expect(customAccentTokens("#0f766e")).toMatchObject({ solid: "#0f766e", contrast: "#ffffff" });
    expect(customAccentTokens("#ffffff")).toMatchObject({ solid: "#ffffff", contrast: "#111827" });
    expect(customAccentTokens("not-a-color")).toBeNull();
  });

  it("derives contrast-safe accent roles for both themes", () => {
    for (const color of ["#315ee7", "#00aa00", "#ff0000", "#ffffff", "#171717"]) {
      const tokens = customAccentTokens(color);
      expect(tokens).not.toBeNull();
      for (const surface of ["#ffffff", "#f4f4f4", "#ececec", "#e7e7e7"]) {
        expect(contrastRatio(tokens!.onLight, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens!.onLightSoft, mixHex(surface, tokens!.onLight, 0.12))).toBeGreaterThanOrEqual(4.5);
      }
      for (const surface of ["#000000", "#202020", "#2a2a2a", "#303030", "#353535"]) {
        expect(contrastRatio(tokens!.onDark, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens!.onDarkSoft, mixHex(surface, tokens!.onDark, 0.12))).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(tokens!.onLightSoft, mixHex("#ffffff", tokens!.onLight, 0.1))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens!.onDarkSoft, mixHex("#000000", tokens!.onDark, 0.26))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens!.onLightContrast, tokens!.onLight)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens!.onDarkContrast, tokens!.onDark)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("UI installation fixtures", () => {
  it("uses the development installation as a safe fallback", () => {
    expect(resolveUiInstallationBranding("unknown")).toMatchObject({
      installationId: "example-lab-dev",
      productName: "Example AI",
      accentColor: "#315ee7",
    });
  });

  it("changes company, domain, assets and accent without component forks", () => {
    expect(resolveUiInstallationBranding("northwind-qa")).toEqual({
      installationId: "northwind-qa",
      companyName: "Northwind Advisory QA",
      companySlug: "northwind-advisory",
      publicUrl: "https://brain.northwind-advisory.test",
      productName: "Northwind AI",
      logoPath: "/branding/northwind-qa/logo.svg",
      faviconPath: "/branding/northwind-qa/favicon.svg",
      accentColor: "#0f766e",
    });
  });
});
