import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn(), user: vi.fn(), audit: vi.fn(), list: vi.fn(), thread: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.config }));
vi.mock("@/auth/local-user-store", () => ({ FileLocalUserStore: class { read = mocks.user; } }));
vi.mock("@/admin/workspace-admin-store", () => ({ FileWorkspaceAdminStore: class { recordConversationRead = mocks.audit; } }));
vi.mock("@/workbench/filesystem-store", () => ({ FileWorkbenchStore: class { static fromInstallation() { return { listThreads: mocks.list, getThread: mocks.thread }; } } }));
import { operatorConversations } from "./conversations";
const actor = "00000000-0000-4000-8000-000000000001";
const target = "00000000-0000-4000-8000-000000000002";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ installationId: "arnall", paths: { dataRoot: "/private/data", usersRoot: "/private/users" } });
  mocks.user.mockResolvedValue({ userId: target, displayName: "Mari Àngels" });
  mocks.audit.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue({ items: [{ id: "thread-1", title: "Hello", updatedAt: "today", status: "archived" }], nextCursor: "next" });
});
describe("operator conversation boundary", () => {
  it("rejects invalid identities and paths before reading user files", async () => {
    await expect(operatorConversations("invalid", target)).rejects.toThrow("Operator identity");
    await expect(operatorConversations(actor, "../../foreign")).rejects.toThrow("User not found");
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it("rejects unprovisioned targets without reading the workbench", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(operatorConversations(actor, target)).rejects.toThrow("User not found");
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.thread).not.toHaveBeenCalled();
  });
  it("paginates active and archived lists and durably records access", async () => {
    expect(await operatorConversations(actor, target, undefined, "page")).toMatchObject({ nextCursor: "next" });
    expect(mocks.list).toHaveBeenCalledWith(target, null, { status: "all", limit: 20, cursor: "page" });
    expect(mocks.audit).toHaveBeenCalledWith(actor, target, undefined, undefined);
  });
  it("returns messages without tool or runtime metadata", async () => {
    mocks.thread.mockResolvedValue({ id: "thread-1", title: "Hello", messages: [{ id: "m", role: "user", content: "Hi", activity: { secret: "hidden" } }], runtime: "hidden" });
    expect(JSON.stringify(await operatorConversations(actor, target, "thread-1"))).not.toContain("hidden");
    expect(mocks.audit).toHaveBeenCalledWith(actor, target, "thread-1", undefined);
  });
  it("fails closed when auditing cannot persist", async () => {
    mocks.audit.mockRejectedValue(new Error("disk failure"));
    await expect(operatorConversations(actor, target, "thread-1")).rejects.toThrow("disk failure");
    expect(mocks.thread).not.toHaveBeenCalled();
  });
});
