import { afterEach, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ locale: "en" as "en" | "es" }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: async () => ({ provider: "local", tenant: { id: "modtime" } }) }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({
  installationId: "modtime", companyName: "MODTIME", companySlug: "modtime", publicUrl: "https://example.invalid",
  branding: { productName: "MODTIME AI", accentColor: "#123456", logoPath: "/logo.png", faviconPath: "/logo.png" },
}) }));
vi.mock("@/workbench/store", () => ({ loadWorkbench: async () => ({}) }));
vi.mock("@/i18n/server", () => ({ installationUiLocale: async () => "ca", userUiLocale: async () => fixtures.locale }));
vi.mock("@/components/brain-app", () => ({ BrainApp: () => null }));

import Home from "@/app/page";

afterEach(() => { fixtures.locale = "en"; });

it.each(["en", "es"] as const)("starts chat turns in the effective account %s language instead of company or seed defaults", async locale => {
  fixtures.locale = locale;
  const page = await Home({ searchParams: Promise.resolve({}) });
  expect(page.props.manifest.identity.language).toBe(locale);
  expect(page.props.manifest.identity.assistantName).toBe("MODTIME AI");
});
