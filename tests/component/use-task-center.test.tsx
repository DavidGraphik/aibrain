// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskCenter } from "@/components/use-task-center";
import type { TaskCenterPayload } from "@/task-center/contracts";

const payload = (inApp = true): TaskCenterPayload => ({
  tasks: [], readTaskIds: [], preferences: { inApp, desktop: false }, continuity: "worker_required",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function options(): Parameters<typeof useTaskCenter>[0] {
  return {
    hydrated: false, persistence: "filesystem", projects: [], threads: [], cacheKey: "own-task-cache",
    productName: "Example", selection: { current: { threadId: null } }, open: false,
    requestOpen: vi.fn(), onNotice: vi.fn(),
  };
}
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { localStorage.clear(); fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("task-center synchronization", () => {
  it.each(["QuotaExceededError", "SecurityError"])("keeps preview tasks usable when cache writes fail (%s)", errorName => {
    const cacheWrite = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Synthetic unavailable browser cache", errorName);
    });
    const input = { ...options(), hydrated: true, persistence: "browser-preview" as const };
    const { result, rerender } = renderHook(() => useTaskCenter(input));
    expect(result.current.payload).toEqual(payload());
    expect(result.current.items).toEqual([]);
    rerender();
    expect(result.current.busy).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cacheWrite).toHaveBeenCalledWith("own-task-cache", expect.any(String));
  });

  it("stays busy until every mutation settles and retains the newest committed response", async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    fetcher.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useTaskCenter(options()));
    let firstMutation!: Promise<void>, secondMutation!: Promise<void>;
    act(() => {
      firstMutation = result.current.mutate({ action: "mark_read", taskIds: [] });
      secondMutation = result.current.mutate({ action: "preferences", preferences: payload(false).preferences });
    });
    expect(result.current.busy).toBe(true);
    await act(async () => { second.resolve(Response.json(payload(false))); await secondMutation; });
    expect(result.current.busy).toBe(true);
    expect(result.current.payload.preferences.inApp).toBe(false);
    await act(async () => { first.resolve(Response.json(payload(true))); await firstMutation; });
    expect(result.current.busy).toBe(false);
    expect(result.current.payload.preferences.inApp).toBe(false);
  });

  it("does not overwrite a saved change with an older poll response", async () => {
    const poll = deferred<Response>(), mutation = deferred<Response>();
    fetcher.mockReturnValueOnce(poll.promise).mockReturnValueOnce(mutation.promise);
    const input = { ...options(), hydrated: true };
    const { result } = renderHook(() => useTaskCenter(input));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    let pending!: Promise<void>;
    act(() => { pending = result.current.mutate({ action: "preferences", preferences: payload(false).preferences }); });
    await act(async () => { mutation.resolve(Response.json(payload(false))); await pending; });
    await act(async () => { poll.resolve(Response.json(payload(true))); });
    expect(result.current.payload.preferences.inApp).toBe(false);
    expect(input.onNotice).not.toHaveBeenCalled();
  });

  it("rejects malformed responses, reports the failure and permits the next mutation", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ tasks: [], unexpected: true })).mockResolvedValueOnce(Response.json(payload(false)));
    const input = options();
    const { result } = renderHook(() => useTaskCenter(input));
    await act(async () => { await result.current.mutate({ action: "mark_read", taskIds: [] }); });
    expect(result.current.busy).toBe(false);
    expect(input.onNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
    expect(result.current.payload).toEqual(payload());
    await act(async () => { await result.current.mutate({ action: "preferences", preferences: payload(false).preferences }); });
    expect(result.current.payload).toEqual(payload(false));
    expect(result.current.busy).toBe(false);
  });

  it.each(["{broken", JSON.stringify({ tasks: "invalid" })])("recovers from a damaged preview cache (%s)", async value => {
    localStorage.setItem("own-task-cache", value);
    const { result } = renderHook(() => useTaskCenter(options()));
    act(() => result.current.restorePreview());
    expect(result.current.payload).toEqual(payload());
    expect(fetcher).not.toHaveBeenCalled();
    localStorage.setItem("own-task-cache", JSON.stringify(payload(false)));
    act(() => result.current.restorePreview());
    expect(result.current.payload).toEqual(payload(false));
  });
});
