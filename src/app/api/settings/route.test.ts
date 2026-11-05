import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, isSameOriginMutation, settingsSnapshot, updateSettings } = vi.hoisted(() => ({
  getSession: vi.fn(),
  isSameOriginMutation: vi.fn(),
  settingsSnapshot: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation }));
vi.mock("@/settings/server-service", () => ({ settingsSnapshot, updateSettings }));

import { GET, PATCH } from "@/app/api/settings/route";

const session = {
  provider: "local" as const,
  user: { id: "00000000-0000-4000-8000-000000000001", name: "Ada", email: "ada@example.com" },
  tenant: { id: "example-lab-dev", name: "Example" },
  expiresAt: "2026-08-29T00:00:00.000Z",
};

describe("settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue(session);
    isSameOriginMutation.mockResolvedValue(true);
  });

  it("keeps private settings behind authentication", async () => {
    getSession.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects cross-origin and unknown mutations before storage", async () => {
    isSameOriginMutation.mockResolvedValue(false);
    const crossOrigin = await PATCH(new Request("http://localhost/api/settings", { method: "PATCH" }));
    expect(crossOrigin.status).toBe(403);

    isSameOriginMutation.mockResolvedValue(true);
    const invalid = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "user-app", appId: "gmail", enabled: true }),
    }));
    expect(invalid.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("does not expose employee app administration through the settings API", async () => {
    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "user-app", appId: "web-search", enabled: false }),
    }));
    expect(response.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("keeps direct installation changes behind the server-side administrator check", async () => {
    const denied = Object.assign(new Error("denied"), { code: "SETTINGS_ADMIN_REQUIRED" });
    updateSettings.mockRejectedValue(denied);
    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "installation-app", appId: "web-search", enabled: false }),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "SETTINGS_ADMIN_REQUIRED" });
    expect(updateSettings).toHaveBeenCalledWith(session, {
      target: "installation-app", appId: "web-search", enabled: false,
    });
  });
});
