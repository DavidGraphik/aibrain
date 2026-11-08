import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadInstallation: vi.fn(),
  readUser: vi.fn(),
  readState: vi.fn(),
  role: vi.fn(),
  aggregate: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readdir: async () => [{ name: "00000000-0000-4000-8000-000000000001", isDirectory: () => true, isSymbolicLink: () => false }],
}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocked.loadInstallation }));
vi.mock("@/auth/local-user-store", () => ({ FileLocalUserStore: class { read = mocked.readUser; } }));
vi.mock("@/admin/workspace-admin-store", () => ({
  effectiveWorkspacePolicy: mocked.role,
  FileWorkspaceAdminStore: class { read = mocked.readState; auditLog = async () => []; },
}));
vi.mock("@/usage/file-usage-store", () => ({
  aggregateTurnUsage: mocked.aggregate,
  FileUsageStore: class { listTurns = async () => []; },
}));
vi.mock("@/runtime/worker-runtime-service", () => ({ workerRuntimeHealth: async () => null }));
vi.mock("@/users/lifecycle-server", () => ({ executeUserLifecycleCommand: vi.fn() }));
vi.mock("@/users/provisioner", () => ({ UserProvisioner: class {} }));

import { workspaceAdminSnapshot } from "@/admin/server-service";

const session = {
  provider: "local" as const,
  user: { id: "00000000-0000-4000-8000-000000000001", name: "Employee", email: "employee@example.test" },
  tenant: { id: "arnall", name: "Arnall" },
  expiresAt: "2026-12-31T00:00:00Z",
};
const installation = { installationId: "arnall", companyName: "Arnall", paths: { dataRoot: "/private/data", usersRoot: "/private/users" } };

describe("administration allowance privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadInstallation.mockResolvedValue({ ...installation, usageLimits: { weeklyTokens: 7_500_000, timeZone: "Europe/Madrid" } });
    mocked.readUser.mockResolvedValue({ userId: session.user.id, displayName: "Employee", email: session.user.email, enabled: true, workerId: "worker" });
    mocked.readState.mockResolvedValue({ assignments: [], groups: [], roles: [] });
    mocked.aggregate.mockReturnValue({ turns: 12, tokens: { inputTokens: 500_000, outputTokens: 50_000 } });
    mocked.role.mockReturnValue({ roleId: "workspace-owner", role: { canManageWorkspace: true } });
  });

  it.each(["workspace-owner", "workspace-admin"])("omits all numeric token counts from %s snapshots while retaining administration", async (roleId) => {
    mocked.role.mockReturnValue({ roleId, role: { canManageWorkspace: true } });
    const snapshot = await workspaceAdminSnapshot(session);
    expect(snapshot.members[0].usage).toEqual({ turns: 12 });
    expect(JSON.stringify(snapshot)).not.toMatch(/inputTokens|outputTokens|500000|50000|7500000/);
  });

  it("preserves existing unbudgeted installation usage", async () => {
    mocked.loadInstallation.mockResolvedValue(installation);
    expect((await workspaceAdminSnapshot(session)).members[0].usage).toEqual({ turns: 12, inputTokens: "500000", outputTokens: "50000" });
  });
});
