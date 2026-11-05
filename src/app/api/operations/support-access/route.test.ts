import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enabled: true, sameOrigin: true, issue: vi.fn(), revoke: vi.fn() }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: async () => mocks.sameOrigin }));
vi.mock("@/auth/support-access-context", () => ({ supportAccessEnabled: () => mocks.enabled, createSupportAccessStore: async () => ({ issue: mocks.issue, revoke: mocks.revoke }) }));
import { POST, DELETE } from "./route";
const secret = "support-operator-secret-with-32-chars-min";
const input = { targetUserId: "target", targetEmail: "target@example.com", actorUserId: "actor", actorEmail: "actor@example.com", reason: "Verify isolation" };
function request(body: unknown, bearer = secret) { return new Request("https://example.com/api/operations/support-access", { method: "POST", headers: { Authorization: `Bearer ${bearer}`, Origin: "https://example.com" }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.stubEnv("AIBRAIN_OPERATOR_SECRET", secret); mocks.enabled = true; mocks.sameOrigin = true; mocks.issue.mockReset().mockResolvedValue({ code: "private-opaque-value", grantId: "a".repeat(64) }); mocks.revoke.mockReset().mockResolvedValue({ revoked: true }); });
afterEach(() => vi.unstubAllEnvs());
describe("operator support credential issuance", () => {
  it("requires independent operator authorization, opt-in and same origin", async () => {
    expect((await POST(request(input, "bad"))).status).toBe(401);
    mocks.enabled = false; expect((await POST(request(input))).status).toBe(404);
    mocks.enabled = true; mocks.sameOrigin = false; expect((await POST(request(input))).status).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("rejects unknown properties and non-string input", async () => {
    expect((await POST(request({ ...input, admin: true }))).status).toBe(400);
    expect((await POST(request({ ...input, reason: 42 }))).status).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("issues a private no-store receipt and revokes only a specific grant", async () => {
    const response = await POST(request(input)); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.issue).toHaveBeenCalledWith(input);
    expect((await DELETE(request({ grantId: "a".repeat(64) }))).status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith("a".repeat(64));
  });
});
