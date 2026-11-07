import { describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
const state = vi.hoisted(() => ({ recoveryId: "a".repeat(43) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: state.recoveryId }) }) }));
vi.mock("@/auth/session-cookie", () => ({ PASSWORD_RECOVERY_COOKIE: "__Host-aibrain-password-recovery" }));
import RecoveryPage, { metadata } from "@/app/auth/recovery/page";
vi.mock("@/components/recovery-form", () => ({ RecoveryForm: () => null }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({}) }));
vi.mock("@/config/installation-branding", () => ({ publicInstallationBranding: () => ({ productName: "Brain" }) }));
// An existing workbench session must not prevent an explicit recovery link from
// being used. No authenticated session grants recovery rights by itself.
vi.mock("@/auth/session", () => ({ getSession: () => { throw new Error("must not redirect an existing session"); } }));

describe("recovery page", () => {
  it("passes the email proof to the form even when another local session exists", async () => {
    const page = await RecoveryPage({ searchParams: Promise.resolve({ token_hash: "synthetic-hash", type: "recovery" }) });
    expect(page.props.proof).toEqual({ tokenHash: "synthetic-hash" });
    expect(metadata.referrer).toBe("no-referrer");
  });
  it("passes no proof when the callback reports an error", async () => {
    const page = await RecoveryPage({ searchParams: Promise.resolve({ error_code: "otp_expired" }) });
    expect(page.props.proof).toBeNull();
  });
  it("overrides the general referrer policy before any recovery assets are fetched", async () => {
    const headers = await nextConfig.headers!();
    const policies = headers.flatMap((rule) => rule.headers)
      .filter((header) => header.key === "Referrer-Policy");
    expect(policies.at(-1)?.value).toBe("no-referrer");
    expect(headers.find((rule) => rule.source === "/auth/recovery")?.headers)
      .toContainEqual({ key: "Cache-Control", value: "private, no-store" });
  });

  it("requires the same-browser opaque cookie for a PKCE code", async () => {
    state.recoveryId = "a".repeat(43);
    expect((await RecoveryPage({ searchParams: Promise.resolve({ code: "synthetic-code" }) })).props.proof).toEqual({ code: "synthetic-code" });
    state.recoveryId = "";
    expect((await RecoveryPage({ searchParams: Promise.resolve({ code: "synthetic-code" }) })).props.proof).toBeNull();
  });

});
