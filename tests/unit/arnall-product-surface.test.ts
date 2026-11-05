import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadInstallationConfigFromFile } from "@/config/installation";
import { publicInstallationBranding } from "@/config/installation-branding";

const fixturePath = path.join(process.cwd(), "config/installations/arnall.qa.example.json");

describe("Synthetic installation branding surface", () => {
  it("projects the selected synthetic branding with no internal technical branding", async () => {
    const branding = publicInstallationBranding(await loadInstallationConfigFromFile(fixturePath));
    expect(branding).toMatchObject({
      companyName: "Example Retail Company",
      productName: "Northwind AI",
      logoPath: "/branding/northwind-qa/logo.svg",
      faviconPath: "/branding/northwind-qa/favicon.svg",
    });
    expect(`${branding.productName} ${branding.logoPath} ${branding.faviconPath}`).not.toMatch(/AiBrain|branding\/aibrain/i);
    await expect(access(path.join(process.cwd(), "public", branding.logoPath))).resolves.toBeUndefined();
  });

  it("keeps the visible memory surfaces free of the internal product name", async () => {
    const files = ["src/components/customization-panel.tsx", "src/components/memory-panel.tsx"];
    const contents = await Promise.all(files.map((file) => readFile(path.join(process.cwd(), file), "utf8")));
    expect(contents.join("\n")).not.toMatch(/Ai[ -]?Brain/i);
  });
});
