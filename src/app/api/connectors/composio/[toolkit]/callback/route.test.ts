import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), complete: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ publicUrl: "https://brain.example" }) }));
vi.mock("@/connectors/composio-service", () => ({ completeComposio: mocks.complete }));
import { GET } from "./route";
beforeEach(() => { mocks.session.mockReset().mockResolvedValue({ user: { id: "user" } }); mocks.complete.mockReset().mockResolvedValue(undefined); });
it.each([false, true])("returns to the public origin behind a reverse proxy (failure=%s)", async (fail) => {
  if (fail) mocks.complete.mockRejectedValue(new Error("denied"));
  const response = await GET(new Request("http://0.0.0.0:3000/api/connectors/composio/gmail/callback?state=receipt&status=success&connected_account_id=ca_test", { headers: { "x-forwarded-host": "untrusted.example" } }), { params: Promise.resolve({ toolkit: "gmail" }) });
  expect(response.headers.get("location")).toBe(`https://brain.example/?settings=connectors&connection=${fail ? "failed" : "verified"}`);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("returns an expired session to public login without processing the callback", async () => {
  mocks.session.mockResolvedValue(null);
  const response = await GET(new Request("http://0.0.0.0:3000/callback"), { params: Promise.resolve({ toolkit: "gmail" }) });
  expect(response.headers.get("location")).toBe("https://brain.example/login");
  expect(mocks.complete).not.toHaveBeenCalled();
});
