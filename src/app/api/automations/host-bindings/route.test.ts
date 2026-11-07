import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), origin: vi.fn(), authorize: vi.fn(), list: vi.fn(), revoke: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: mocks.origin }));
vi.mock("@/automations/host-analysis/service", () => ({ authorizeHostJob: mocks.authorize, hostBindingsForSession: mocks.list, revokeHostJob: mocks.revoke }));
import { DELETE, GET, POST } from "./route";
const userId = "11111111-1111-4111-8111-111111111111", projectId = "10000000-0000-4000-8000-000000000001";
const session = { provider: "local", user: { id: userId, email: "operator@example.invalid" }, tenant: { id: "trinalum-production" } };
const input = { job: "automation-acceptance", projectId, audience: { membershipPolicy: "current", userIds: [userId], groupIds: [] } };
const request = (body: unknown, method = "POST") => new Request("https://trinalum.example/api/automations/host-bindings", { method, headers: { "Content-Type": "application/json", Authorization: "Bearer unrelated-operation-grant" }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue(session); mocks.origin.mockResolvedValue(true); mocks.authorize.mockResolvedValue({ taskId: "task" }); mocks.list.mockResolvedValue([]); mocks.revoke.mockResolvedValue(undefined); });
describe("host registration genuine browser authentication boundary", () => {
  it("cannot use a bearer grant or missing session for registration, reads or revoke", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await POST(request(input))).status).toBe(401);
    expect((await GET()).status).toBe(401);
    expect((await DELETE(request({ job: input.job }, "DELETE"))).status).toBe(401);
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("requires same-origin mutation and never accepts actor, tenant, token or raw source input", async () => {
    mocks.origin.mockResolvedValueOnce(false); expect((await POST(request(input))).status).toBe(403);
    for (const extra of [{ userId }, { tenantId: "other" }, { token: "anything" }, { input: "source" }]) expect((await POST(request({ ...input, ...extra }))).status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it("passes only the current genuine session and explicit reviewed scope to the authority service", async () => {
    expect((await POST(request(input))).status).toBe(201);
    expect(mocks.authorize).toHaveBeenCalledWith(session, input);
    mocks.authorize.mockRejectedValueOnce(Error("HOST_BINDING_OWNER_REQUIRED"));
    expect((await POST(request(input))).status).toBe(403);
    expect((await DELETE(request({ job: input.job }, "DELETE"))).status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(session, input.job);
  });
});
