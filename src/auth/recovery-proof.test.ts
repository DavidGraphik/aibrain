import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readRecoveryProof, recoveryProofFromQuery } from "./recovery-proof";

describe("recovery link contract", () => {
  it("admits only one bounded opaque proof and the recovery action", () => {
    expect(recoveryProofFromQuery({ token_hash: "synthetic-hash", type: "recovery" }))
      .toEqual({ tokenHash: "synthetic-hash" });
    expect(recoveryProofFromQuery({ code: "synthetic-code" })).toEqual({ code: "synthetic-code" });
    for (const query of [
      {}, { token_hash: "" }, { token_hash: "a b" }, { token_hash: "a".repeat(2049) },
      { token_hash: ["first", "second"] }, { code: ["first", "second"] },
      { code: "", token_hash: "synthetic-hash" },
      { code: "synthetic-code", token_hash: "synthetic-hash" },
      { token_hash: "synthetic-hash", type: "invite" },
      { token_hash: "synthetic-hash", type: ["recovery", "invite"] },
      { token_hash: "synthetic-hash", error_code: "otp_expired" },
      { access_token: "synthetic-session", refresh_token: "synthetic-refresh", type: "recovery" },
    ]) expect(recoveryProofFromQuery(query)).toBeNull();
    expect(readRecoveryProof({ tokenHash: "synthetic-hash", code: 4 })).toBeNull();
  });

  it("renders the email onto the requesting installation rather than the global SiteURL", async () => {
    const template = await readFile("supabase/templates/recovery.html", "utf8");
    for (const origin of ["https://first.example.test", "https://second.example.test"]) {
      const rendered = template.replaceAll("{{ .RedirectTo }}", `${origin}/auth/recovery`)
        .replaceAll("{{ .TokenHash }}", "synthetic-token-hash");
      const href = rendered.match(/href="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
      const link = new URL(href!);
      expect(link.origin).toBe(origin);
      expect(link.pathname).toBe("/auth/recovery");
      expect(recoveryProofFromQuery(Object.fromEntries(link.searchParams)))
        .toEqual({ tokenHash: "synthetic-token-hash" });
      expect(link.hash).toBe("");
    }
    expect(template).not.toContain(".SiteURL");
    expect(template).not.toContain(".ConfirmationURL");
  });
});
