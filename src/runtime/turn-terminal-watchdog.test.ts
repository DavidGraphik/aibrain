import { describe, expect, it, vi } from "vitest";
import { TurnTerminalWatchdog } from "@/runtime/turn-terminal-watchdog";

describe("TurnTerminalWatchdog", () => {
  it("waits for a long tool and restores idle protection after an error", async () => {
    vi.useFakeTimers();
    try {
      const watchdog = new TurnTerminalWatchdog(100, 1000);
      watchdog.start();
      let fail!: (error: Error) => void;
      const work = watchdog.duringToolCall(() => new Promise((_resolve, reject) => { fail = reject; }));
      const outcome = expect(work).rejects.toThrow("tool failed");
      let timedOut = false;
      void watchdog.timedOut.then(() => { timedOut = true; });
      await vi.advanceTimersByTimeAsync(400);
      watchdog.touch();
      expect(timedOut).toBe(false);
      fail(new Error("tool failed"));
      await outcome;
      await vi.advanceTimersByTimeAsync(100);
      await expect(watchdog.timedOut).resolves.toBe("idle");
    } finally { vi.useRealTimers(); }
  });

  it("still stops a stuck tool at the hard deadline", async () => {
    vi.useFakeTimers();
    try {
      const watchdog = new TurnTerminalWatchdog(100, 300);
      watchdog.start();
      let finish!: () => void;
      const work = watchdog.duringToolCall(() => new Promise<void>(resolve => { finish = resolve; }));
      await vi.advanceTimersByTimeAsync(300);
      await expect(watchdog.timedOut).resolves.toBe("hard");
      finish();
      await work;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("resets only the idle deadline when App Server makes progress", async () => {
    vi.useFakeTimers();
    try {
      const watchdog = new TurnTerminalWatchdog(100, 250);
      watchdog.start();
      await vi.advanceTimersByTimeAsync(80);
      watchdog.touch();
      await vi.advanceTimersByTimeAsync(80);
      let settled = false;
      void watchdog.timedOut.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      await expect(watchdog.timedOut).resolves.toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a hard deadline despite continuous progress", async () => {
    vi.useFakeTimers();
    try {
      const watchdog = new TurnTerminalWatchdog(100, 220);
      watchdog.start();
      await vi.advanceTimersByTimeAsync(80);
      watchdog.touch();
      await vi.advanceTimersByTimeAsync(80);
      watchdog.touch();
      await vi.advanceTimersByTimeAsync(60);
      await expect(watchdog.timedOut).resolves.toBe("hard");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expire while durable user input or approval is pending", async () => {
    vi.useFakeTimers();
    try {
      const watchdog = new TurnTerminalWatchdog(100, 200);
      watchdog.start();
      await vi.advanceTimersByTimeAsync(80);
      watchdog.pause();
      await vi.advanceTimersByTimeAsync(500);
      let settled = false;
      void watchdog.timedOut.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      watchdog.resume();
      await vi.advanceTimersByTimeAsync(100);
      await expect(watchdog.timedOut).resolves.toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});
