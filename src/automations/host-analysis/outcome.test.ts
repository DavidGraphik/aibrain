import { afterEach, describe, expect, it, vi } from "vitest";
import { hostWorkTimer, HOST_WORK_MS, HOST_TERMINAL_MS } from "./budget";
import { awaitHostTurn, hostFailure, HOST_INTERRUPT_GRACE_MS } from "./outcome";
afterEach(() => vi.useRealTimers());
describe("host cooperative terminal boundary", () => {
  it("closes a stuck runtime five seconds after the unchanged six-minute work deadline", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const timer = hostWorkTimer({ submittedAt: started, queueUntil: started + 90_000, workUntil: started + HOST_WORK_MS, terminalUntil: started + HOST_WORK_MS + HOST_TERMINAL_MS });
    let rejectLate!: (error: Error) => void;
    const run = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLate = reject; }));
    const result = awaitHostTurn(run, timer.signal);
    const failure = expect(result).rejects.toThrow("HOST_EXECUTION_TIMEOUT");
    await vi.advanceTimersByTimeAsync(HOST_WORK_MS - 1);
    expect(timer.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(timer.signal.reason.message).toBe("HOST_EXECUTION_TIMEOUT");
    await vi.advanceTimersByTimeAsync(HOST_INTERRUPT_GRACE_MS);
    await failure;
    expect(Date.now() - started).toBe(365_000);
    expect(HOST_TERMINAL_MS - HOST_INTERRUPT_GRACE_MS).toBe(10_000);
    rejectLate(Error("late RPC failure"));
    await vi.advanceTimersByTimeAsync(0);
    timer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("fails before dispatch when cancellation already won", async () => {
    const controller = new AbortController(); controller.abort(Error("HOST_REQUEST_DENIED"));
    const run = vi.fn(async () => {});
    await expect(awaitHostTurn(run, controller.signal)).rejects.toThrow("HOST_REQUEST_DENIED");
    expect(run).not.toHaveBeenCalled();
  });
  it("preserves a real policy rejection and gives timeout priority over a late runtime error", () => {
    const controller = new AbortController();
    expect(hostFailure(Error("HOST_ANALYSIS_READ_ONLY"), controller.signal).code).toBe("HOST_ANALYSIS_READ_ONLY");
    controller.abort(Error("HOST_EXECUTION_TIMEOUT"));
    expect(hostFailure(Error("AUTOMATION_NON_READ_ONLY_RESULT"), controller.signal).code).toBe("HOST_EXECUTION_TIMEOUT");
    expect(hostFailure(Error("provider failed"), new AbortController().signal)).toMatchObject({ code: "HOST_MODEL_ERROR", output: "provider failed" });
  });
});
