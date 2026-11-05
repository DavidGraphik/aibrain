import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveProjectRequest,
  branchThreadRequest,
  getThreadRequest,
  listProjectsRequest,
  listThreadsRequest,
} from "@/lib/workbench-api-client";
import type { WorkbenchProject, WorkbenchThread } from "@/workbench/types";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const THREAD_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_AT = "2026-08-27T09:00:00.000Z";

const project: WorkbenchProject = {
  id: PROJECT_ID,
  name: "Synthetic Project",
  slug: "synthetic-project",
  status: "active",
  pinned: false,
  instructions: "",
  sources: [],
  memory: { enabled: true, notes: "", updatedAt: null },
  sharing: { visibility: "private", members: [] },
  workspace: {
    id: WORKSPACE_ID,
    label: "Synthetic Project",
    hostType: "managed",
    status: "ready",
    isPrimary: true,
  },
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const thread: WorkbenchThread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Synthetic Thread",
  status: "active",
  pinned: false,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  messages: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workbench API client lifecycle", () => {
  it("builds bounded project search requests and validates the page", async () => {
    const fetchMock = vi.fn(async () => Response.json({ projects: [project], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProjectsRequest({ status: "all", limit: 10, query: "Synthetic" }))
      .resolves.toEqual({ items: [project], nextCursor: null });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects?status=all&limit=10&q=Synthetic",
      { method: "GET", cache: "no-store" },
    );
  });

  it("lists lightweight thread summaries and reads full history separately", async () => {
    const { messages: _messages, ...threadWithoutMessages } = thread;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        threads: [{ ...threadWithoutMessages, messageCount: 0, lastMessageAt: null }],
        nextCursor: null,
      }))
      .mockResolvedValueOnce(Response.json({ thread }));
    vi.stubGlobal("fetch", fetchMock);

    const page = await listThreadsRequest({ projectId: PROJECT_ID, query: "Thread" });
    expect(page.items[0]).not.toHaveProperty("messages");
    await expect(getThreadRequest(THREAD_ID)).resolves.toEqual(thread);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/projects/${PROJECT_ID}/threads?q=Thread`,
    );
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/threads/${THREAD_ID}`);
  });

  it("exposes explicit archive helpers through the same strict PATCH contract", async () => {
    const archived = { ...project, status: "archived" as const };
    const fetchMock = vi.fn(async () => Response.json({ project: archived }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(archiveProjectRequest(PROJECT_ID)).resolves.toEqual(archived);
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
  });

  it("creates a validated branch through the dedicated endpoint", async () => {
    const branched = {
      ...thread,
      id: "44444444-4444-4444-8444-444444444444",
      lineage: { parentThreadId: THREAD_ID, branchedFromMessageId: THREAD_ID, kind: "edit" as const },
    };
    const fetchMock = vi.fn(async () => Response.json({ thread: branched, draftMessage: "Edited" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(branchThreadRequest(THREAD_ID, {
      kind: "edit", messageId: THREAD_ID, editedContent: "Edited",
    })).resolves.toEqual({ thread: branched, draftMessage: "Edited" });
    expect(fetchMock).toHaveBeenCalledWith(`/api/threads/${THREAD_ID}/branch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "edit", messageId: THREAD_ID, editedContent: "Edited" }),
    });
  });
});
