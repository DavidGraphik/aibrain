import type { BrainManifest } from "@/config/brain";
import type { InstallationConfig } from "@/config/installation-schema";

export type PublicInstallationBranding = {
  installationId: string;
  companyName: string;
  companySlug: string;
  publicUrl: string;
  productName: string;
  logoPath: string;
  faviconPath: string;
  accentColor: string;
};

export function publicInstallationBranding(
  installation: Readonly<InstallationConfig>,
): PublicInstallationBranding {
  return {
    installationId: installation.installationId,
    companyName: installation.companyName,
    companySlug: installation.companySlug,
    publicUrl: installation.publicUrl,
    productName: installation.branding.productName,
    logoPath: installation.branding.logoPath,
    faviconPath: installation.branding.faviconPath,
    accentColor: installation.branding.accentColor,
  };
}

export function applyInstallationBranding(
  manifest: BrainManifest,
  installation: Readonly<InstallationConfig>,
): BrainManifest {
  return {
    ...manifest,
    identity: {
      ...manifest.identity,
      productName: installation.branding.productName,
      assistantName: installation.branding.productName,
    },
    interface: {
      ...manifest.interface,
      accentColor: installation.branding.accentColor,
    },
  };
}
