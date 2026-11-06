import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
const mocks = vi.hoisted(() => ({ session: vi.fn(), origin: vi.fn(), change: vi.fn(), failure: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: mocks.origin }));
vi.mock("@/connectors/native-connection-server-service", () => ({ changeNativeConnection: mocks.change, nativeConnectionFailure: mocks.failure }));
const context = { params: Promise.resolve({ resourceId: "personal-mail" }) }, session = { user: { id: "employee" }, tenant: { id: "company" } };
const request = (body?: string) => new Request("https://brain.example/api/connectors/native/personal-mail/disconnect", { method: "POST", body });
describe("existing settings disconnect button native endpoint", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue(session); mocks.origin.mockResolvedValue(true); mocks.change.mockResolvedValue({ enabled: false, effect: "local-connection-disabled", providerCredentialsRevoked: false }); });
  it.each([undefined, "{}"])("accepts existing empty-button request %s without provider-revocation claims", async body => {
    const response = await POST(request(body), context);
    expect(await response.json()).toMatchObject({ enabled: false, providerCredentialsRevoked: false });
    expect(mocks.change).toHaveBeenCalledExactlyOnceWith(session, "personal-mail", "disconnect");
  });
  it("denies cross-site/authless and caller-supplied identities/actions", async () => {
    mocks.origin.mockResolvedValue(false); expect((await POST(request(), context)).status).toBe(403);
    mocks.origin.mockResolvedValue(true); mocks.session.mockResolvedValue(null); expect((await POST(request(), context)).status).toBe(401);
    mocks.session.mockResolvedValue(session); expect((await POST(request('{"userId":"foreign"}'), context)).status).toBe(400);
    expect(mocks.change).not.toHaveBeenCalled();
  });
});
