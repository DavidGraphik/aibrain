/** Observe durable completion even when both final-text and terminal events are lost. */
export class TurnCompletionReconciler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private started = false;

  constructor(private readonly reconcile: () => Promise<void>, private readonly intervalMs = 15_000) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("Invalid completion observation interval.");
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcile().catch(() => {
        // A failed observation is not evidence of a failed model turn.
      }).finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref?.();
  }
}
