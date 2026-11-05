import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { profileAvatarOverride } from "./profile-avatar";
import { validatedAvatarUrl } from "./avatar-url";

describe("approved profile artwork", () => {
  it("allows only the exact bundled path without widening URL permissions", () => {
    expect(validatedAvatarUrl("/branding/arnall/profile-pig.png")).toBe("/branding/arnall/profile-pig.png");
    for (const value of ["/api/settings", "//evil.example/avatar.png", "javascript:alert(1)", "http://evil.example/avatar.png", "/branding/arnall/profile-pig.png/../private"]) {
      expect(validatedAvatarUrl(value)).toBeNull();
    }
    expect(validatedAvatarUrl("https://example.com/avatar.png")).toBe("https://example.com/avatar.png");
  });
  it("selects only Arnau's supplied account within Arnall", () => {
    expect(profileAvatarOverride("arnall", "upstream-maintainer@example.invalid", "https://arnall.example.com")).toBe("/branding/arnall/profile-pig.png");
    expect(profileAvatarOverride("another-company", "upstream-maintainer@example.invalid", "https://another.example.com")).toBeNull();
    expect(profileAvatarOverride("arnall", "someone-else@example.com", "https://arnall.example.com")).toBeNull();
    expect(profileAvatarOverride("arnall", "upstream-maintainer@example.invalid", "http://localhost:3100")).toBeNull();
  });
});
