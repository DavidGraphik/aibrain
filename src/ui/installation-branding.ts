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

export const UI_INSTALLATION_IDS = ["example-lab-dev", "northwind-qa"] as const;

export type UiInstallationId = (typeof UI_INSTALLATION_IDS)[number];

const INSTALLATIONS: Record<UiInstallationId, Readonly<PublicInstallationBranding>> = {
  "example-lab-dev": Object.freeze({
    installationId: "example-lab-dev",
    companyName: "Example Laboratory",
    companySlug: "example-laboratory",
    publicUrl: "http://localhost:3000",
    productName: "Example AI",
    logoPath: "/branding/example-lab/logo.svg",
    faviconPath: "/branding/example-lab/favicon.svg",
    accentColor: "#315ee7",
  }),
  "northwind-qa": Object.freeze({
    installationId: "northwind-qa",
    companyName: "Northwind Advisory QA",
    companySlug: "northwind-advisory",
    publicUrl: "https://brain.northwind-advisory.test",
    productName: "Northwind AI",
    logoPath: "/branding/northwind-qa/logo.svg",
    faviconPath: "/branding/northwind-qa/favicon.svg",
    accentColor: "#0f766e",
  }),
};

export function isUiInstallationId(value: unknown): value is UiInstallationId {
  return typeof value === "string" && UI_INSTALLATION_IDS.some((id) => id === value);
}

export function resolveUiInstallationBranding(
  requestedInstallation = process.env.AIBRAIN_UI_INSTALLATION,
): Readonly<PublicInstallationBranding> {
  const installationId = isUiInstallationId(requestedInstallation)
    ? requestedInstallation
    : "example-lab-dev";
  return INSTALLATIONS[installationId];
}
