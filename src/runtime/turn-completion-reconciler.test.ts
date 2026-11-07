import { afterEach, expect, it, vi } from "vitest";
import { TurnCompletionReconciler } from "./turn-completion-reconciler";

afterEach(() => vi.useRealTimers());

it("does not overlap observations and stops after publishing completion", async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  const observe = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  const reconciler = new TurnCompletionReconciler(observe);
  reconciler.start();
  reconciler.start();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(observe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(observe).toHaveBeenCalledTimes(1);
  reconciler.stop();
  resolve();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(observe).toHaveBeenCalledTimes(1);
});

it("retries an unavailable observation without declaring the turn failed", async () => {
  vi.useFakeTimers();
  const observe = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValue(undefined);
  const reconciler = new TurnCompletionReconciler(observe);
  reconciler.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(observe).toHaveBeenCalledTimes(2);
  reconciler.stop();
});
