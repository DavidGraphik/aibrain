import { describe, expect, it } from "vitest";
import {
  MaintenanceCoordinator,
  MaintenanceDrainInterruptedError,
  MaintenanceDrainTimeoutError,
  MaintenanceModeError,
} from "@/operations/maintenance";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("MaintenanceCoordinator", () => {
  it("rejects new work while draining and enters maintenance only after all leases release", async () => {
    const coordinator = new MaintenanceCoordinator({
      now: () => Date.parse("2026-08-27T12:00:00.000Z"),
    });
    const turn = coordinator.acquire("turn");
    const workerStart = coordinator.acquire("worker-start");
    const drained = coordinator.enter({ timeoutMs: 1_000 });

    expect(coordinator.status()).toMatchObject({
      phase: "draining",
      activeActivities: 2,
      activeByKind: { turn: 1, "worker-start": 1 },
    });
    expect(() => coordinator.acquire("turn")).toThrowError(
      expect.objectContaining({
        code: "MAINTENANCE_ACTIVE",
        phase: "draining",
        retryable: true,
      } satisfies Partial<MaintenanceModeError>),
    );

    turn.release();
    expect(coordinator.status()).toMatchObject({ phase: "draining", activeActivities: 1 });
    workerStart.release();
    workerStart.release();

    await expect(drained).resolves.toMatchObject({
      schemaVersion: 1,
      phase: "maintenance",
      activeActivities: 0,
      activeByKind: { turn: 0, "worker-start": 0 },
    });
    expect(() => coordinator.acquire("worker-start")).toThrowError(
      expect.objectContaining({ phase: "maintenance" }),
    );
  });

  it("keeps admission closed after a drain timeout until an explicit resume", async () => {
    const coordinator = new MaintenanceCoordinator();
    const activity = coordinator.acquire("turn");

    await expect(coordinator.enter({ timeoutMs: 10 })).rejects.toEqual(
      expect.objectContaining({
        code: "MAINTENANCE_DRAIN_TIMEOUT",
        status: expect.objectContaining({ phase: "draining", activeActivities: 1 }),
      } satisfies Partial<MaintenanceDrainTimeoutError>),
    );
    expect(() => coordinator.acquire("turn")).toThrowError(MaintenanceModeError);

    expect(coordinator.resume()).toMatchObject({ phase: "accepting", activeActivities: 1 });
    const next = coordinator.acquire("turn");
    activity.release();
    next.release();
    await expect(coordinator.enter({ timeoutMs: 100 })).resolves.toMatchObject({
      phase: "maintenance",
      activeActivities: 0,
    });
  });

  it("interrupts concurrent drain waiters when an operator resumes", async () => {
    const coordinator = new MaintenanceCoordinator();
    const lease = coordinator.acquire("turn");
    const waiting = coordinator.enter({ timeoutMs: 1_000 });
    const waiterAttached = deferred();
    queueMicrotask(waiterAttached.resolve);
    await waiterAttached.promise;

    coordinator.resume();
    await expect(waiting).rejects.toBeInstanceOf(MaintenanceDrainInterruptedError);
    expect(coordinator.status().phase).toBe("accepting");
    lease.release();
  });

  it("rejects invalid timeouts and forged or released leases", async () => {
    const coordinator = new MaintenanceCoordinator({ maximumDrainTimeoutMs: 100 });
    await expect(coordinator.enter({ timeoutMs: 101 })).rejects.toThrow("timeoutMs must be an integer");
    expect(() => coordinator.assertActiveLease(undefined)).toThrowError(MaintenanceModeError);
    const lease = coordinator.acquire("turn");
    expect(coordinator.isActiveLease(lease)).toBe(true);
    lease.release();
    expect(coordinator.isActiveLease(lease)).toBe(false);
    expect(() => coordinator.assertActiveLease(lease)).toThrowError(MaintenanceModeError);
  });
});
