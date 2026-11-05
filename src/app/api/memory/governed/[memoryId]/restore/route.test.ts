import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  isSameOriginMutation: vi.fn(),
  memoryProposalServiceForSession: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("@/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: mocks.isSameOriginMutation }));
vi.mock("@/memory/server-service", () => ({ memoryProposalServiceForSession: mocks.memoryProposalServiceForSession }));

import { POST } from "@/app/api/memory/governed/[memoryId]/restore/route";

const memoryId = "20000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000001";
const context = { installationId: "memory-qa", userId: "40000000-0000-4000-8000-000000000001", projectId };
const session = { provider: "local", tenant: { id: "memory-qa" }, user: { id: context.userId } };
const body = { explicit: true, projectId, expectedRevision: 2 };

function request(payload: unknown = body) {
  return new Request("http://localhost/api/memory/governed/memory/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify(payload),
  });
}

const route = { params: Promise.resolve({ memoryId }) };

describe("governed memory restore route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSameOriginMutation.mockResolvedValue(true);
    mocks.getSession.mockResolvedValue(session);
    mocks.memoryProposalServiceForSession.mockResolvedValue({
      store: { restore: mocks.restore },
      context,
      allowCompanyScope: false,
    });
  });

  it("rejects cross-origin and unauthenticated restoration before touching the store", async () => {
    mocks.isSameOriginMutation.mockResolvedValueOnce(false);
    expect((await POST(request(), route)).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();

    mocks.getSession.mockResolvedValueOnce(null);
    expect((await POST(request(), route)).status).toBe(401);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("does not bypass company-scope permission supplied by the server", async () => {
    mocks.restore.mockRejectedValueOnce(new Error("Company memory requires workspace administration permission."));

    const response = await POST(request(), route);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Company memory requires workspace administration permission." });
    expect(mocks.restore).toHaveBeenCalledWith(context, {
      memoryId,
      explicit: true,
      expectedRevision: 2,
      allowCompanyScope: false,
    });
  });

  it("restores with the server-derived permission and reports revision conflicts", async () => {
    mocks.memoryProposalServiceForSession.mockResolvedValueOnce({
      store: { restore: mocks.restore },
      context,
      allowCompanyScope: true,
    });
    mocks.restore.mockResolvedValueOnce({ memoryId, status: "active", revision: 3 });
    const restored = await POST(request(), route);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ memory: { memoryId, status: "active", revision: 3 } });
    expect(mocks.restore).toHaveBeenCalledWith(context, {
      memoryId,
      explicit: true,
      expectedRevision: 2,
      allowCompanyScope: true,
    });

    mocks.restore.mockRejectedValueOnce(new Error("Memory changed before restoration was confirmed."));
    const conflict = await POST(request(), route);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "Memory changed before restoration was confirmed." });
  });

  it("rejects implicit, stale-shaped or over-posted restore requests", async () => {
    expect((await POST(request({ ...body, explicit: false }), route)).status).toBe(400);
    expect((await POST(request({ ...body, expectedRevision: 0 }), route)).status).toBe(400);
    expect((await POST(request({ ...body, actorUserId: context.userId }), route)).status).toBe(400);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
