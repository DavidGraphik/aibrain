/** One maintenance scan per process. Scheduling must not await slow memory
 * extraction; shutdown must still drain the admitted scan before closing users. */
export class BackgroundMaintenance<Input, Result> {
  private active: Promise<void> | null = null;
  private closed = false;
  constructor(private readonly execute: (input: Input) => Promise<Result>,
    private readonly report: (result: Result) => void,
    private readonly reportError: () => void) {}

  start(input: Input) {
    if (this.closed || this.active) return false;
    const running = Promise.resolve().then(() => this.execute(input)).then(result => this.report(result), () => this.reportError())
      .catch(() => undefined);
    // Reporting is observational; a failed observer cannot create an unhandled
    // rejection or lose ownership of an admitted extraction.
    this.active = running;
    void running.finally(() => { if (this.active === running) this.active = null; });
    return true;
  }

  async stop() { this.closed = true; await this.active; }
}
