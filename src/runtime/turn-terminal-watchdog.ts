export type TurnTerminalTimeoutKind = "idle" | "hard";

export type TurnTerminalWatchdogScheduler = Readonly<{
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}>;

const defaultScheduler: TurnTerminalWatchdogScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function positiveTimeout(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

/**
 * Bounds a runtime turn without treating a quiet HTTP attachment as failure.
 * App Server activity resets the idle deadline; the hard deadline remains a
 * final safety net.  The caller owns durable reconciliation and interruption.
 */
export class TurnTerminalWatchdog {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private paused = false;
  private activeToolCalls = 0;
  private settled = false;
  private resolveTimeout!: (kind: TurnTerminalTimeoutKind) => void;
  readonly timedOut: Promise<TurnTerminalTimeoutKind>;

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly hardTimeoutMs: number,
    private readonly scheduler: TurnTerminalWatchdogScheduler = defaultScheduler,
  ) {
    positiveTimeout("idleTimeoutMs", idleTimeoutMs);
    positiveTimeout("hardTimeoutMs", hardTimeoutMs);
    if (hardTimeoutMs < idleTimeoutMs) {
      throw new Error("hardTimeoutMs must not be shorter than idleTimeoutMs.");
    }
    this.timedOut = new Promise((resolve) => { this.resolveTimeout = resolve; });
  }

  start() {
    if (this.started || this.settled) return;
    this.started = true;
    this.armIdle();
    this.hardTimer = this.scheduler.setTimeout(() => this.finish("hard"), this.hardTimeoutMs);
    this.hardTimer.unref?.();
  }

  touch() {
    if (!this.started || this.settled || this.paused) return;
    this.armIdle();
  }

  pause() {
    if (!this.started || this.settled || this.paused) return;
    this.paused = true;
    this.clearTimers();
  }

  resume() {
    if (!this.started || this.settled || !this.paused) return;
    this.paused = false;
    this.armIdle();
    this.hardTimer = this.scheduler.setTimeout(() => this.finish("hard"), this.hardTimeoutMs);
    this.hardTimer.unref?.();
  }

  stop() {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
  }

  /** An awaited tool is work, not idle time. Keep the hard deadline intact. */
  async duringToolCall<T>(run: () => Promise<T>): Promise<T> {
    this.activeToolCalls += 1;
    if (this.idleTimer) this.scheduler.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      return await run();
    } finally {
      this.activeToolCalls -= 1;
      this.touch();
    }
  }

  private armIdle() {
    if (this.activeToolCalls > 0) return;
    if (this.idleTimer) this.scheduler.clearTimeout(this.idleTimer);
    this.idleTimer = this.scheduler.setTimeout(() => this.finish("idle"), this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private finish(kind: TurnTerminalTimeoutKind) {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.resolveTimeout(kind);
  }

  private clearTimers() {
    if (this.idleTimer) this.scheduler.clearTimeout(this.idleTimer);
    if (this.hardTimer) this.scheduler.clearTimeout(this.hardTimer);
    this.idleTimer = null;
    this.hardTimer = null;
  }
}
