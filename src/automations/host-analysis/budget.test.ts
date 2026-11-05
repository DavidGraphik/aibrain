import { describe, expect, it, vi } from "vitest";
import { createHostBudget, admitHostBudget, hostWorkTimer, HOST_QUEUE_MS, HOST_TOTAL_MS, HOST_WORK_MS, HOST_TERMINAL_MS } from "./budget";
import { waitForHostAnalysis } from "./wait";
describe("E12 native original PDFs deadline regression", () => {
  it("allows a 50s queue followed by 350s of legitimate preparation/analysis", async () => {
    let clock = 0, cancelled = false;
    const expected = { result: "validated terminal result" };
    const store = {
      async result() { return clock >= 400_000 ? expected : null; },
      async cancel() { cancelled = true; },
      async waitDeadline() { return clock < 50_000 ? 90_000 : 425_000; },
      async expire() { return false; },
    };
    await expect(waitForHostAnalysis({ store, job: "email-event-router", requestId: "fixture", signal: new AbortController().signal,
      now: () => clock, sleep: async ms => { clock += ms; } })).resolves.toEqual(expected);
    expect(cancelled).toBe(false);
  });
});

describe("phase budget invariants", () => {
  it("returns the signed expiry classification to the host waiter after atomic cancellation", async () => {
    for (const reason of ["HOST_QUEUE_TIMEOUT", "HOST_TERMINAL_TIMEOUT"]) {
      let expired=false, checks=0;
      const store={result:async()=>null,cancel:vi.fn(),expire:async()=>{expired=true;return true;},
        waitDeadline:async()=>{checks++;if(expired)throw Error(reason);return 100;}};
      await expect(waitForHostAnalysis({store,job:"email-event-router",requestId:"fixture",signal:new AbortController().signal,now:()=>100})).rejects.toThrow(reason);
      expect(checks).toBe(2);expect(store.cancel).not.toHaveBeenCalled();
    }
  });
  it("caps queue, preparation+analysis and settlement without accepting a longer caller lease", () => {
    const b = createHostBudget(1000, 1_000_000_000);
    expect(b.queueUntil).toBe(1000 + HOST_QUEUE_MS);
    expect(b.terminalUntil).toBe(1000 + HOST_TOTAL_MS);
    const admitted = admitHostBudget(b, 51_000);
    expect(admitted.workUntil).toBe(51_000 + HOST_WORK_MS);
    expect(admitted.terminalUntil).toBe(51_000 + HOST_WORK_MS + HOST_TERMINAL_MS);
    expect(admitHostBudget(admitted, 100_000)).toBe(admitted);
  });
  it("shortens the admission window for the parent's remaining budget, rejecting insufficient time", () => {
    expect(createHostBudget(1000, 400_000).queueUntil).toBe(25_000);
    expect(() => createHostBudget(1000, 376_000)).toThrow("HOST_ADMISSION_BUDGET_EXHAUSTED");
    expect(() => admitHostBudget(createHostBudget(1000), 91_000)).toThrow("HOST_QUEUE_TIMEOUT");
  });
});

it("uses a cancellable monotonic work timer for the remaining absolute deadline", async () => {
  vi.useFakeTimers(); vi.setSystemTime(51_000);
  const budget = admitHostBudget(createHostBudget(1000), 51_000);
  const work = hostWorkTimer(budget);
  try {
    await vi.advanceTimersByTimeAsync(HOST_WORK_MS - 1);
    expect(work.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.signal.aborted).toBe(true);
    expect(work.signal.reason.message).toBe("HOST_EXECUTION_TIMEOUT");
    expect(() => hostWorkTimer(budget)).toThrow("HOST_EXECUTION_TIMEOUT");
  } finally { work.dispose(); vi.useRealTimers(); }
});
it("does not cancel on uncertain storage errors; explicit interruption cancels exactly one occurrence", async () => {
  let cancels = 0;
  const controller = new AbortController();
  const store = { async result() { throw Error("uncertain read"); }, async waitDeadline() { return 100; }, async expire() { return false; }, async cancel() { cancels++; } };
  await expect(waitForHostAnalysis({ store, job: "email-event-router", requestId: "same", signal: controller.signal })).rejects.toThrow("uncertain read");
  expect(cancels).toBe(0);
  controller.abort();
  await expect(waitForHostAnalysis({ store, job: "email-event-router", requestId: "same", signal: controller.signal })).rejects.toBeDefined();
  expect(cancels).toBe(1);
});
