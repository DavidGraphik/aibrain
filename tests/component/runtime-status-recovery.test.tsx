// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStatus } from "@/ui/use-runtime-status";
import { initialRuntimeStatus } from "@/lib/runtime-status";

const ready = { ...initialRuntimeStatus, codex: "connected" as const, ready: true };
beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("runtime availability recovery", () => {
  it("ends checking at the deadline and retries foreground observations with bounded backoff", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const observations: { elapsed: number; signal: AbortSignal }[] = [];
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      observations.push({ elapsed: Date.now() - startedAt, signal: init.signal as AbortSignal });
      return new Promise<Response>(() => undefined); // Even abort-ignoring requests cannot block recovery.
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useRuntimeStatus({ hydrated: true, online: true, projectId: "a", retry: 0 }));
    expect(result.current.codex).toBe("checking");
    await act(() => vi.advanceTimersByTimeAsync(39_999));
    expect(result.current.codex).toBe("checking");
    expect(observations[0].signal.aborted).toBe(false);

    for (const backoff of [2_000, 4_000, 30_000, 60_000, 120_000, 120_000]) {
      const count = fetcher.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(count === 1 ? 1 : 40_000));
      expect(result.current).toMatchObject({ codex: "unavailable", ready: false });
      expect(observations.every(probe => probe.signal.aborted)).toBe(true);
      await act(() => vi.advanceTimersByTimeAsync(backoff - 1));
      expect(fetcher).toHaveBeenCalledTimes(count);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(fetcher).toHaveBeenCalledTimes(count + 1);
      expect(result.current).toMatchObject({ codex: "unavailable", ready: false });
      expect(observations.filter(probe => !probe.signal.aborted)).toHaveLength(1);
      act(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
      expect(fetcher).toHaveBeenCalledTimes(count + 1);
    }
    expect(observations.map(probe => probe.elapsed)).toEqual([0, 42_000, 86_000, 156_000, 256_000, 416_000, 576_000]);
    expect(fetcher.mock.calls.every(([url, init]) => url === "/api/runtime/status?projectId=a" && init.cache === "no-store")).toBe(true);
  });
  it("does not show checking again during a background retry and allows manual recovery", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender } = renderHook(({ retry }) => useRuntimeStatus({ hydrated: true, online: true, projectId: "a", retry }), { initialProps: { retry: 0 } });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.codex).toBe("unavailable");
    fetcher.mockImplementation(async () => Response.json(ready));
    rerender({ retry: 1 });
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.ready).toBe(true);
    const recoveredRequests = fetcher.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(fetcher).toHaveBeenCalledTimes(recoveredRequests);
  });
  it("pauses observations while hidden or offline and resumes only when both permit it", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender } = renderHook(({ online }) => useRuntimeStatus({ hydrated: true, online, projectId: "a", retry: 0 }), { initialProps: { online: true } });
    await act(async () => {});
    act(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ codex: "unavailable", ready: false });
    rerender({ online: false });
    act(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ codex: "unavailable", ready: false });
    fetcher.mockImplementation(async () => Response.json(ready));
    rerender({ online: true });
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.ready).toBe(true);
  });
  it("focus resets a pending backoff once without overlapping requests or starting a task", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const fetcher = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response("unavailable", { status: 503 })));
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useRuntimeStatus({ hydrated: true, online: true, projectId: "a", retry: 0 }));
    await act(() => vi.advanceTimersByTimeAsync(6_001));
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
    act(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.current).toMatchObject({ codex: "unavailable", ready: false });
    await act(async () => { release(Response.json(ready)); });
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(result.current.ready).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([url]) => url === "/api/runtime/status?projectId=a")).toBe(true);
  });
  it("ignores a late response from a previously selected project", async () => {
    let releaseOld!: (response: Response) => void;
    const fetcher = vi.fn((url: string) => url.includes("projectId=a")
      ? new Promise<Response>(resolve => { releaseOld = resolve; }) : Promise.resolve(Response.json(ready)));
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender } = renderHook(({ projectId }) => useRuntimeStatus({ hydrated: true, online: true, projectId, retry: 0 }), { initialProps: { projectId: "a" } });
    rerender({ projectId: "b" });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.ready).toBe(true);
    await act(async () => { releaseOld(Response.json({ ...ready, codex: "unavailable", ready: false })); });
    expect(result.current.ready).toBe(true);
  });
});
