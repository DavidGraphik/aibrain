import { randomUUID } from "node:crypto";

export type MaintenancePhase = "accepting" | "draining" | "maintenance";
export type MaintenanceActivityKind = "turn" | "worker-start";

export type MaintenanceStatus = Readonly<{
  schemaVersion: 1;
  phase: MaintenancePhase;
  generation: number;
  transitionedAt: string;
  activeActivities: number;
  activeByKind: Readonly<Record<MaintenanceActivityKind, number> & { automation?: number }>;
}>;

export type MaintenanceActivityLease = Readonly<{
  activityId: string;
  kind: MaintenanceActivityKind;
  acquiredAt: string;
  release(): void;
}>;

export type MaintenanceCoordinatorOptions = Readonly<{
  now?: () => number;
  retryAfterMs?: number;
  maximumDrainTimeoutMs?: number;
}>;

export type EnterMaintenanceOptions = Readonly<{
  timeoutMs: number;
}>;

type ActiveActivity = Readonly<{
  lease: MaintenanceActivityLease;
  kind: MaintenanceActivityKind;
}>;

type DrainWaiter = Readonly<{
  resolve(status: MaintenanceStatus): void;
  reject(error: Error): void;
}>;

const DEFAULT_RETRY_AFTER_MS = 1_000;
const DEFAULT_MAXIMUM_DRAIN_TIMEOUT_MS = 10 * 60_000;

function positiveInteger(name: string, value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

export class MaintenanceModeError extends Error {
  readonly code = "MAINTENANCE_ACTIVE";
  readonly retryable = true;

  constructor(
    readonly phase: Exclude<MaintenancePhase, "accepting">,
    readonly retryAfterMs: number,
  ) {
    super("The installation is draining or in maintenance; retry later.");
    this.name = "MaintenanceModeError";
  }
}

export class MaintenanceDrainTimeoutError extends Error {
  readonly code = "MAINTENANCE_DRAIN_TIMEOUT";
  readonly retryable = true;

  constructor(readonly status: MaintenanceStatus) {
    super("Maintenance drain timed out before all active work completed.");
    this.name = "MaintenanceDrainTimeoutError";
  }
}

export class MaintenanceDrainInterruptedError extends Error {
  readonly code = "MAINTENANCE_DRAIN_INTERRUPTED";
  readonly retryable = true;

  constructor() {
    super("Maintenance drain was explicitly resumed before it completed.");
    this.name = "MaintenanceDrainInterruptedError";
  }
}

/**
 * Process-local admission gate for one installation. A caller must retain its
 * lease for the complete mutation/turn. Once draining starts no new lease is
 * admitted; maintenance is reached only after every prior lease is released.
 */
export class MaintenanceCoordinator {
  private readonly now: () => number;
  private readonly retryAfterMs: number;
  private readonly maximumDrainTimeoutMs: number;
  private readonly activities = new Map<string, ActiveActivity>();
  private readonly drainWaiters = new Set<DrainWaiter>();
  private phase: MaintenancePhase = "accepting";
  private generation = 1;
  private transitionedAt: string;

  constructor(options: MaintenanceCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retryAfterMs = positiveInteger(
      "retryAfterMs",
      options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
      60_000,
    );
    this.maximumDrainTimeoutMs = positiveInteger(
      "maximumDrainTimeoutMs",
      options.maximumDrainTimeoutMs ?? DEFAULT_MAXIMUM_DRAIN_TIMEOUT_MS,
      60 * 60_000,
    );
    this.transitionedAt = this.timestamp();
  }

  acquire(kind: MaintenanceActivityKind): MaintenanceActivityLease {
    if (kind !== "turn" && kind !== "worker-start") {
      throw new Error("Maintenance activity kind is invalid.");
    }
    if (this.phase !== "accepting") {
      throw new MaintenanceModeError(this.phase, this.retryAfterMs);
    }
    const activityId = randomUUID();
    let released = false;
    const lease = Object.freeze({
      activityId,
      kind,
      acquiredAt: this.timestamp(),
      release: () => {
        if (released) return;
        released = true;
        const active = this.activities.get(activityId);
        if (active?.lease === lease) this.activities.delete(activityId);
        this.completeDrainIfIdle();
      },
    }) satisfies MaintenanceActivityLease;
    this.activities.set(activityId, Object.freeze({ lease, kind }));
    return lease;
  }

  isActiveLease(lease: MaintenanceActivityLease | null | undefined) {
    if (!lease) return false;
    return this.activities.get(lease.activityId)?.lease === lease;
  }

  assertActiveLease(lease: MaintenanceActivityLease | null | undefined) {
    if (!this.isActiveLease(lease)) {
      throw new MaintenanceModeError(
        this.phase === "accepting" ? "draining" : this.phase,
        this.retryAfterMs,
      );
    }
  }

  status(): MaintenanceStatus {
    let turns = 0;
    let workerStarts = 0;
    for (const activity of this.activities.values()) {
      if (activity.kind === "turn") turns += 1;
      else workerStarts += 1;
    }
    return Object.freeze({
      schemaVersion: 1,
      phase: this.phase,
      generation: this.generation,
      transitionedAt: this.transitionedAt,
      activeActivities: this.activities.size,
      activeByKind: Object.freeze({ turn: turns, "worker-start": workerStarts }),
    });
  }

  async enter(options: EnterMaintenanceOptions): Promise<MaintenanceStatus> {
    const timeoutMs = positiveInteger("timeoutMs", options.timeoutMs, this.maximumDrainTimeoutMs);
    if (this.phase === "maintenance") return this.status();
    if (this.phase === "accepting") this.transition("draining");
    this.completeDrainIfIdle();
    const current = this.status();
    if (current.phase === "maintenance") return current;

    return new Promise<MaintenanceStatus>((resolve, reject) => {
      let settled = false;
      const waiter: DrainWaiter = Object.freeze({
        resolve: (status) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.drainWaiters.delete(waiter);
          resolve(status);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.drainWaiters.delete(waiter);
          reject(error);
        },
      });
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.drainWaiters.delete(waiter);
        reject(new MaintenanceDrainTimeoutError(this.status()));
      }, timeoutMs);
      this.drainWaiters.add(waiter);
    });
  }

  resume(): MaintenanceStatus {
    if (this.phase === "accepting") return this.status();
    this.transition("accepting");
    const error = new MaintenanceDrainInterruptedError();
    for (const waiter of [...this.drainWaiters]) waiter.reject(error);
    return this.status();
  }

  private completeDrainIfIdle() {
    if (this.phase !== "draining" || this.activities.size !== 0) return;
    this.transition("maintenance");
    const status = this.status();
    for (const waiter of [...this.drainWaiters]) waiter.resolve(status);
  }

  private transition(phase: MaintenancePhase) {
    if (phase === this.phase) return;
    this.phase = phase;
    this.generation += 1;
    this.transitionedAt = this.timestamp();
  }

  private timestamp() {
    return new Date(this.now()).toISOString();
  }
}
