import type { OperationalLogger } from "@/operations/logging";

export type TurnTelemetryCorrelation = Readonly<{
  installationId: string;
  userId: string;
  projectId: string;
  threadId: string;
  localTurnId: string;
  clientRequestId: string;
  streamRequestId?: string;
}>;

export type TurnTelemetryTerminal = "completed" | "error" | "stopped";
export type TurnTelemetryLifecycle = "resumed" | "reconnected" | "disconnected" | "cancel_requested" | "timeout_requested";
export type TurnTelemetryPhase =
  | "memory"
  | "worker"
  | "catalog"
  | "skills"
  | "model_queue"
  | "connector_resolution"
  | "thread_start"
  | "thread_resume"
  | "turn_start";

export type TurnTelemetrySnapshot = Readonly<{
  admissionMs: number | null;
  memoryMs: number | null;
  workerWarm: boolean | null;
  workerStartupMs: number | null;
  catalogMs: number | null;
  skillsMs: number | null;
  threadStartMs: number | null;
  threadResumeMs: number | null;
  turnStartMs: number | null;
  firstMeaningfulMs: number | null;
  serverFirstDeltaMs: number | null;
  serverDeltaCount: number;
  serverInterDeltaP50Ms: number | null;
  serverInterDeltaP95Ms: number | null;
  serverInterDeltaMaxMs: number | null;
  firstActivityMs: number | null;
  firstSummaryMs: number | null;
  firstToolMs: number | null;
  firstActivityWithinBudget: boolean | null;
  firstTextWithinBudget: boolean | null;
  totalMs: number;
  resumeCount: number;
  reconnectCount: number;
  disconnectCount: number;
  cancelRequested: boolean;
  timeoutRequested: boolean;
}>;

/**
 * Product budgets, not timeouts. They are evaluated in telemetry and never
 * terminate or retry a valid turn. Cold workers have a separate allowance.
 */
export const TURN_PERFORMANCE_BUDGET_MS = Object.freeze({
  warmFirstActivity: 1_500,
  coldFirstActivity: 8_000,
  warmFirstText: 6_000,
  coldFirstText: 18_000,
});

type TurnTelemetryOptions = Readonly<{
  logger: Pick<OperationalLogger, "info">;
  now?: () => number;
  /** Share the HTTP request clock with the worker when it is available. */
  startedAt?: number;
}>;

function elapsedMs(startedAt: number, now: () => number) {
  return Math.max(0, Math.round(now() - startedAt));
}

function percentile(values: readonly number[], ratio: number) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

/**
 * Private, payload-free timing for one logical turn or one attached stream.
 * It emits to the existing operational logger; it does not persist prompts,
 * model output, token counts, error text or credentials.
 */
export class TurnTelemetry {
  private readonly now: () => number;
  private readonly startedAt: number;
  private runtimeThreadId: string | null = null;
  private runtimeTurnId: string | null = null;
  private firstDeltaAt: number | null = null;
  private firstActivityAt: number | null = null;
  private firstSummaryAt: number | null = null;
  private firstToolAt: number | null = null;
  private previousDeltaAt: number | null = null;
  private readonly interDeltaMs: number[] = [];
  private readonly toolQueuedAt = new Map<string, number>();
  private resumeCount = 0;
  private reconnectCount = 0;
  private disconnectCount = 0;
  private cancelRequested = false;
  private timeoutRequested = false;
  private terminal: TurnTelemetryTerminal | null = null;
  private admittedAt: number | null = null;
  private workerWarm: boolean | null = null;
  private readonly phaseElapsedMs = new Map<TurnTelemetryPhase, number>();

  constructor(
    private readonly correlation: TurnTelemetryCorrelation,
    private readonly options: TurnTelemetryOptions,
  ) {
    this.now = options.now ?? performance.now.bind(performance);
    this.startedAt = options.startedAt ?? this.now();
  }

  bindRuntimeThread(runtimeThreadId: string) {
    this.runtimeThreadId = runtimeThreadId;
  }

  bindRuntimeTurn(runtimeTurnId: string) {
    this.runtimeTurnId = runtimeTurnId;
  }

  modelSelected(input: {
    experience: string;
    requestedModel: string | null;
    effectiveModel: string | null;
    effort: string | null;
    source: "runtime" | "request" | "default";
  }) {
    const safe = (value: string | null) => value && /^[A-Za-z0-9._-]{1,100}$/u.test(value) ? value : null;
    this.options.logger.info("codex.turn_model", {
      metricSchemaVersion: 1,
      ...this.attributes(),
      experience: safe(input.experience) ?? "unknown",
      requestedModel: safe(input.requestedModel),
      effectiveModel: safe(input.effectiveModel),
      effort: safe(input.effort),
      source: input.source,
      requestElapsedMs: elapsedMs(this.startedAt, this.now),
    });
  }

  modelRerouted(fromModel: string, toModel: string, reason: string | null) {
    const safe = (value: string | null) => value && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : null;
    this.options.logger.info("codex.turn_model_rerouted", {
      metricSchemaVersion: 1,
      ...this.attributes(),
      fromModel: safe(fromModel),
      effectiveModel: safe(toModel),
      reason: safe(reason),
      requestElapsedMs: elapsedMs(this.startedAt, this.now),
    });
  }

  workerReadiness(warm: boolean) {
    this.workerWarm = warm;
  }

  admitted() {
    this.admittedAt ??= this.now();
  }

  resumed() {
    this.resumeCount += 1;
    this.lifecycle("resumed");
  }

  reconnected() {
    this.reconnectCount += 1;
    this.lifecycle("reconnected");
  }

  disconnected() {
    this.disconnectCount += 1;
    this.lifecycle("disconnected");
  }

  cancellationRequested() {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    this.lifecycle("cancel_requested");
  }

  timeout() {
    if (this.timeoutRequested) return;
    this.timeoutRequested = true;
    this.lifecycle("timeout_requested");
  }

  delta() {
    const observedAt = this.now();
    this.firstDeltaAt ??= observedAt;
    if (this.previousDeltaAt !== null) {
      this.interDeltaMs.push(Math.max(0, Math.round(observedAt - this.previousDeltaAt)));
    }
    this.previousDeltaAt = observedAt;
  }

  /** Marks an observed, user-safe App Server event without retaining its text. */
  activity() {
    this.firstActivityAt ??= this.now();
  }

  summary() {
    this.firstSummaryAt ??= this.now();
  }

  tool() {
    this.firstToolAt ??= this.now();
  }

  toolQueued(itemId: string) {
    if (!itemId || this.toolQueuedAt.has(itemId)) return;
    this.toolQueuedAt.set(itemId, this.now());
    while (this.toolQueuedAt.size > 128) {
      const oldest = this.toolQueuedAt.keys().next().value;
      if (oldest === undefined) break;
      this.toolQueuedAt.delete(oldest);
    }
  }

  toolExecution(itemId: string | null, toolKind: string) {
    const executionStartedAt = this.now();
    const queuedAt = itemId ? this.toolQueuedAt.get(itemId) ?? null : null;
    if (itemId) this.toolQueuedAt.delete(itemId);
    this.tool();
    return (outcome: "completed" | "error") => {
      const completedAt = this.now();
      this.options.logger.info("codex.tool_phase", {
        metricSchemaVersion: 1,
        ...this.attributes(),
        toolKind: /^[A-Za-z0-9_.:-]{1,128}$/u.test(toolKind) ? toolKind : "unknown",
        outcome,
        queueMs: queuedAt === null ? null : Math.max(0, Math.round(executionStartedAt - queuedAt)),
        executionMs: Math.max(0, Math.round(completedAt - executionStartedAt)),
        requestElapsedMs: elapsedMs(this.startedAt, () => completedAt),
      });
    };
  }

  async measure<T>(phase: TurnTelemetryPhase, operation: () => Promise<T>): Promise<T> {
    const phaseStartedAt = this.now();
    let outcome: "completed" | "error" = "completed";
    try {
      return await operation();
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      const phaseMs = elapsedMs(phaseStartedAt, this.now);
      this.phaseElapsedMs.set(phase, (this.phaseElapsedMs.get(phase) ?? 0) + phaseMs);
      this.options.logger.info("codex.turn_phase", {
        metricSchemaVersion: 2,
        ...this.attributes(),
        phase,
        outcome,
        phaseMs,
        requestElapsedMs: elapsedMs(this.startedAt, this.now),
      });
    }
  }

  finish(terminal: TurnTelemetryTerminal): TurnTelemetrySnapshot {
    if (this.terminal === null) {
      this.terminal = terminal;
      const snapshot = this.snapshot();
      this.options.logger.info("codex.turn_metrics", {
        metricSchemaVersion: 2,
        ...this.attributes(),
        terminal,
        ...snapshot,
      });
      return snapshot;
    }
    return this.snapshot();
  }

  private lifecycle(lifecycle: TurnTelemetryLifecycle) {
    this.options.logger.info("codex.turn_lifecycle", {
      metricSchemaVersion: 2,
      ...this.attributes(),
      lifecycle,
      requestElapsedMs: elapsedMs(this.startedAt, this.now),
    });
  }

  private snapshot(): TurnTelemetrySnapshot {
    const firstMeaningfulAt = [this.firstDeltaAt, this.firstSummaryAt, this.firstToolAt]
      .filter((value): value is number => value !== null)
      .toSorted((left, right) => left - right)[0] ?? null;
    return {
      admissionMs: this.admittedAt === null ? null : Math.max(0, Math.round(this.admittedAt - this.startedAt)),
      memoryMs: this.phaseElapsedMs.get("memory") ?? null,
      workerWarm: this.workerWarm,
      workerStartupMs: this.phaseElapsedMs.get("worker") ?? null,
      catalogMs: this.phaseElapsedMs.get("catalog") ?? null,
      skillsMs: this.phaseElapsedMs.get("skills") ?? null,
      threadStartMs: this.phaseElapsedMs.get("thread_start") ?? null,
      threadResumeMs: this.phaseElapsedMs.get("thread_resume") ?? null,
      turnStartMs: this.phaseElapsedMs.get("turn_start") ?? null,
      firstMeaningfulMs: firstMeaningfulAt === null ? null : Math.max(0, Math.round(firstMeaningfulAt - this.startedAt)),
      serverFirstDeltaMs: this.firstDeltaAt === null
        ? null
        : Math.max(0, Math.round(this.firstDeltaAt - this.startedAt)),
      serverDeltaCount: this.firstDeltaAt === null ? 0 : this.interDeltaMs.length + 1,
      serverInterDeltaP50Ms: percentile(this.interDeltaMs, 0.5),
      serverInterDeltaP95Ms: percentile(this.interDeltaMs, 0.95),
      serverInterDeltaMaxMs: this.interDeltaMs.length === 0 ? null : Math.max(...this.interDeltaMs),
      firstActivityMs: this.firstActivityAt === null ? null : Math.max(0, Math.round(this.firstActivityAt - this.startedAt)),
      firstSummaryMs: this.firstSummaryAt === null ? null : Math.max(0, Math.round(this.firstSummaryAt - this.startedAt)),
      firstToolMs: this.firstToolAt === null ? null : Math.max(0, Math.round(this.firstToolAt - this.startedAt)),
      firstActivityWithinBudget: this.firstActivityAt === null ? null :
        elapsedMs(this.startedAt, () => this.firstActivityAt!) <= (this.workerWarm
          ? TURN_PERFORMANCE_BUDGET_MS.warmFirstActivity
          : TURN_PERFORMANCE_BUDGET_MS.coldFirstActivity),
      firstTextWithinBudget: this.firstDeltaAt === null ? null :
        elapsedMs(this.startedAt, () => this.firstDeltaAt!) <= (this.workerWarm
          ? TURN_PERFORMANCE_BUDGET_MS.warmFirstText
          : TURN_PERFORMANCE_BUDGET_MS.coldFirstText),
      totalMs: elapsedMs(this.startedAt, this.now),
      resumeCount: this.resumeCount,
      reconnectCount: this.reconnectCount,
      disconnectCount: this.disconnectCount,
      cancelRequested: this.cancelRequested,
      timeoutRequested: this.timeoutRequested,
    };
  }

  private attributes() {
    return {
      installationId: this.correlation.installationId,
      userId: this.correlation.userId,
      projectId: this.correlation.projectId,
      threadId: this.correlation.threadId,
      localTurnId: this.correlation.localTurnId,
      clientRequestId: this.correlation.clientRequestId,
      ...(this.correlation.streamRequestId ? { streamRequestId: this.correlation.streamRequestId } : {}),
      ...(this.runtimeThreadId ? { runtimeThreadId: this.runtimeThreadId } : {}),
      ...(this.runtimeTurnId ? { runtimeTurnId: this.runtimeTurnId } : {}),
    };
  }
}
