import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enabled: true, sameOrigin: true, allowed: true, redeem: vi.fn(), cookie: vi.fn(), remove: vi.fn() }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: async () => mocks.sameOrigin }));
vi.mock("@/auth/support-access-context", () => ({ supportAccessEnabled: () => mocks.enabled, createSupportAccessStore: async () => ({ redeem: mocks.redeem }) }));
vi.mock("@/auth/session-cookie", () => ({ setLocalSessionCookie: mocks.cookie }));
vi.mock("@/auth/rate-limit-context", () => ({ checkAuthRateLimit: async () => ({ allowed: mocks.allowed, retryAfterSeconds: 60 }) }));
vi.mock("@/auth/auth-context", () => ({ createLocalSessionContext: async () => ({ sessions: { delete: mocks.remove } }) }));
import { POST } from "./route";
const session = { sessionId: "private-session", record: { absoluteExpiresAt: 10000 } };
const request = (body: unknown) => new Request("https://example.com/api/auth/support", { method: "POST", headers: { Origin: "https://example.com" }, body: JSON.stringify(body) });
beforeEach(() => { mocks.enabled = true; mocks.sameOrigin = true; mocks.allowed = true; mocks.redeem.mockReset().mockResolvedValue(session); mocks.cookie.mockReset().mockResolvedValue(undefined); mocks.remove.mockReset().mockResolvedValue(true); });
describe("one-time support UI login", () => {
  it("enforces opt-in, Origin and rate limits before exchanging a code", async () => {
    mocks.enabled = false; expect((await POST(request({ code: "a".repeat(43) }))).status).toBe(404);
    mocks.enabled = true; mocks.sameOrigin = false; expect((await POST(request({ code: "a".repeat(43) }))).status).toBe(403);
    mocks.sameOrigin = true; mocks.allowed = false; expect((await POST(request({ code: "a".repeat(43) }))).status).toBe(429);
    expect(mocks.redeem).not.toHaveBeenCalled();
  });
  it("sets the ordinary HttpOnly session through server cookie helper without returning bearer", async () => {
    const response = await POST(request({ code: "a".repeat(43) })); expect(response.status).toBe(200);
    expect(mocks.cookie).toHaveBeenCalledWith(session); expect(await response.text()).not.toContain(session.sessionId);
  });
  it("revokes a created session if setting the cookie fails", async () => {
    mocks.cookie.mockRejectedValueOnce(new Error("cookies unavailable"));
    expect((await POST(request({ code: "a".repeat(43) }))).status).toBe(400); expect(mocks.remove).toHaveBeenCalledWith(session.sessionId);
  });
  it("rejects extra input and does not create a session", async () => {
    expect((await POST(request({ code: "a".repeat(43), userId: "other" }))).status).toBe(400); expect(mocks.redeem).not.toHaveBeenCalled();
  });
});
