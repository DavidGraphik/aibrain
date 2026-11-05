import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { WorkbenchSnapshot } from "@/workbench/types";

vi.mock("server-only", () => ({}));
const { loadWorkbench, getThread } = vi.hoisted(() => ({ loadWorkbench: vi.fn(), getThread: vi.fn() }));
vi.mock("@/workbench/store", () => ({ loadWorkbench, createWorkbenchThreadReader:async (session: AuthSession)=>(id: string)=>getThread(session,id) }));
vi.mock("@/automations/thread-access", () => ({ quietAutomationResultMessageIds: async () => [] }));
import { getTaskCenter, updateTaskCenter } from "@/task-center/server-service";

function session(user: string): AuthSession {
  return {
    provider: "demo", user: { id: user, name: user, email: `${user}@example.test` },
    tenant: { id: `tenant-${user}`, name: user }, expiresAt: "2099-01-01T00:00:00Z",
  };
}

function snapshot(user: string): WorkbenchSnapshot {
  return {
    persistence: "browser-preview", projects: [], threads: [{
      id: user, projectId: user, title: user, status: "active", pinned: false,
      createdAt: "2026-10-26T17:00:00Z", updatedAt: "2026-10-26T17:00:00Z",
      messages: [
        { role: "user", id: `request-${user}`, content: "request", status: "complete", approvals: [], activity: [], plan: [], diff: "", attachments: [], artifacts: [], createdAt: "2026-10-26T17:00:00Z" },
        { role: "assistant", id: user, content: user, status: "complete", approvals: [], activity: [], plan: [], diff: "", attachments: [], artifacts: [], createdAt: "2026-10-26T17:00:00Z" },
      ],
    }],
  };
}

describe("task-center history read admission", () => {
  beforeEach(() => {
    loadWorkbench.mockReset();
    getThread.mockReset();
    loadWorkbench.mockImplementation(async (current: AuthSession, metadataOnly: boolean) => {
      expect(metadataOnly).toBe(true);
      const value = snapshot(current.user.id);
      return { ...value, threads: value.threads.map(thread => ({ ...thread, messages: [], historyLoaded: false })) };
    });
    getThread.mockImplementation(async (current: AuthSession, threadId: string) => {
      expect(threadId).toBe(current.user.id);
      return snapshot(current.user.id).threads[0];
    });
  });

  it("bounds 13 overlapping GET/PATCH hydrations to one, in arrival order, without sharing results", async () => {
    const releases: Array<() => void> = [];
    const admitted: string[] = [];
    let active = 0;
    let peak = 0;
    getThread.mockImplementation(async (current: AuthSession, threadId: string) => {
      expect(threadId).toBe(current.user.id);
      admitted.push(current.user.id);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => { releases.push(resolve); });
      active -= 1;
      return snapshot(current.user.id).threads[0];
    });
    const requests = Array.from({ length: 13 }, (_, index) => index === 5
      ? updateTaskCenter(session(`user-${index}`), { preferences: { inApp: false, desktop: true } })
      : getTaskCenter(session(`user-${index}`)));
    for (let index = 0; index < requests.length; index += 1) {
      await vi.waitFor(() => expect(releases).toHaveLength(index + 1));
      expect(admitted).toEqual(Array.from({ length: index + 1 }, (_, item) => `user-${item}`));
      releases[index]();
      const payload = await requests[index];
      expect(payload.tasks.map(task => task.title)).toEqual([`user-${index}`]);
      expect(payload.preferences).toEqual(index === 5
        ? { inApp: false, desktop: true } : { inApp: true, desktop: false });
    }
    expect(peak).toBe(1);
    expect(loadWorkbench).toHaveBeenCalledTimes(13);
    expect(getThread).toHaveBeenCalledTimes(13);
  });

  it("rechecks access after a queued request and recovers after denial without caching prior visibility", async () => {
    let release!: () => void;
    let authorized = true;
    getThread.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return snapshot("owner").threads[0];
    });
    loadWorkbench.mockImplementation(async (current: AuthSession, metadataOnly: boolean) => {
      expect(metadataOnly).toBe(true);
      if (!authorized) throw new Error("access revoked");
      const value = snapshot(current.user.id);
      return { ...value, threads: value.threads.map(thread => ({ ...thread, messages: [], historyLoaded: false })) };
    });
    const first = getTaskCenter(session("owner"));
    const queued = getTaskCenter(session("recipient"));
    const denial = expect(queued).rejects.toThrow("access revoked");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    authorized = false;
    release();
    expect((await first).tasks[0].title).toBe("owner");
    await denial;
    authorized = true;
    expect((await getTaskCenter(session("next"))).tasks[0].title).toBe("next");
    expect(loadWorkbench).toHaveBeenCalledTimes(3);
  });
});
