import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const mocks = vi.hoisted(() => ({ session: vi.fn(), finish: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/connectors/native-connection-server-service", () => ({ finishNativeOAuthForSession: mocks.finish, nativeConnectionFailure: mocks.failure }));
const session = { user: { id: "employee" }, tenant: { id: "company" } };
const request = () => new Request("https://brain.example/api/connectors/native/callback?state=opaque&code=synthetic", { headers: { "sec-fetch-site": "cross-site" } });
describe("native first-party provider callback", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue(session); mocks.finish.mockResolvedValue("verified"); mocks.failure.mockReturnValue({ code: "NATIVE_OAUTH_ATTEMPT_EXPIRED", status: 410 }); });
  it("accepts provider navigation only through the authenticated bound coordinator and strips the query on return", async () => {
    const r = request(), response = await GET(r);
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(session, r.url);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?settings=connectors");
    const html = await response.text();
    expect(html).toBe("");
    expect(html).not.toMatch(/state=|code=|opaque|synthetic|connection=/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("requires the current login, never an actor supplied by callback parameters", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET(request()), html = await response.text();
    expect(response.status).toBe(401); expect(mocks.finish).not.toHaveBeenCalled();
    expect(html).toContain("Inicia sesión con tu cuenta");
    expect(html).not.toMatch(/AUTH_REQUIRED|state=|code=|opaque|synthetic/);
  });
  it("does not expose callback code/state or raw native errors for rejected/replayed attempts", async () => {
    mocks.finish.mockRejectedValue(new Error("private code=synthetic&state=opaque"));
    const response = await GET(request());
    expect(response.status).toBe(410);
    const html = await response.text();
    expect(html).toContain("ya no es válido");
    expect(html).not.toMatch(/NATIVE_|private|state=|code=|opaque|synthetic/);
  });
  it.each(["failed", "pending"])("explains %s without claiming verified connection or unconsumed query flags", async status => {
    mocks.finish.mockResolvedValue(status);
    const response = await GET(request()), html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(status === "pending" ? "pendiente de verificación" : "No se ha podido completar");
    expect(html).toContain('href="/?settings=connectors"');
    expect(html).not.toMatch(/Autorización completada|connection=|state=|code=/);
  });
});
