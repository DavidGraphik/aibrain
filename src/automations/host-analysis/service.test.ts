import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ workspace: vi.fn(), project: vi.fn(), authorize: vi.fn(), binding: vi.fn(), create: vi.fn(), audience: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/automations/server-service", () => ({ automationWorkspaceForSession: mocks.workspace, validateAutomationAudience: mocks.audience }));
vi.mock("@/workbench/store", () => ({ getWritableProject: mocks.project }));
vi.mock("./store", () => ({ HostAnalysisStore: class { authorize = mocks.authorize; binding = mocks.binding; tasks() { return { create: mocks.create }; } } }));
import { authorizeHostJob, hostBindingsForSession } from "./service";
const id = "11111111-1111-4111-8111-111111111111", projectId = "10000000-0000-4000-8000-000000000001";
const session = { provider: "local", user: { id, email: "operator@example.invalid", name: "David" }, tenant: { id: "trinalum-production", name: "Trinalum" }, expiresAt: "2030-01-01T00:00:00.000Z" } as const;
const audience = { membershipPolicy: "current" as const, userIds: [id], groupIds: [] };
const workspace = { installation: { installationId: "trinalum-production" }, principal: { userId: id, email: "operator@example.invalid" } };
beforeEach(() => { vi.clearAllMocks(); mocks.workspace.mockResolvedValue(workspace); mocks.project.mockResolvedValue({ name: "Operaciones" }); mocks.audience.mockReturnValue(audience); mocks.binding.mockResolvedValue(null); });
describe("host authorization bound to verified Trinalum employee", () => {
  it.each([{ ...workspace, installation: { installationId: "other" } }, { ...workspace, principal: { ...workspace.principal, userId: projectId } }, { ...workspace, principal: { ...workspace.principal, email: "other@example.test" } }])("rejects a different tenant or employee even with the same email", async value => {
    mocks.workspace.mockResolvedValue(value); await expect(hostBindingsForSession(session)).rejects.toThrow("HOST_BINDING_OWNER_REQUIRED");
    expect(mocks.binding).not.toHaveBeenCalled(); expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it("requires current project and audience authority and creates an external task only", async () => {
    mocks.authorize.mockImplementation(async (scope, create) => { await create({ ...scope, taskId: projectId }); return scope; });
    await authorizeHostJob(session, { job: "automation-acceptance", projectId, audience });
    expect(mocks.workspace).toHaveBeenCalledWith(session); expect(mocks.project).toHaveBeenCalledWith(session, projectId);
    expect(mocks.audience).toHaveBeenCalledWith(audience, expect.objectContaining(workspace), id);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ schedule: { kind: "external" }, projectId, audience }), { id: projectId });
    mocks.project.mockRejectedValueOnce(Error("PROJECT_ACCESS_DENIED"));
    await expect(authorizeHostJob(session, { job: "automation-acceptance", projectId, audience })).rejects.toThrow("PROJECT_ACCESS_DENIED");
    expect(mocks.authorize).toHaveBeenCalledOnce();
  });
});
