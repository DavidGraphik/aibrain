import { availableParallelism } from "node:os";
import type { InstallationConfig } from "@/config/installation-schema";
import {
  MaintenanceCoordinator,
  type MaintenanceActivityLease,
} from "@/operations/maintenance";
import type { AppServerTransport } from "@/runtime/transport";
import {
  buildWorkerLaunchContext,
  validateWorkerUserId,
  WorkerProvisioner,
} from "@/runtime/workers/provisioner";
import type {
  ManagedWorkerRuntime,
  WorkerControllerHealth,
  WorkerProvisioningManifest,
  WorkerRegistryState,
  WorkerRuntimeFactory,
  WorkerRuntimeHandle,
  WorkerRuntimeHealth,
} from "@/runtime/workers/types";

export class WorkerRegistryBackpressureError extends Error {
  readonly code = "WORKER_START_BACKPRESSURE";
  readonly retryable = true;

  constructor(readonly retryAfterMs: number) {
    super("Worker start capacity is saturated; retry later.");
    this.name = "WorkerRegistryBackpressureError";
  }
}

type GateWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
};

class StartGate {
  private active = 0;
  private readonly waiters: GateWaiter[] = [];
  private closed = false;

  constructor(
    private readonly concurrency: number,
    private readonly maxPending: number,
    private readonly retryAfterMs: number,
  ) {}

  acquire() {
    if (this.closed) return Promise.reject(new Error("Worker registry is closed."));
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    if (this.waiters.length >= this.maxPending) {
      return Promise.reject(new WorkerRegistryBackpressureError(this.retryAfterMs));
    }
    return new Promise<() => void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Worker registry is closed.");
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private releaseFunction() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.resolve(this.releaseFunction());
      else this.active -= 1;
    };
  }
}

type RegistryEntry = {
  readonly userId: string;
  state: Exclude<WorkerRegistryState, "absent">;
  manifest: WorkerProvisioningManifest | null;
  runtime: ManagedWorkerRuntime | null;
  handle: WorkerRuntimeHandle | null;
  startPromise: Promise<WorkerRuntimeHandle> | null;
  stopPromise: Promise<boolean> | null;
  lastError: string | null;
};

export type WorkerRuntimeRegistryOptions = {
  config: Readonly<InstallationConfig>;
  factory: WorkerRuntimeFactory;
  provisioner?: WorkerProvisioner;
  maxConcurrentStarts?: number;
  maxPendingStarts?: number;
  backpressureRetryAfterMs?: number;
  workerConnectTimeoutMs?: number;
  maintenance?: MaintenanceCoordinator;
  onLifecycleMetric?: (metric: WorkerLifecycleMetric) => void;
};

export type WorkerLifecycleMetric = Readonly<{
  userId: string;
  phase: "queue" | "provision" | "gateway_start" | "transport_connect";
  outcome: "completed" | "error";
  durationMs: number;
}>;

function positiveInteger(name: string, value: number, allowZero = false) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`${name} must be ${allowZero ? "non-negative" : "positive"}.`);
  }
  return value;
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Worker runtime failed.";
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(token|secret|password)=\S+/giu, "$1=[REDACTED]");
}

function waitForWorkerConnection<T>(operation: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Worker transport did not connect in time.")),
      timeoutMs,
    );
    timeout.unref?.();
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function createEntry(userId: string): RegistryEntry {
  return {
    userId,
    state: "stopped",
    manifest: null,
    runtime: null,
    handle: null,
    startPromise: null,
    stopPromise: null,
    lastError: null,
  };
}

function frozenHandle(
  installationId: string,
  manifest: WorkerProvisioningManifest,
  transport: AppServerTransport,
): WorkerRuntimeHandle {
  return Object.freeze({
    installationId,
    userId: manifest.userId,
    workerId: manifest.workerId,
    roots: Object.freeze({ ...manifest.roots }),
    transport,
  });
}

/**
 * Process-local registry for one installation. Every entry owns a distinct
 * controller and transport. Durable roots and transport journals make a new
 * registry instance safe after a Node restart; this class is not a database.
 */
export class WorkerRuntimeRegistry {
  readonly config: Readonly<InstallationConfig>;
  readonly provisioner: WorkerProvisioner;
  private readonly factory: WorkerRuntimeFactory;
  private readonly starts: StartGate;
  private readonly workerConnectTimeoutMs: number;
  private readonly maintenance: MaintenanceCoordinator | null;
  private readonly onLifecycleMetric?: WorkerRuntimeRegistryOptions["onLifecycleMetric"];
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly runtimeOwners = new WeakMap<object, string>();
  private readonly transportOwners = new WeakMap<object, string>();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: WorkerRuntimeRegistryOptions) {
    this.config = options.config;
    this.factory = options.factory;
    this.maintenance = options.maintenance ?? null;
    this.onLifecycleMetric = options.onLifecycleMetric;
    this.provisioner = options.provisioner ?? new WorkerProvisioner({ config: options.config });
    const maxConcurrentStarts = positiveInteger(
      "maxConcurrentStarts",
      options.maxConcurrentStarts ?? Math.max(1, Math.min(4, availableParallelism())),
    );
    const maxPendingStarts = positiveInteger(
      "maxPendingStarts",
      options.maxPendingStarts ?? 256,
      true,
    );
    const retryAfterMs = positiveInteger(
      "backpressureRetryAfterMs",
      options.backpressureRetryAfterMs ?? 1_000,
    );
    this.workerConnectTimeoutMs = positiveInteger(
      "workerConnectTimeoutMs",
      options.workerConnectTimeoutMs ?? 10_000,
    );
    this.starts = new StartGate(maxConcurrentStarts, maxPendingStarts, retryAfterMs);
  }

  async start(
    userId: string,
    activityLease?: MaintenanceActivityLease,
  ): Promise<WorkerRuntimeHandle> {
    validateWorkerUserId(userId);
    if (this.closed) throw new Error("Worker registry is closed.");
    if (activityLease && !this.maintenance) {
      throw new Error("Worker registry does not own the supplied maintenance lease.");
    }
    if (activityLease) this.maintenance!.assertActiveLease(activityLease);
    let entry = this.entries.get(userId);
    if (!entry) {
      entry = createEntry(userId);
      this.entries.set(userId, entry);
    }
    if (entry.stopPromise) {
      await entry.stopPromise;
      return this.start(userId, activityLease);
    }
    if (entry.startPromise) return entry.startPromise;
    if ((entry.state === "running" || entry.state === "degraded") && entry.handle) {
      const reusePromise = this.reuseOrRecover(entry, activityLease);
      entry.startPromise = reusePromise;
      void reusePromise.finally(() => {
        if (entry.startPromise === reusePromise) entry.startPromise = null;
      }).catch(() => undefined);
      return reusePromise;
    }
    if (entry.runtime) throw new Error("Previous worker cleanup must complete before restart.");

    const startLease = activityLease
      ? null
      : this.maintenance?.acquire("worker-start") ?? null;

    entry.state = "starting";
    entry.lastError = null;
    const startPromise = this.startEntry(entry);
    entry.startPromise = startPromise;
    void startPromise.finally(() => {
      if (entry?.startPromise === startPromise) entry.startPromise = null;
      startLease?.release();
    }).catch(() => undefined);
    return startPromise;
  }

  get(userId: string): WorkerRuntimeHandle | null {
    validateWorkerUserId(userId);
    const entry = this.entries.get(userId);
    return entry && (entry.state === "running" || entry.state === "degraded")
      ? entry.handle
      : null;
  }

  async health(userId: string): Promise<WorkerRuntimeHealth> {
    validateWorkerUserId(userId);
    const entry = this.entries.get(userId);
    if (!entry) return this.emptyHealth(userId);
    if (!entry.runtime || !entry.manifest) {
      return {
        installationId: this.config.installationId,
        userId,
        workerId: entry.manifest?.workerId ?? null,
        state: entry.state,
        healthy: false,
        controller: null,
        transport: null,
        lastError: entry.lastError,
      };
    }

    let controller: WorkerControllerHealth | null = null;
    let transport = null;
    try {
      [controller, transport] = await Promise.all([
        entry.runtime.health(),
        entry.runtime.transport.health(),
      ]);
      const healthy = controller.healthy && transport.healthy;
      if (entry.state === "running" || entry.state === "degraded") {
        entry.state = healthy ? "running" : "degraded";
      }
      return {
        installationId: this.config.installationId,
        userId,
        workerId: entry.manifest.workerId,
        state: entry.state,
        healthy,
        controller,
        transport,
        lastError: entry.lastError,
      };
    } catch (error) {
      entry.lastError = safeError(error);
      if (entry.state === "running") entry.state = "degraded";
      return {
        installationId: this.config.installationId,
        userId,
        workerId: entry.manifest.workerId,
        state: entry.state,
        healthy: false,
        controller,
        transport,
        lastError: entry.lastError,
      };
    }
  }

  async stop(userId: string) {
    validateWorkerUserId(userId);
    const entry = this.entries.get(userId);
    if (!entry) return false;
    if (entry.stopPromise) return entry.stopPromise;
    const stopPromise = this.stopEntry(entry);
    entry.stopPromise = stopPromise;
    void stopPromise.finally(() => {
      if (entry.stopPromise === stopPromise) entry.stopPromise = null;
    }).catch(() => undefined);
    return stopPromise;
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.starts.close();
    this.closePromise = (async () => {
      const results = await Promise.allSettled([...this.entries.keys()].map((userId) => this.stop(userId)));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    })().finally(() => { this.closePromise = null; });
    return this.closePromise;
  }

  private async reuseOrRecover(
    entry: RegistryEntry,
    activityLease?: MaintenanceActivityLease,
  ): Promise<WorkerRuntimeHandle> {
    const runtime = entry.runtime;
    const handle = entry.handle;
    if (!runtime || !handle) throw new Error("Worker runtime ownership is unavailable.");
    let health: WorkerControllerHealth;
    try {
      health = await runtime.health();
    } catch (error) {
      entry.lastError = safeError(error);
      entry.state = "degraded";
      throw new Error("Worker controller health could not be confirmed.");
    }
    // Transport reconnects and transient degraded health do not establish that
    // the process generation is dead. Never replace an otherwise active worker.
    if (health.healthy || !["failed", "stopped"].includes(health.state)) return handle;
    if (this.closed || entry.stopPromise) throw new Error("Worker recovery was cancelled.");
    const recoveryLease = activityLease
      ? null
      : this.maintenance?.acquire("worker-start") ?? null;
    try {
      if (activityLease) this.maintenance!.assertActiveLease(activityLease);
      entry.state = "stopping";
      const cleanup = await Promise.allSettled([runtime.transport.close(), runtime.stop()]);
      entry.handle = null;
      const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) {
        entry.state = "failed";
        entry.lastError = safeError(failure.reason);
        throw failure.reason;
      }
      entry.runtime = null;
      entry.state = "stopped";
      // A concurrent stop/close waits for this promise. Do not create a new
      // generation after that caller has fenced the employee's lifecycle.
      if (this.closed || entry.stopPromise) throw new Error("Worker recovery was cancelled.");
      entry.state = "starting";
      entry.lastError = null;
      return await this.startEntry(entry);
    } finally {
      recoveryLease?.release();
    }
  }

  private async startEntry(entry: RegistryEntry) {
    let runtime: ManagedWorkerRuntime | null = null;
    let release: (() => void) | null = null;
    try {
      release = await this.measure(entry.userId, "queue", () => this.starts.acquire());
      if (this.closed) throw new Error("Worker registry is closed.");
      entry.manifest = await this.measure(entry.userId, "provision", () => this.provisioner.provision(entry.userId));
      const context = buildWorkerLaunchContext(this.config, entry.manifest);
      if (this.closed) throw new Error("Worker registry is closed.");
      runtime = await this.factory.create(context);
      this.assertExclusiveRuntime(entry.userId, runtime);
      entry.runtime = runtime;
      const owned = runtime;
      await this.measure(entry.userId, "gateway_start", () => waitForWorkerConnection(owned.start(), this.workerConnectTimeoutMs));
      await this.measure(entry.userId, "transport_connect", () => waitForWorkerConnection(owned.transport.connect(), this.workerConnectTimeoutMs));
      entry.handle = frozenHandle(this.config.installationId, entry.manifest, runtime.transport);
      entry.state = "running";
      return entry.handle;
    } catch (error) {
      entry.lastError = safeError(error);
      entry.state = "failed";
      entry.handle = null;
      // A rejected factory object may belong to another employee. Cleanup
      // only starts after this entry has acquired exclusive ownership.
      if (runtime && entry.runtime === runtime) {
        const cleanup = await Promise.allSettled([
          runtime.transport.close(),
          runtime.stop(),
        ]);
        if (cleanup.every((result) => result.status === "fulfilled")) entry.runtime = null;
      }
      throw error;
    } finally {
      release?.();
    }
  }

  private assertExclusiveRuntime(userId: string, runtime: ManagedWorkerRuntime) {
    if (!runtime || typeof runtime !== "object" || !runtime.transport || typeof runtime.transport !== "object") {
      throw new Error("Worker factory returned an invalid runtime.");
    }
    const runtimeOwner = this.runtimeOwners.get(runtime);
    const transportOwner = this.transportOwners.get(runtime.transport);
    if (runtimeOwner || transportOwner) {
      throw new Error("Worker factory reused a runtime or transport instance.");
    }
    this.runtimeOwners.set(runtime, userId);
    this.transportOwners.set(runtime.transport, userId);
  }

  private async measure<T>(userId: string, phase: WorkerLifecycleMetric["phase"], operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let outcome: WorkerLifecycleMetric["outcome"] = "error";
    try {
      const result = await operation();
      outcome = "completed";
      return result;
    } finally {
      // Diagnostics must never turn an acquired slot into a leaked slot.
      try { this.onLifecycleMetric?.({ userId, phase, outcome, durationMs: performance.now() - started }); } catch { /* observer only */ }
    }
  }

  private async stopEntry(entry: RegistryEntry) {
    if (entry.startPromise) await entry.startPromise.catch(() => undefined);
    const runtime = entry.runtime;
    if (!runtime) {
      entry.state = "stopped";
      entry.handle = null;
      return false;
    }
    entry.state = "stopping";
    const results = await Promise.allSettled([
      runtime.transport.close(),
      runtime.stop(),
    ]);
    entry.handle = null;
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      entry.state = "failed";
      entry.lastError = safeError(failure.reason);
      throw failure.reason;
    }
    entry.runtime = null;
    entry.state = "stopped";
    entry.lastError = null;
    return true;
  }

  private emptyHealth(userId: string): WorkerRuntimeHealth {
    return {
      installationId: this.config.installationId,
      userId,
      workerId: null,
      state: "absent",
      healthy: false,
      controller: null,
      transport: null,
      lastError: null,
    };
  }
}
