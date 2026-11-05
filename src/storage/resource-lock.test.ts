import { mkdir, readFile, writeFile, rm, utimes } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as incarnation from "@/storage/process-incarnation";
import {
  ResourceLockManager,
  ResourceLockTimeoutError,
} from "@/storage";

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

describe("resource lock manager", () => {
  let root: string;
  let lockRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aibrain-lock-"));
    lockRoot = path.join(root, "locks");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function manager(overrides: Partial<ConstructorParameters<typeof ResourceLockManager>[0]> = {}) {
    return new ResourceLockManager({
      rootDirectory: lockRoot,
      staleAfterMs: 2_000,
      defaultTimeoutMs: 5_000,
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      heartbeatIntervalMs: 100,
      jitterRatio: 0,
      ...overrides,
    });
  }

  it("serializes concurrent operations across independent manager instances", async () => {
    const first = manager();
    const second = manager();
    let counter = 0;
    let inside = 0;
    let maximumInside = 0;

    await Promise.all(Array.from({ length: 50 }, (_, index) => {
      const selected = index % 2 === 0 ? first : second;
      return selected.withLock("user-1/thread-1", async () => {
        inside += 1;
        maximumInside = Math.max(maximumInside, inside);
        const previous = counter;
        await delay(index % 3);
        counter = previous + 1;
        inside -= 1;
      });
    }));

    expect(counter).toBe(50);
    expect(maximumInside).toBe(1);
  });

  it("times out without disturbing the current owner", async () => {
    const first = manager();
    const second = manager();
    const lease = await first.acquire("busy-resource");

    await expect(second.acquire("busy-resource", { timeoutMs: 25 }))
      .rejects.toBeInstanceOf(ResourceLockTimeoutError);
    await lease.assertHeld();
    await lease.release();

    const successor = await second.acquire("busy-resource", { timeoutMs: 100 });
    await successor.release();
  });

  it("recovers an abandoned stale lock directory", async () => {
    const locks = manager({ staleAfterMs: 100, heartbeatIntervalMs: 20 });
    const stalePath = locks.lockPathFor("abandoned");
    await mkdir(stalePath, { recursive: true });
    const staleTime = new Date(Date.now() - 5_000);
    await utimes(stalePath, staleTime, staleTime);

    const lease = await locks.acquire("abandoned", { timeoutMs: 100 });
    await lease.assertHeld();
    await lease.release();
  });

  it("recovers a legacy lock predating the current process despite the same live PID", async () => {
    const locks = manager({ staleAfterMs: 100, heartbeatIntervalMs: 20 });
    const stalePath = locks.lockPathFor("reused-pid");
    await mkdir(stalePath, { recursive: true });
    const previousProcessTime = new Date(Date.now() - process.uptime() * 1_000 - 60_000);
    await writeFile(path.join(stalePath, "owner.json"), JSON.stringify({
      schemaVersion: 1, token: randomUUID(), resourceHash: locks.resourceHash("reused-pid"),
      processId: process.pid, hostname: hostname(), acquiredAt: previousProcessTime.toISOString(),
    }));
    await utimes(stalePath, previousProcessTime, previousProcessTime);
    const recovered = await locks.acquire("reused-pid", { timeoutMs: 100 });
    await recovered.assertHeld();
    await recovered.release();
  });

  it.skipIf(process.platform !== "linux")("recovers a different kernel process identity without stealing the current identity", async () => {
    const locks = manager({ staleAfterMs: 100, heartbeatIntervalMs: 90 });
    const lease = await locks.acquire("kernel-generation");
    // Reproduce a lock written by the older sidecar-only release.
    await rm(path.join(lease.lockPath, "process.json"));
    const identityPath = path.join(lease.lockPath, "process-identity.json");
    const identity = JSON.parse(await readFile(identityPath, "utf8"));
    const old = new Date(Date.now() - 5_000);
    await utimes(lease.lockPath, old, old);
    await expect(locks.acquire("kernel-generation", { timeoutMs: 20 })).rejects.toBeInstanceOf(ResourceLockTimeoutError);
    await writeFile(identityPath, JSON.stringify({ ...identity, startTicks: "0" }));
    await utimes(lease.lockPath, old, old);
    const successor = await locks.acquire("kernel-generation", { timeoutMs: 100 });
    await successor.assertHeld();
    await successor.release();
  });

  it("heartbeats a live lease so it cannot be stolen as stale", async () => {
    const first = manager({ staleAfterMs: 60, heartbeatIntervalMs: 10 });
    const second = manager({ staleAfterMs: 60, heartbeatIntervalMs: 10 });
    const lease = await first.acquire("long-operation");

    await delay(100);
    await expect(second.acquire("long-operation", { timeoutMs: 30 }))
      .rejects.toBeInstanceOf(ResourceLockTimeoutError);
    await lease.assertHeld();
    await lease.release();
  });

  it("fails closed when a live local owner has an artificially stale timestamp", async () => {
    const first = manager({ staleAfterMs: 100, heartbeatIntervalMs: 90 });
    const second = manager({ staleAfterMs: 100, heartbeatIntervalMs: 90 });
    const lease = await first.acquire("live-but-old-timestamp");
    const staleTime = new Date(Date.now() - 5_000);
    await utimes(lease.lockPath, staleTime, staleTime);

    await expect(second.acquire("live-but-old-timestamp", { timeoutMs: 20 }))
      .rejects.toBeInstanceOf(ResourceLockTimeoutError);
    await lease.assertHeld();
    await lease.release();
  });

  const originalIdentity = "linux:12345678-1234-1234-1234-123456789abc:4:100:200";
  const reusedIdentity = "linux:12345678-1234-1234-1234-123456789abc:4:101:900";

  async function abandonedWithLivePid(sidecar: "valid" | "missing" | "wrong-token" | "malformed") {
    vi.spyOn(incarnation, "readProcessIncarnation").mockResolvedValue(originalIdentity);
    const locks = manager({ staleAfterMs: 100, heartbeatIntervalMs: 90 });
    const seed = await locks.acquire("reused-pid");
    const owner = JSON.parse(await readFile(path.join(seed.lockPath, "owner.json"), "utf8"));
    // Finish the seed lease, then recreate its abandoned on-disk record. The
    // recorded PID deliberately remains alive, reproducing container PID reuse.
    await seed.release();
    await mkdir(seed.lockPath);
    await writeFile(path.join(seed.lockPath, "owner.json"), JSON.stringify(owner));
    if (sidecar !== "missing") {
      await writeFile(path.join(seed.lockPath, "process.json"), sidecar === "malformed" ? "{" : JSON.stringify({
        schemaVersion: 1,
        token: sidecar === "wrong-token" ? "00000000-0000-4000-8000-000000000000" : owner.token,
        identity: originalIdentity,
      }));
    }
    const staleTime = new Date(Date.now() - 5_000);
    await utimes(seed.lockPath, staleTime, staleTime);
    return { locks, owner };
  }

  it("recovers a stale lock whose PID is alive but belongs to a different incarnation", async () => {
    const { locks, owner } = await abandonedWithLivePid("valid");
    vi.mocked(incarnation.readProcessIncarnation).mockResolvedValue(reusedIdentity);
    const successor = await locks.acquire("reused-pid", { timeoutMs: 20 });
    expect(successor.token).not.toBe(owner.token);
    await successor.assertHeld();
    await successor.release();
  });

  it("keeps concurrent contenders exclusive while recovering an old incarnation", async () => {
    const { locks } = await abandonedWithLivePid("valid");
    vi.mocked(incarnation.readProcessIncarnation).mockResolvedValue(reusedIdentity);
    let inside = 0;
    let maximumInside = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      // acquire directly to exercise the filesystem protocol, independently of
      // withLock's extra in-process queue.
      const lease = await locks.acquire("reused-pid", { timeoutMs: 1_000 });
      try {
        inside += 1;
        maximumInside = Math.max(maximumInside, inside);
        await delay(5);
        await lease.assertHeld();
      } finally {
        inside -= 1;
        await lease.release();
      }
    }));
    expect(maximumInside).toBe(1);
  });

  it("does not steal a stale lock from the same live incarnation", async () => {
    const { locks } = await abandonedWithLivePid("valid");
    await expect(locks.acquire("reused-pid", { timeoutMs: 20 }))
      .rejects.toBeInstanceOf(ResourceLockTimeoutError);
  });

  it("fails closed when the current live PID identity cannot be inspected", async () => {
    const { locks } = await abandonedWithLivePid("valid");
    vi.mocked(incarnation.readProcessIncarnation).mockResolvedValue(null);
    await expect(locks.acquire("reused-pid", { timeoutMs: 20 }))
      .rejects.toBeInstanceOf(ResourceLockTimeoutError);
  });

  it.each(["missing", "wrong-token", "malformed"] as const)(
    "preserves a live PID owner with a %s incarnation sidecar",
    async (sidecar) => {
      const { locks } = await abandonedWithLivePid(sidecar);
      vi.mocked(incarnation.readProcessIncarnation).mockResolvedValue(reusedIdentity);
      await expect(locks.acquire("reused-pid", { timeoutMs: 20 }))
        .rejects.toBeInstanceOf(ResourceLockTimeoutError);
    },
  );

  it("keeps a live boot-aware owner despite conflicting legacy identity metadata", async () => {
    const { locks, owner } = await abandonedWithLivePid("valid");
    await writeFile(path.join(locks.lockPathFor("reused-pid"), "process-identity.json"), JSON.stringify({
      token: owner.token, processId: owner.processId, startTicks: "0", namespace: "pid:[0]",
    }));
    const old = new Date(Date.now() - 5_000);
    await utimes(locks.lockPathFor("reused-pid"), old, old);
    await expect(locks.acquire("reused-pid", { timeoutMs: 20 }))
      .rejects.toBeInstanceOf(ResourceLockTimeoutError);
  });

  it("supports cancellation while waiting and idempotent release", async () => {
    const first = manager();
    const second = manager();
    const lease = await first.acquire("cancelled-waiter");
    const controller = new AbortController();
    const waiting = second.acquire("cancelled-waiter", {
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ code: "STORAGE_LOCK_ABORTED" });
    await lease.release();
    await lease.release();
  });

  it("hashes resource keys so paths cannot escape the lock root", () => {
    const locks = manager();
    const lockPath = locks.lockPathFor("../../another-user/secret");
    expect(path.dirname(lockPath)).toBe(lockRoot);
    expect(path.basename(lockPath)).toMatch(/^[0-9a-f]{64}\.lock$/);
  });
});
