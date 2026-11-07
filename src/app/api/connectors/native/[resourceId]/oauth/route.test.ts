import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({ session: vi.fn(), sameOrigin: vi.fn(), start: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: mocks.sameOrigin }));
vi.mock("@/connectors/native-connection-server-service", () => ({
  startNativeOAuthForSession: mocks.start, nativeConnectionFailure: mocks.failure,
}));
const context = { params: Promise.resolve({ resourceId: "personal-mail" }) };
const session = { user: { id: "employee" }, tenant: { id: "company" } };
const request = (method: "GET" | "POST", body?: string) => new Request("https://brain.example/api/connectors/native/personal-mail/oauth", { method, body });

describe("native OAuth browser and API initiation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sameOrigin.mockResolvedValue(true);
    mocks.session.mockResolvedValue(session);
    mocks.start.mockResolvedValue({ authorizationUrl: "https://provider.example/oauth?state=opaque", completion: "pending", loginId: "native-id" });
    mocks.failure.mockReturnValue({ code: "NATIVE_CONNECTION_SCOPE_DENIED", status: 403 });
  });
  it.each(["GET", "POST"] as const)("blocks foreign-origin %s before loading identity or starting OAuth", async method => {
    mocks.sameOrigin.mockResolvedValue(false);
    expect((await (method === "GET" ? GET : POST)(request(method), context)).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("requires a signed-in employee", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(request("GET"), context)).status).toBe(401);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("uses the existing button navigation with a no-store native provider redirect", async () => {
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://provider.example/oauth?state=opaque");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(session, "personal-mail");
  });
  it("returns an API initiation receipt without claiming connection success", async () => {
    const response = await POST(request("POST", "{}"), context);
    expect(await response.json()).toMatchObject({ schemaVersion: 1, completion: "pending", loginId: "native-id" });
    expect(response.status).toBe(200);
  });
  it("rejects caller-supplied server, callback, scope and account overrides", async () => {
    for (const body of ['{"server":"foreign"}', '{"scopes":["admin"]}', '{"callback":"https://foreign.example"}']) {
      expect((await POST(request("POST", body), context)).status).toBe(400);
    }
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("renders a readable browser failure with a fixed return and no provider details or technical code", async () => {
    mocks.start.mockRejectedValue(new Error("private provider token"));
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain("Revisa tus permisos");
    expect(html).toContain('href="/?settings=connectors"');
    expect(html).not.toMatch(/private provider|NATIVE_|<script|connection=/);
  });
  it("retains controlled policy codes for API callers", async () => {
    mocks.start.mockRejectedValue(new Error("private provider token"));
    const response = await POST(request("POST", "{}"), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "NATIVE_CONNECTION_SCOPE_DENIED" });
  });
  it.each([
    ["NATIVE_OAUTH_STATIC_CALLBACK_UNSUPPORTED", "revisar la compatibilidad"],
    ["NATIVE_CONNECTION_UNAVAILABLE", "configuración del servicio"],
  ])("explains %s without displaying a technical code", async (code, explanation) => {
    mocks.start.mockRejectedValue(new Error("secret-query"));
    mocks.failure.mockReturnValue({ code, status: 503 });
    const response = await GET(request("GET"), context), html = await response.text();
    expect(html).toContain(explanation);
    expect(html).not.toContain(code);
    expect(html).not.toContain("secret-query");
  });
});
