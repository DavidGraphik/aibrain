import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  FileJournal,
  ResourceLockManager,
} from "@/storage";
import {
  sharedSubscriptionSnapshotSchema,
  turnUsageRecordSchema,
  zeroTokenUsage,
  type SharedSubscriptionSnapshot,
  type TokenUsageBreakdown,
  type TurnUsageRecord,
  type UsageAggregate,
} from "@/usage/contracts";

const INSTALLATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60_000;

export class UsageStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "UsageStoreError";
  }
}

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

async function ensurePrivateDirectory(directory: string) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await mkdir(directory, { mode: 0o700 });
    metadata = await lstat(directory);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new UsageStoreError("USAGE_PATH_UNSAFE", "Usage storage must be a real directory.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new UsageStoreError("USAGE_PATH_UNSAFE", "Usage storage must be private to its owner.");
  }
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return null;
  // Callers supply private scratch arrays, so sorting needs no second copy.
  const sorted = values.sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

function addTokens(total: TokenUsageBreakdown, next: TokenUsageBreakdown) {
  total.totalTokens += next.totalTokens;
  total.inputTokens += next.inputTokens;
  total.cachedInputTokens += next.cachedInputTokens;
  total.cacheWriteInputTokens += next.cacheWriteInputTokens;
  total.outputTokens += next.outputTokens;
  total.reasoningOutputTokens += next.reasoningOutputTokens;
}

export function aggregateTurnUsage(records: readonly TurnUsageRecord[]): UsageAggregate {
  const durations: number[] = [];
  const firstText: number[] = [];
  const activeDays = new Set<string>();
  const tokens = { ...zeroTokenUsage };
  let completedTurns = 0;
  let errorTurns = 0;
  let stoppedTurns = 0;
  let totalDurationMs = 0;
  let totalFirstTextMs = 0;
  let turnsWithTokenData = 0;
  for (const record of records) {
    durations.push(record.durationMs);
    totalDurationMs += record.durationMs;
    if (record.firstTextMs !== null) {
      firstText.push(record.firstTextMs);
      totalFirstTextMs += record.firstTextMs;
    }
    if (record.tokenUsage) {
      addTokens(tokens, record.tokenUsage);
      turnsWithTokenData += 1;
    }
    if (record.status === "completed") completedTurns += 1;
    else if (record.status === "error") errorTurns += 1;
    else if (record.status === "stopped") stoppedTurns += 1;
    activeDays.add(record.startedAt.slice(0, 10));
  }
  return {
    turns: records.length,
    completedTurns,
    errorTurns,
    stoppedTurns,
    activeDays: activeDays.size,
    totalDurationMs,
    averageDurationMs: records.length === 0 ? null : Math.round(totalDurationMs / records.length),
    p95DurationMs: percentile(durations, 0.95),
    averageFirstTextMs: firstText.length === 0 ? null : Math.round(totalFirstTextMs / firstText.length),
    p95FirstTextMs: percentile(firstText, 0.95),
    turnsWithTokenData,
    tokens,
  };
}

function snapshotComparable(snapshot: SharedSubscriptionSnapshot) {
  return JSON.stringify({
    planType: snapshot.planType,
    rateLimitsAvailable: snapshot.rateLimitsAvailable,
    accountTokenUsageAvailable: snapshot.accountTokenUsageAvailable,
    rateLimits: snapshot.rateLimits,
    accountTokenUsage: snapshot.accountTokenUsage,
  });
}

export type FileUsageStoreOptions = {
  installationId: string;
  dataRoot: string;
  now?: () => number;
};

export class FileUsageStore {
  readonly installationId: string;
  readonly usageRoot: string;
  readonly turnJournalPath: string;
  readonly snapshotJournalPath: string;
  private readonly now: () => number;
  private readonly turnJournal: FileJournal<TurnUsageRecord>;
  private readonly snapshotJournal: FileJournal<SharedSubscriptionSnapshot>;

  constructor(options: FileUsageStoreOptions) {
    if (!INSTALLATION_ID_PATTERN.test(options.installationId)) {
      throw new UsageStoreError("USAGE_IDENTITY_INVALID", "Usage installationId is invalid.");
    }
    if (!path.isAbsolute(options.dataRoot)) {
      throw new UsageStoreError("USAGE_PATH_UNSAFE", "Usage dataRoot must be absolute.");
    }
    this.installationId = options.installationId;
    this.usageRoot = path.join(path.resolve(options.dataRoot), "usage");
    this.turnJournalPath = path.join(this.usageRoot, "turns.jsonl");
    this.snapshotJournalPath = path.join(this.usageRoot, "shared-subscription.jsonl");
    this.now = options.now ?? Date.now;
    const locks = new ResourceLockManager({
      rootDirectory: path.join(this.usageRoot, "locks"),
    });
    this.turnJournal = new FileJournal({
      filePath: this.turnJournalPath,
      lockManager: locks,
      payloadSchema: turnUsageRecordSchema,
      now: this.now,
    });
    this.snapshotJournal = new FileJournal({
      filePath: this.snapshotJournalPath,
      lockManager: locks,
      payloadSchema: sharedSubscriptionSnapshotSchema,
      now: this.now,
    });
  }

  private async prepare() {
    await ensurePrivateDirectory(this.usageRoot);
    await ensurePrivateDirectory(path.join(this.usageRoot, "locks"));
  }

  async recordTurn(input: TurnUsageRecord) {
    await this.prepare();
    const record = turnUsageRecordSchema.parse(input, "turn usage input");
    if (record.installationId !== this.installationId) {
      throw new UsageStoreError("USAGE_IDENTITY_MISMATCH", "Turn usage belongs to another installation.");
    }
    return this.turnJournal.appendIf(record, (entries) => !entries.some(({ payload }) =>
      payload.installationId === record.installationId &&
      payload.userId === record.userId &&
      payload.threadId === record.threadId &&
      payload.turnId === record.turnId));
  }

  async listTurns(userId?: string) {
    await this.prepare();
    const entries = await this.turnJournal.read();
    return entries.flatMap(({ payload }) =>
      payload.installationId === this.installationId && (!userId || payload.userId === userId)
        ? [payload]
        : []);
  }

  async recordSharedSubscription(snapshotInput: SharedSubscriptionSnapshot) {
    await this.prepare();
    const snapshot = sharedSubscriptionSnapshotSchema.parse(
      snapshotInput,
      "shared subscription snapshot input",
    );
    if (snapshot.installationId !== this.installationId) {
      throw new UsageStoreError("USAGE_IDENTITY_MISMATCH", "Usage snapshot belongs to another installation.");
    }
    return this.snapshotJournal.appendIf(snapshot, (entries) => {
      const previous = entries.at(-1)?.payload;
      if (!previous) return true;
      const elapsed = new Date(snapshot.observedAt).valueOf() - new Date(previous.observedAt).valueOf();
      return elapsed >= SNAPSHOT_MIN_INTERVAL_MS ||
        snapshotComparable(previous) !== snapshotComparable(snapshot);
    });
  }

  async latestSharedSubscription() {
    await this.prepare();
    const entries = await this.snapshotJournal.read();
    return entries.at(-1)?.payload ?? null;
  }

  async verifyAndRepair() {
    await this.prepare();
    const [turns, snapshots] = await Promise.all([
      this.turnJournal.verifyAndRepair(),
      this.snapshotJournal.verifyAndRepair(),
    ]);
    return { turns, snapshots };
  }
}
