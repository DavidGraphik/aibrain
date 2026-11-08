import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";
const mocks = vi.hoisted(() => ({ session: vi.fn(), origin: vi.fn(), rate: vi.fn(), connect: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: mocks.origin }));
vi.mock("@/auth/rate-limit-context", () => ({ checkAuthRateLimit: mocks.rate }));
vi.mock("@/connectors/mail-server-service", () => ({ connectMail: mocks.connect }));
beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue({ user: { id: "authenticated-user" } }); mocks.origin.mockResolvedValue(true); mocks.rate.mockResolvedValue({ allowed: true }); mocks.connect.mockResolvedValue({ connected: true }); });
const request = (body: unknown) => new Request("https://brain.example/api/connectors/mail/connect", { method: "POST", headers: { Origin: "https://brain.example", "Content-Type": "application/json" }, body: JSON.stringify(body) });
it("requires origin, session and a bounded rate before touching mailbox credentials", async () => {
  mocks.origin.mockResolvedValue(false); expect((await POST(request({ password: "secret" }))).status).toBe(403);
  mocks.origin.mockResolvedValue(true); mocks.session.mockResolvedValue(null); expect((await POST(request({ password: "secret" }))).status).toBe(401);
  mocks.session.mockResolvedValue({ user: { id: "authenticated-user" } }); mocks.rate.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 }); const limited = await POST(request({ password: "secret" })); expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBe("60"); expect(mocks.connect).not.toHaveBeenCalled();
});
it("accepts only the own-mailbox password and rejects foreign email, unknown fields and oversized streams", async () => {
  expect((await POST(request({ password: "secret", email: "someone@example.test" }))).status).toBe(400);
  expect((await POST(request({ password: "secret", installationId: "foreign" }))).status).toBe(400);
  expect((await POST(request({ password: "x".repeat(4100) }))).status).toBe(413);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect((await POST(request({ password: "secret" }))).status).toBe(200); expect(mocks.connect).toHaveBeenCalledWith({ user: { id: "authenticated-user" } }, "secret");
});
it("never reflects provider exceptions or passwords to the browser", async () => {
  mocks.connect.mockRejectedValue(new Error("private-password provider diagnostic")); const response = await POST(request({ password: "secret" })); expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-password"); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
