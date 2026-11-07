import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { hostname } from "node:os";
import { mkdir, readFile, readlink, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, fsyncDirectory } from "@/storage/atomic-file";
import { readProcessIncarnation } from "@/storage/process-incarnation";
import {
  ResourceLockOwnershipLostError,
  ResourceLockTimeoutError,
  StorageError,
} from "@/storage/errors";
import {
  defineVersionedSchema,
  expectInteger,
  expectIsoDate,
  expectString,
  parseJson,
} from "@/storage/schema";

type ResourceLockMetadata = {
  schemaVersion: 1;
  token: string;
  resourceHash: string;
  processId: number;
  hostname: string;
  acquiredAt: string;
};

// A restarted container can reuse both its hostname and PID. Keep the v1
// owner format compatible with running older callers and bind an optional
// sidecar to the exact owner token instead of treating PID liveness as identity.
const processStartedAt = Date.now() - process.uptime() * 1_000;
async function processIdentity(processId: number) {
  if (process.platform !== "linux") return null;
  try {
    const value = await readFile(`/proc/${processId}/stat`, "utf8");
    const startTicks = value.slice(value.lastIndexOf(")") + 2).split(/\s+/u)[19];
    const namespace = await readlink(`/proc/${processId}/ns/pid`);
    return /^\d+$/u.test(startTicks ?? "") ? { startTicks, namespace } : null;
  } catch { return null; } // An unavailable identity never authorizes stealing.
}

async function localOwnerStillAlive(owner: ResourceLockMetadata, lockPath: string) {
  if (!processAppearsAlive(owner.processId)) return false;
  try {
    // The boot-aware sidecar is authoritative when present. A malformed or
    // mismatched modern record cannot fall back to a weaker legacy identity.
    const recorded = parseJson(
      processIncarnationSchema,
      await readFile(path.join(lockPath, "process.json"), "utf8"),
    );
    if (recorded.token !== owner.token) return true;
    const current = await readProcessIncarnation(owner.processId);
    return current === null || current === recorded.identity;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) return true;
  }
  try {
    const identity = JSON.parse(await readFile(path.join(lockPath, "process-identity.json"), "utf8"));
    if (identity.token !== owner.token || identity.processId !== owner.processId ||
        typeof identity.startTicks !== "string" || !/^\d+$/u.test(identity.startTicks) ||
        typeof identity.namespace !== "string") return true;
    const current = await processIdentity(owner.processId);
    return current === null || (current.startTicks === identity.startTicks && current.namespace === identity.namespace);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) return true;
    // Legacy metadata has no kernel identity. Only our own PID has a known
    // process start; preserve other live owners and allow a 2s clock margin.
    return owner.processId !== process.pid || Date.parse(owner.acquiredAt) >= processStartedAt - 2_000;
  }
}

const resourceLockMetadataSchema = defineVersionedSchema<ResourceLockMetadata>({
  name: "ResourceLockMetadata",
  schemaVersion: 1,
  keys: ["token", "resourceHash", "processId", "hostname", "acquiredAt"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      token: expectString(record.token, context.at("token"), {
        minLength: 36,
        maxLength: 36,
        pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      }),
      resourceHash: expectString(record.resourceHash, context.at("resourceHash"), {
        minLength: 64,
        maxLength: 64,
        pattern: /^[0-9a-f]+$/,
      }),
      processId: expectInteger(record.processId, context.at("processId"), { minimum: 1 }),
      hostname: expectString(record.hostname, context.at("hostname"), {
        minLength: 1,
        maxLength: 255,
      }),
      acquiredAt: expectIsoDate(record.acquiredAt, context.at("acquiredAt")),
    };
  },
});

// Keep owner.json v1 byte-compatible with older workers. The optional sidecar
// is bound to the owner's random token, so another acquisition cannot supply
// the incarnation of a different lease.
const processIncarnationSchema = defineVersionedSchema<{
  schemaVersion: 1;
  token: string;
  identity: string;
}>({
  name: "ResourceLockProcessIncarnation",
  schemaVersion: 1,
  keys: ["token", "identity"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      token: expectString(record.token, context.at("token"), { minLength: 36, maxLength: 36 }),
      identity: expectString(record.identity, context.at("identity"), {
        maxLength: 255,
        pattern: /^linux:[0-9a-f-]{36}:\d+:\d+:\d+$/,
      }),
    };
  },
});

export type ResourceLockManagerOptions = {
  rootDirectory: string;
  staleAfterMs?: number;
  defaultTimeoutMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  heartbeatIntervalMs?: number;
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
};

export type AcquireLockOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

function validatePositiveFinite(name: string, value: number, allowZero = false) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new StorageError(
      "STORAGE_LOCK_OPTIONS_INVALID",
      `${name} must be ${allowZero ? "non-negative" : "positive"} and finite.`,
    );
  }
}

function abortError() {
  return new StorageError("STORAGE_LOCK_ABORTED", "Resource lock acquisition was aborted.");
}

function processAppearsAlive(processId: number) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    if (isNodeError(error, "EPERM")) return true;
    throw error;
  }
}

function sameLockSnapshot(
  before: Stats,
  after: Stats,
  includeCtime = true,
) {
  return before.dev === after.dev && before.ino === after.ino &&
    before.mtimeMs === after.mtimeMs && (!includeCtime || before.ctimeMs === after.ctimeMs);
}

type ProcessLockWaiter = {
  active: boolean;
  resolve: (release: () => void) => void;
};

type ProcessLockState = {
  locked: boolean;
  waiters: ProcessLockWaiter[];
};

const processLocks = new Map<string, ProcessLockState>();

function processLockRelease(lockPath: string, state: ProcessLockState) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    let next = state.waiters.shift();
    while (next && !next.active) next = state.waiters.shift();
    if (next) {
      next.active = false;
      next.resolve(processLockRelease(lockPath, state));
      return;
    }
    state.locked = false;
    if (processLocks.get(lockPath) === state) processLocks.delete(lockPath);
  };
}

function acquireProcessLock(
  lockPath: string,
  resourceKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return Promise.reject(abortError());
  const state = processLocks.get(lockPath) ?? { locked: false, waiters: [] };
  processLocks.set(lockPath, state);
  if (!state.locked) {
    state.locked = true;
    return Promise.resolve(processLockRelease(lockPath, state));
  }
  if (timeoutMs === 0) return Promise.reject(new ResourceLockTimeoutError(resourceKey, timeoutMs));
  return new Promise<() => void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const waiter: ProcessLockWaiter = {
      active: true,
      resolve: (release) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      },
    };
    const fail = (error: Error) => {
      if (!waiter.active) return;
      waiter.active = false;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => fail(abortError());
    timer = setTimeout(
      () => fail(new ResourceLockTimeoutError(resourceKey, timeoutMs)),
      timeoutMs,
    );
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    state.waiters.push(waiter);
  });
}

async function wait(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ResourceLockLease {
  readonly resourceKey: string;
  readonly token: string;
  readonly lockPath: string;
  private readonly ownerPath: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private released = false;
  private ownershipLost = false;

  constructor(
    resourceKey: string,
    token: string,
    lockPath: string,
    private readonly heartbeatIntervalMs: number,
  ) {
    this.resourceKey = resourceKey;
    this.token = token;
    this.lockPath = lockPath;
    this.ownerPath = path.join(lockPath, "owner.json");
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => {
        this.ownershipLost = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private async readOwner() {
    return parseJson(
      resourceLockMetadataSchema,
      await readFile(this.ownerPath, "utf8"),
      this.ownerPath,
    );
  }

  private async heartbeat() {
    if (this.released || this.ownershipLost) return;
    const owner = await this.readOwner();
    if (owner.token !== this.token) throw new ResourceLockOwnershipLostError(this.resourceKey);
    const now = new Date();
    await utimes(this.lockPath, now, now);
  }

  async assertHeld() {
    if (this.released || this.ownershipLost) {
      throw new ResourceLockOwnershipLostError(this.resourceKey);
    }
    try {
      const owner = await this.readOwner();
      if (owner.token !== this.token) {
        this.ownershipLost = true;
        throw new ResourceLockOwnershipLostError(this.resourceKey);
      }
    } catch (error) {
      if (error instanceof ResourceLockOwnershipLostError) throw error;
      this.ownershipLost = true;
      throw new ResourceLockOwnershipLostError(this.resourceKey);
    }
  }

  async release() {
    if (this.released) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.assertHeld();
    await rm(this.lockPath, { recursive: true, force: false });
    await fsyncDirectory(path.dirname(this.lockPath));
    this.released = true;
  }
}

export class ResourceLockManager {
  readonly rootDirectory: string;
  readonly staleAfterMs: number;
  readonly defaultTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly heartbeatIntervalMs: number;
  readonly jitterRatio: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: ResourceLockManagerOptions) {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw new StorageError(
        "STORAGE_LOCK_OPTIONS_INVALID",
        "Resource lock rootDirectory must be absolute.",
      );
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
    this.retryDelayMs = options.retryDelayMs ?? 10;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 250;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(5, Math.floor(this.staleAfterMs / 3));
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;

    validatePositiveFinite("staleAfterMs", this.staleAfterMs);
    validatePositiveFinite("defaultTimeoutMs", this.defaultTimeoutMs, true);
    validatePositiveFinite("retryDelayMs", this.retryDelayMs);
    validatePositiveFinite("maxRetryDelayMs", this.maxRetryDelayMs);
    validatePositiveFinite("heartbeatIntervalMs", this.heartbeatIntervalMs);
    if (this.maxRetryDelayMs < this.retryDelayMs) {
      throw new StorageError(
        "STORAGE_LOCK_OPTIONS_INVALID",
        "maxRetryDelayMs must be greater than or equal to retryDelayMs.",
      );
    }
    if (this.heartbeatIntervalMs >= this.staleAfterMs) {
      throw new StorageError(
        "STORAGE_LOCK_OPTIONS_INVALID",
        "heartbeatIntervalMs must be shorter than staleAfterMs.",
      );
    }
    if (!Number.isFinite(this.jitterRatio) || this.jitterRatio < 0 || this.jitterRatio > 1) {
      throw new StorageError(
        "STORAGE_LOCK_OPTIONS_INVALID",
        "jitterRatio must be between zero and one.",
      );
    }
  }

  resourceHash(resourceKey: string) {
    if (!resourceKey) {
      throw new StorageError("STORAGE_LOCK_RESOURCE_INVALID", "Resource key must not be empty.");
    }
    return createHash("sha256").update(resourceKey).digest("hex");
  }

  lockPathFor(resourceKey: string) {
    return path.join(this.rootDirectory, `${this.resourceHash(resourceKey)}.lock`);
  }

  private async recoverStaleLock(lockPath: string, resourceHash: string) {
    let initial;
    try {
      initial = await stat(lockPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    if (this.now() - initial.mtimeMs < this.staleAfterMs) return false;

    let owner: ResourceLockMetadata | null = null;
    try {
      owner = parseJson(
        resourceLockMetadataSchema,
        await readFile(path.join(lockPath, "owner.json"), "utf8"),
        path.join(lockPath, "owner.json"),
      );
    } catch (error) {
      // A stale, abandoned directory may contain a torn owner record. It still
      // has to pass the unchanged-inode checks below before quarantine.
    }
    if (owner?.resourceHash && owner.resourceHash !== resourceHash) {
      throw new StorageError(
        "STORAGE_LOCK_RESOURCE_MISMATCH",
        "Resource lock metadata does not match its canonical lock path.",
      );
    }
    if (owner?.hostname === hostname() && await localOwnerStillAlive(owner, lockPath)) {
      return false;
    }

    let confirmed;
    try {
      confirmed = await stat(lockPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    if (!sameLockSnapshot(initial, confirmed) || this.now() - confirmed.mtimeMs < this.staleAfterMs) {
      return false;
    }

    const stalePath = `${lockPath}.stale.${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    const quarantined = await stat(stalePath);
    if (!sameLockSnapshot(confirmed, quarantined, false)) {
      try {
        await rename(stalePath, lockPath);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        await rm(stalePath, { recursive: true, force: false });
      }
      await fsyncDirectory(this.rootDirectory);
      return false;
    }
    await rm(stalePath, { recursive: true, force: false });
    await fsyncDirectory(this.rootDirectory);
    return true;
  }

  async acquire(resourceKey: string, options: AcquireLockOptions = {}) {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    validatePositiveFinite("timeoutMs", timeoutMs, true);
    if (options.signal?.aborted) throw abortError();

    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const lockPath = this.lockPathFor(resourceKey);
    const resourceHash = this.resourceHash(resourceKey);
    const deadline = this.now() + timeoutMs;
    let delayMs = this.retryDelayMs;

    while (true) {
      const token = randomUUID();
      try {
        await mkdir(lockPath, { mode: 0o700 });
        const acquiredAt = new Date(this.now()).toISOString();
        try {
          await atomicWriteJson(
            path.join(lockPath, "owner.json"),
            {
              schemaVersion: 1,
              token,
              resourceHash,
              processId: process.pid,
              hostname: hostname(),
              acquiredAt,
            },
            resourceLockMetadataSchema,
          );
          const identity = await processIdentity(process.pid);
          if (identity) {
            await atomicWriteJson(path.join(lockPath, "process-identity.json"), {
              ...identity, token, processId: process.pid,
            }, { name: "ProcessIdentity", parse: (value) => value }, { mode: 0o600 });
          }
          const incarnation = await readProcessIncarnation(process.pid);
          if (incarnation) {
            await atomicWriteJson(
              path.join(lockPath, "process.json"),
              { schemaVersion: 1, token, identity: incarnation },
              processIncarnationSchema,
            );
          }
          await fsyncDirectory(this.rootDirectory);
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
        const lease = new ResourceLockLease(
          resourceKey,
          token,
          lockPath,
          this.heartbeatIntervalMs,
        );
        lease.startHeartbeat();
        return lease;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }

      if (await this.recoverStaleLock(lockPath, resourceHash)) continue;
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new ResourceLockTimeoutError(resourceKey, timeoutMs);
      const jitter = 1 + ((this.random() * 2) - 1) * this.jitterRatio;
      await wait(Math.min(remaining, Math.max(1, delayMs * jitter)), options.signal);
      delayMs = Math.min(this.maxRetryDelayMs, delayMs * 2);
    }
  }

  async withLock<T>(
    resourceKey: string,
    operation: (lease: ResourceLockLease) => T | Promise<T>,
    options: AcquireLockOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    validatePositiveFinite("timeoutMs", timeoutMs, true);
    const deadline = this.now() + timeoutMs;
    const releaseProcessLock = await acquireProcessLock(
      this.lockPathFor(resourceKey),
      resourceKey,
      timeoutMs,
      options.signal,
    );
    let lease: ResourceLockLease | null = null;
    try {
      lease = await this.acquire(resourceKey, {
        ...options,
        timeoutMs: Math.max(0, deadline - this.now()),
      });
      const result = await operation(lease);
      await lease.assertHeld();
      return result;
    } finally {
      try {
        await lease?.release();
      } finally {
        releaseProcessLock();
      }
    }
  }
}
