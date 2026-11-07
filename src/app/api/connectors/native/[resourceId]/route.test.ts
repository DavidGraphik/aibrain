import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({ session: vi.fn(), sameOrigin: vi.fn(), status: vi.fn(), change: vi.fn(), failure: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: mocks.sameOrigin }));
vi.mock("@/connectors/native-connection-server-service", () => ({
  nativeConnectionStatus: mocks.status, changeNativeConnection: mocks.change, nativeConnectionFailure: mocks.failure,
}));
const context = { params: Promise.resolve({ resourceId: "personal-mail" }) };
const session = { user: { id: "employee" }, tenant: { id: "company" } };
const request = (body: unknown) => new Request("https://brain.example/api/connectors/native/personal-mail", { method: "POST", body: JSON.stringify(body) });

describe("native connection status and local configuration routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sameOrigin.mockResolvedValue(true);
    mocks.session.mockResolvedValue(session);
    mocks.status.mockResolvedValue({ status: "connected", tools: [{ name: "search" }] });
    mocks.change.mockResolvedValue({ effect: "local-connection-disabled", providerCredentialsRevoked: false });
    mocks.failure.mockReturnValue({ code: "NATIVE_CONNECTION_CONFIG_NOT_EFFECTIVE", status: 409 });
  });
  it("uses authenticated identity for real status discovery", async () => {
    const response = await GET(new Request("https://brain.example/status"), context);
    expect(await response.json()).toMatchObject({ connection: { status: "connected" } });
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith(session, "personal-mail");
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it("fails closed without session or same-origin mutation", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(new Request("https://brain.example/status"), context)).status).toBe(401);
    mocks.sameOrigin.mockResolvedValue(false);
    expect((await POST(request({ operation: "disconnect" }), context)).status).toBe(403);
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it.each(["enable", "disconnect"])("changes only the server-resolved resource for %s", async operation => {
    const response = await POST(request({ operation }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ providerCredentialsRevoked: false });
    expect(mocks.change).toHaveBeenCalledExactlyOnceWith(session, "personal-mail", operation);
  });
  it.each([{ operation: "delete" }, { operation: "disconnect", server: "foreign" }, { operation: "enable", userId: "foreign" }, null])("rejects operation or scope overrides %j", async body => {
    expect((await POST(request(body), context)).status).toBe(400);
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it("does not claim disconnection when the native readback is pending or fails", async () => {
    mocks.change.mockRejectedValue(new Error("secret native error"));
    const response = await POST(request({ operation: "disconnect" }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "NATIVE_CONNECTION_CONFIG_NOT_EFFECTIVE" });
  });
});
