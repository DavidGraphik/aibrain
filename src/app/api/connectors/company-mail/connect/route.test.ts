import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: vi.fn() }));
vi.mock("@/connectors/company-mail-server-service", () => ({ companyMailContext: vi.fn(), connectCompanyMail: vi.fn() }));
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { connectCompanyMail } from "@/connectors/company-mail-server-service";
import { POST } from "./route";
import type { AuthSession } from "@/auth/types";
const session = { provider: "local", tenant: { id: "company-qa" }, user: { id: "00000000-0000-4000-8000-000000000001" } } as AuthSession;
const credential = { email: "billing@example.invalid", password: "hidden-password", folder: "INBOX", since: "2026-10-01" };
afterEach(() => vi.resetAllMocks());
function request(body = JSON.stringify(credential)) { return new Request("https://example-brain.example/api/connectors/company-mail/connect", { method: "POST", headers: { origin: "https://arnall.example-platform.invalid", "Content-Type": "application/json" }, body }); }

describe("company mailbox settings API", () => {
  it("requires same origin and an authenticated session before accepting secrets", async () => {
    vi.mocked(isSameOriginMutation).mockResolvedValue(false);
    expect((await POST(request())).status).toBe(403);
    expect(connectCompanyMail).not.toHaveBeenCalled();
    vi.mocked(isSameOriginMutation).mockResolvedValue(true);
    vi.mocked(getSession).mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(connectCompanyMail).not.toHaveBeenCalled();
  });
  it("bounds the actual body and never echoes input or provider errors", async () => {
    vi.mocked(isSameOriginMutation).mockResolvedValue(true); vi.mocked(getSession).mockResolvedValue(session);
    expect((await POST(request("x".repeat(8193)))).status).toBe(413);
    expect(connectCompanyMail).not.toHaveBeenCalled();
    vi.mocked(connectCompanyMail).mockRejectedValue(new Error(`provider rejected ${credential.password}`));
    const response = await POST(request());
    expect(await response.text()).not.toContain(credential.password);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });
  it("returns only sanitized connection metadata after verified login", async () => {
    vi.mocked(isSameOriginMutation).mockResolvedValue(true); vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(connectCompanyMail).mockResolvedValue({ status: "connected", accountEmail: credential.email, connectionVersion: 1 });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(connectCompanyMail).toHaveBeenCalledWith(session, credential);
    expect(await response.json()).toEqual({ status: "connected", accountEmail: credential.email, connectionVersion: 1 });
  });
});
