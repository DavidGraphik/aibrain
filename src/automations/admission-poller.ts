export type AutomationAdmissionSource<Claim, Result> = {
  userId: string;
  claim: (availableSlots: number) => Promise<Claim[]>;
  execute: (claim: Claim) => Promise<Result>;
};

/** Polling waits for durable claims only, never for another user's turn.
 * The existing per-user concurrency and runtime global capacity remain in force. */
export class AutomationAdmissionPoller<Claim, Result> {
  private accepting = true;
  private readonly users = new Map<string, { claiming: boolean; active: Set<Promise<void>> }>();
  private readonly polls = new Set<Promise<void>>();
  private reserved = 0;
  private cursor = 0;

  constructor(private readonly options: {
    concurrency: number;
    /** Bound claimed work before the shared model queue deadline starts. */
    globalConcurrency?: number;
    onResult: (result: Result) => void;
    onError: (error: unknown, userId: string) => void;
  }) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 ||
        (options.globalConcurrency !== undefined && (!Number.isSafeInteger(options.globalConcurrency) || options.globalConcurrency < 1))) throw Error('AUTOMATION_CONCURRENCY_INVALID');
  }

  private report(error: unknown, userId: string) {
    try { this.options.onError(error, userId); } catch { /* Reporting cannot orphan an admitted slot. */ }
  }

  async poll(sources: readonly AutomationAdmissionSource<Claim, Result>[]) {
    if (!this.accepting) return;
    const selected = new Set<string>();
    const polls: Promise<void>[] = [];
    const start = this.cursor % (sources.length || 1);
    for (let offset = 0; offset < sources.length; offset++) {
      if (!this.accepting) break;
      const index = (start + offset) % sources.length;
      const source = sources[index];
      if (selected.has(source.userId)) continue;
      selected.add(source.userId);
      let user = this.users.get(source.userId);
      if (!user) { user = { claiming: false, active: new Set() }; this.users.set(source.userId, user); }
      const available = Math.min(this.options.concurrency - user.active.size,
        (this.options.globalConcurrency ?? Number.MAX_SAFE_INTEGER) - this.reserved);
      if (user.claiming || available <= 0) continue;
      user.claiming = true; // Reserve admission before awaiting the store, including overlapping polls.
      const current = user;
      this.reserved += available; // Includes in-flight claim RPCs across overlapping polls.
      this.cursor = index + 1;
      let unassigned = available;
      const work = Promise.resolve().then(async () => {
        const claims = await source.claim(available);
        if (claims.length > available) throw Error('AUTOMATION_CLAIM_CAPACITY_EXCEEDED');
        this.reserved -= available - claims.length;
        unassigned = 0;
        for (const claim of claims) {
          const execution = Promise.resolve().then(() => source.execute(claim))
            .then(result => this.options.onResult(result))
            .catch(error => { this.report(error, source.userId); })
            .finally(() => { current.active.delete(execution); this.reserved--; });
          current.active.add(execution);
        }
      }).catch(error => { this.report(error, source.userId); }).finally(() => {
        this.reserved -= unassigned;
        current.claiming = false;
        this.polls.delete(work);
      });
      this.polls.add(work);
      polls.push(work);
      // Empty/error claims must release their reservation before the next user is skipped.
      // Await admission only: executions retain capacity independently until settlement.
      if (this.reserved >= (this.options.globalConcurrency ?? Number.MAX_SAFE_INTEGER)) await work;
    }
    await Promise.all(polls);
  }

  /** Stop new claims; admitted executions retain their slot until durable settlement.
   * A forced process exit leaves the unchanged store leases/fences recoverable. */
  close() { this.accepting = false; }

  async stop() {
    this.close();
    while (this.polls.size || [...this.users.values()].some(user => user.active.size)) {
      await Promise.allSettled([...this.polls, ...[...this.users.values()].flatMap(user => [...user.active])]);
    }
  }
}
