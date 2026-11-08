// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStoredResponse } from "@/ui/use-stored-response";
import type { WorkbenchThread } from "@/workbench/types";
const thread: WorkbenchThread = {
  id: "018f5f68-4a6e-7abc-8def-0123456789ab", projectId: "018f5f68-4a6e-7abc-8def-0123456789ac",
  title: "Saved", status: "active", pinned: false, createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
  messages: [{ id: "018f5f68-4a6e-7abc-8def-0123456789ad", role: "assistant", content: "Partial", status: "streaming", createdAt: "2026-09-08T00:00:00.000Z", activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [] }],
};
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("stored response reconciliation", () => {
  it("keeps reading a healthy background result after a minute, without starting another turn", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_input: string, _init: RequestInit) => Response.json({ thread }));
    vi.stubGlobal("fetch", fetcher);
    const onSnapshot = vi.fn();
    const { result } = renderHook(() => useStoredResponse({ thread, enabled: true, attached: false,
      online: true, retry: 0, onSnapshot, readOnly: true }));
    await act(() => vi.advanceTimersByTimeAsync(540_000));
    expect(result.current).toBe("checking");
    const finished = { ...thread.messages[0], content: "Scheduled result", status: "complete" as const };
    fetcher.mockImplementation(async () => Response.json({ thread: { ...thread, messages: [finished] } }));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(onSnapshot).toHaveBeenLastCalledWith(thread.id, finished);
    expect(fetcher.mock.calls.every((call) => call.length === 2)).toBe(true);
  });
  it("recovers a terminal response after reload using reads only", async () => {
    const finished = { ...thread.messages[0], content: "Durable result", status: "complete" as const };
    const fetcher = vi.fn(async () => Response.json({ thread: { ...thread, messages: [finished] } }));
    vi.stubGlobal("fetch", fetcher);
    const onSnapshot = vi.fn();
    renderHook(() => useStoredResponse({ thread, enabled: true, attached: false, online: true, retry: 0, onSnapshot }));
    await act(async () => { await Promise.resolve(); });
    expect(onSnapshot).toHaveBeenCalledWith(thread.id, finished);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([`/api/threads/${thread.id}`, expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })]);
  });
  it.each([false, true])("never fabricates a failed turn and stops reading after a minute of outages (readOnly=%s)", async (readOnly) => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", fetcher);
    const onSnapshot = vi.fn();
    const { result } = renderHook(() => useStoredResponse({ thread, enabled: true, attached: false, online: true, retry: 0, onSnapshot, readOnly }));
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(result.current).toBe("paused");
    const reads = fetcher.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(fetcher).toHaveBeenCalledTimes(reads);
    expect(onSnapshot).not.toHaveBeenCalled();
  });
  it("rejects a snapshot of another conversation and stops on lost authorization", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => Response.json({ thread: { ...thread, id: "018f5f68-4a6e-7abc-8def-0123456789ae" } }));
    vi.stubGlobal("fetch", fetcher);
    const onSnapshot = vi.fn();
    const { result } = renderHook(() => useStoredResponse({ thread, enabled: true, attached: false, online: true, retry: 0, onSnapshot }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(onSnapshot).not.toHaveBeenCalled();
    fetcher.mockImplementation(async () => new Response(null, { status: 403 }));
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(result.current).toBe("paused");
    expect(onSnapshot).not.toHaveBeenCalled();
  });
});
