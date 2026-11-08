import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const userId = "10000000-0000-4000-8000-000000000001", projectId = "20000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({ user: vi.fn(), policy: vi.fn(), project: vi.fn(), permissions: vi.fn(), roots: vi.fn(), call: vi.fn() }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ installationId: "test", paths: { usersRoot: "/fixture/users", dataRoot: "/fixture/data" } }) }));
vi.mock("@/auth/local-user-store", () => ({ FileLocalUserStore: class { read = mocks.user; } }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: mocks.policy }));
vi.mock("@/workbench/shared-access", () => ({ resolveProjectAccess: mocks.project }));
vi.mock("@/runtime/permission-turn", () => ({ resolveServerTurnPermissions: mocks.permissions }));
vi.mock("@/documents/enterprise-document-network", () => ({ EnterpriseDocumentNetwork: class { rootsForTurn = mocks.roots; } }));
vi.mock("./review-transport", () => ({ KnowledgeReviewTransport: class { call = mocks.call; } }));
import { listKnowledgeReviews, reviewKnowledge } from "./review-service";
const session = { provider: "local", tenant: { id: "test", name: "Test" }, user: { id: userId, name: "Reviewer", email: "reviewer@example.test" }, expiresAt: "2099-01-01T00:00:00Z" } as const;
const input = { projectId, scope: "company", scopeId: null, connectionId: "arnall", recordId: projectId, revision: 1, decision: "confirm" } as const;
const allowed = () => ({ role: { canManageWorkspace: true }, groups: [], policy: { capabilities: { consult: true, publish: true } } });
describe("current review authority", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.user.mockResolvedValue({ enabled: true }); mocks.policy.mockResolvedValue(allowed()); mocks.project.mockResolvedValue({ role: "owner" }); mocks.permissions.mockResolvedValue({});
    mocks.roots.mockResolvedValue([{ scope: "company", scopeId: null, path: "/fixture/company", readOnly: false }, { scope: "project", scopeId: projectId, path: "/fixture/project", readOnly: false }]);
    mocks.call.mockResolvedValue({ available: true });
  });
  it("denies foreign tenants, disabled users and members before project or knowledge reads", async () => {
    await expect(reviewKnowledge({ ...session, tenant: { id: "foreign", name: "Foreign" } }, input)).rejects.toMatchObject({ status: 403 });
    expect(mocks.user).not.toHaveBeenCalled();
    mocks.user.mockResolvedValue({ enabled: false }); await expect(reviewKnowledge(session, input)).rejects.toMatchObject({ status: 403 });
    mocks.user.mockResolvedValue({ enabled: true }); mocks.policy.mockResolvedValue({ ...allowed(), role: { canManageWorkspace: false } });
    await expect(reviewKnowledge(session, input)).rejects.toMatchObject({ status: 403 });
    expect(mocks.project).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled();
  });
  it("uses session actor and rereads role on each review", async () => {
    await reviewKnowledge(session, { ...input, actorId: projectId } as never);
    expect(mocks.call).toHaveBeenCalledWith(expect.any(Array), userId, { scope: "company", scopeId: null }, "review", { recordId: projectId, revision: 1, decision: "confirm" }, "arnall");
    mocks.policy.mockResolvedValue({ ...allowed(), role: { canManageWorkspace: false } });
    await expect(reviewKnowledge(session, input)).rejects.toMatchObject({ status: 403 }); expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("binds a correction to the session actor and requires current publication permission", async () => {
    const correction = { ...input, decision: "correct", content: "Qualified statement", reason: "Clarify source scope" } as const;
    await reviewKnowledge(session, correction);
    expect(mocks.call).toHaveBeenCalledWith(expect.any(Array), userId, { scope: "company", scopeId: null }, "correct",
      { recordId: projectId, revision: 1, content: correction.content, reason: correction.reason }, "arnall");
    mocks.policy.mockResolvedValue({ ...allowed(), policy: { capabilities: { consult: true, publish: false } } });
    await expect(reviewKnowledge(session, correction)).rejects.toMatchObject({ status: 403 });
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign private scopes and shared viewer mutations before the socket", async () => {
    await expect(reviewKnowledge(session, { ...input, scope: "private", scopeId: projectId })).rejects.toMatchObject({ status: 403 });
    mocks.project.mockResolvedValue({ role: "viewer" });
    await expect(reviewKnowledge(session, { ...input, scope: "project", scopeId: projectId })).rejects.toMatchObject({ status: 403 });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("allows governed knowledge review of read-only originals but denies publication capability loss", async () => {
    mocks.roots.mockResolvedValue([{ scope: "company", scopeId: null, readOnly: true }]);
    await expect(reviewKnowledge(session, input)).resolves.toMatchObject({ available: true });
    mocks.policy.mockResolvedValue({ ...allowed(), policy: { capabilities: { consult: true, publish: false } } });
    await expect(reviewKnowledge(session, input)).rejects.toMatchObject({ status: 403 });
    expect(await listKnowledgeReviews(session, { projectId, scope: "company", scopeId: null, status: "proposed", cursor: 0 })).toMatchObject({ scopes: [{ canReview: false }] });
  });
});
