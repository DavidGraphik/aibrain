import {
  ValidationContext,
  defineVersionedSchema,
  expectArray,
  expectFiniteNumber,
  expectInteger,
  expectIsoDate,
  expectLiteral,
  expectOneOf,
  expectStrictRecord,
  expectString,
  type StorageSchema,
} from "@/storage";

const INSTALLATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DECIMAL_PATTERN = /^\d+$/;

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type TurnUsageRecord = {
  schemaVersion: 1;
  installationId: string;
  userId: string;
  projectId: string;
  threadId: string;
  turnId: string;
  status: "completed" | "error" | "stopped";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  firstTextMs: number | null;
  tokenUsage: TokenUsageBreakdown | null;
  tokenAttribution: "app_server_turn_event" | null;
};

export type ProviderRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type ProviderRateLimitBucket = {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: ProviderRateLimitWindow | null;
  secondary: ProviderRateLimitWindow | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
  spendControlReached: boolean | null;
  rateLimitReachedType: string | null;
};

export type ProviderTokenUsageSummary = {
  lifetimeTokens: string | null;
  peakDailyTokens: string | null;
  longestRunningTurnSec: string | null;
  currentStreakDays: string | null;
  longestStreakDays: string | null;
  dailyUsageBuckets: Array<{ startDate: string; tokens: string }>;
};

export type SharedSubscriptionSnapshot = {
  schemaVersion: 1;
  installationId: string;
  observedAt: string;
  scope: "shared_chatgpt_account";
  planType: string | null;
  rateLimitsAvailable: boolean;
  accountTokenUsageAvailable: boolean;
  rateLimits: ProviderRateLimitBucket[];
  accountTokenUsage: ProviderTokenUsageSummary | null;
};

export type UsageAggregate = {
  turns: number;
  completedTurns: number;
  errorTurns: number;
  stoppedTurns: number;
  activeDays: number;
  /** Sum of terminal turn durations persisted in the usage journal. */
  totalDurationMs: number;
  averageDurationMs: number | null;
  p95DurationMs: number | null;
  averageFirstTextMs: number | null;
  p95FirstTextMs: number | null;
  turnsWithTokenData: number;
  tokens: TokenUsageBreakdown;
};

export type PersonalUsageResponse = {
  schemaVersion: 1;
  scope: "personal";
  generatedAt: string;
  userId: string;
  internal: UsageAggregate;
  sharedSubscription: SharedSubscriptionSnapshot | null;
  notices: string[];
};

export type CompanyUsageMember = {
  userId: string;
  displayName: string;
  email: string;
  usage: UsageAggregate;
};

export type CompanyUsageResponse = {
  schemaVersion: 1;
  scope: "company";
  generatedAt: string;
  installationId: string;
  internal: UsageAggregate;
  members: CompanyUsageMember[];
  sharedSubscription: SharedSubscriptionSnapshot | null;
  notices: string[];
};

function nullableInteger(value: unknown, context: ValidationContext) {
  return value === null ? null : expectInteger(value, context, { minimum: 0 });
}

function nullableString(value: unknown, context: ValidationContext, maximum = 160) {
  return value === null
    ? null
    : expectString(value, context, { minLength: 1, maxLength: maximum });
}

function booleanValue(value: unknown, context: ValidationContext) {
  if (typeof value !== "boolean") context.fail("expected a boolean");
  return value;
}

function tokenBreakdown(value: unknown, context: ValidationContext): TokenUsageBreakdown {
  const record = expectStrictRecord(value, [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ], context);
  return {
    totalTokens: expectInteger(record.totalTokens, context.at("totalTokens"), { minimum: 0 }),
    inputTokens: expectInteger(record.inputTokens, context.at("inputTokens"), { minimum: 0 }),
    cachedInputTokens: expectInteger(record.cachedInputTokens, context.at("cachedInputTokens"), { minimum: 0 }),
    cacheWriteInputTokens: expectInteger(record.cacheWriteInputTokens, context.at("cacheWriteInputTokens"), { minimum: 0 }),
    outputTokens: expectInteger(record.outputTokens, context.at("outputTokens"), { minimum: 0 }),
    reasoningOutputTokens: expectInteger(record.reasoningOutputTokens, context.at("reasoningOutputTokens"), { minimum: 0 }),
  };
}

export const turnUsageRecordSchema = defineVersionedSchema<TurnUsageRecord>({
  name: "TurnUsageRecord",
  schemaVersion: 1,
  keys: [
    "installationId",
    "userId",
    "projectId",
    "threadId",
    "turnId",
    "status",
    "startedAt",
    "completedAt",
    "durationMs",
    "firstTextMs",
    "tokenUsage",
    "tokenAttribution",
  ],
  parse(record, context) {
    const parsed: TurnUsageRecord = {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      userId: expectString(record.userId, context.at("userId"), {
        minLength: 36,
        maxLength: 36,
        pattern: USER_ID_PATTERN,
      }),
      projectId: expectString(record.projectId, context.at("projectId"), {
        minLength: 1,
        maxLength: 256,
        pattern: OPAQUE_ID_PATTERN,
      }),
      threadId: expectString(record.threadId, context.at("threadId"), {
        minLength: 1,
        maxLength: 256,
        pattern: OPAQUE_ID_PATTERN,
      }),
      turnId: expectString(record.turnId, context.at("turnId"), {
        minLength: 1,
        maxLength: 256,
        pattern: OPAQUE_ID_PATTERN,
      }),
      status: expectOneOf(
        record.status,
        ["completed", "error", "stopped"] as const,
        context.at("status"),
      ),
      startedAt: expectIsoDate(record.startedAt, context.at("startedAt")),
      completedAt: expectIsoDate(record.completedAt, context.at("completedAt")),
      durationMs: expectInteger(record.durationMs, context.at("durationMs"), { minimum: 0 }),
      firstTextMs: nullableInteger(record.firstTextMs, context.at("firstTextMs")),
      tokenUsage: record.tokenUsage === null
        ? null
        : tokenBreakdown(record.tokenUsage, context.at("tokenUsage")),
      tokenAttribution: record.tokenAttribution === null
        ? null
        : expectLiteral(record.tokenAttribution, "app_server_turn_event", context.at("tokenAttribution")),
    };
    if (new Date(parsed.completedAt).valueOf() < new Date(parsed.startedAt).valueOf()) {
      context.at("completedAt").fail("must not be earlier than startedAt");
    }
    if ((parsed.tokenUsage === null) !== (parsed.tokenAttribution === null)) {
      context.at("tokenAttribution").fail("must be present exactly when tokenUsage is present");
    }
    return parsed;
  },
});

function rateLimitWindow(value: unknown, context: ValidationContext): ProviderRateLimitWindow {
  const record = expectStrictRecord(value, [
    "usedPercent",
    "windowDurationMins",
    "resetsAt",
  ], context);
  return {
    usedPercent: expectFiniteNumber(record.usedPercent, context.at("usedPercent"), {
      minimum: 0,
      maximum: 100,
    }),
    windowDurationMins: nullableInteger(record.windowDurationMins, context.at("windowDurationMins")),
    resetsAt: nullableInteger(record.resetsAt, context.at("resetsAt")),
  };
}

function rateLimitBucket(value: unknown, context: ValidationContext): ProviderRateLimitBucket {
  const record = expectStrictRecord(value, [
    "limitId",
    "limitName",
    "planType",
    "primary",
    "secondary",
    "credits",
    "individualLimit",
    "spendControlReached",
    "rateLimitReachedType",
  ], context);
  let credits: ProviderRateLimitBucket["credits"] = null;
  if (record.credits !== null) {
    const item = expectStrictRecord(record.credits, ["hasCredits", "unlimited", "balance"], context.at("credits"));
    credits = {
      hasCredits: booleanValue(item.hasCredits, context.at("credits").at("hasCredits")),
      unlimited: booleanValue(item.unlimited, context.at("credits").at("unlimited")),
      balance: nullableString(item.balance, context.at("credits").at("balance"), 80),
    };
  }
  let individualLimit: ProviderRateLimitBucket["individualLimit"] = null;
  if (record.individualLimit !== null) {
    const item = expectStrictRecord(
      record.individualLimit,
      ["limit", "used", "remainingPercent", "resetsAt"],
      context.at("individualLimit"),
    );
    individualLimit = {
      limit: expectString(item.limit, context.at("individualLimit").at("limit"), { minLength: 1, maxLength: 80 }),
      used: expectString(item.used, context.at("individualLimit").at("used"), { minLength: 1, maxLength: 80 }),
      remainingPercent: expectFiniteNumber(
        item.remainingPercent,
        context.at("individualLimit").at("remainingPercent"),
        { minimum: 0, maximum: 100 },
      ),
      resetsAt: expectInteger(item.resetsAt, context.at("individualLimit").at("resetsAt"), { minimum: 0 }),
    };
  }
  return {
    limitId: nullableString(record.limitId, context.at("limitId")),
    limitName: nullableString(record.limitName, context.at("limitName")),
    planType: nullableString(record.planType, context.at("planType")),
    primary: record.primary === null ? null : rateLimitWindow(record.primary, context.at("primary")),
    secondary: record.secondary === null ? null : rateLimitWindow(record.secondary, context.at("secondary")),
    credits,
    individualLimit,
    spendControlReached: record.spendControlReached === null
      ? null
      : booleanValue(record.spendControlReached, context.at("spendControlReached")),
    rateLimitReachedType: nullableString(record.rateLimitReachedType, context.at("rateLimitReachedType")),
  };
}

function decimal(value: unknown, context: ValidationContext) {
  return value === null
    ? null
    : expectString(value, context, { minLength: 1, maxLength: 40, pattern: DECIMAL_PATTERN });
}

function accountUsage(value: unknown, context: ValidationContext): ProviderTokenUsageSummary {
  const record = expectStrictRecord(value, [
    "lifetimeTokens",
    "peakDailyTokens",
    "longestRunningTurnSec",
    "currentStreakDays",
    "longestStreakDays",
    "dailyUsageBuckets",
  ], context);
  return {
    lifetimeTokens: decimal(record.lifetimeTokens, context.at("lifetimeTokens")),
    peakDailyTokens: decimal(record.peakDailyTokens, context.at("peakDailyTokens")),
    longestRunningTurnSec: decimal(record.longestRunningTurnSec, context.at("longestRunningTurnSec")),
    currentStreakDays: decimal(record.currentStreakDays, context.at("currentStreakDays")),
    longestStreakDays: decimal(record.longestStreakDays, context.at("longestStreakDays")),
    dailyUsageBuckets: expectArray(
      record.dailyUsageBuckets,
      context.at("dailyUsageBuckets"),
      (item, itemContext) => {
        const bucket = expectStrictRecord(item, ["startDate", "tokens"], itemContext);
        return {
          startDate: expectString(bucket.startDate, itemContext.at("startDate"), {
            minLength: 10,
            maxLength: 10,
            pattern: /^\d{4}-\d{2}-\d{2}$/,
          }),
          tokens: expectString(bucket.tokens, itemContext.at("tokens"), {
            minLength: 1,
            maxLength: 40,
            pattern: DECIMAL_PATTERN,
          }),
        };
      },
      { maxLength: 400 },
    ),
  };
}

export const sharedSubscriptionSnapshotSchema = defineVersionedSchema<SharedSubscriptionSnapshot>({
  name: "SharedSubscriptionSnapshot",
  schemaVersion: 1,
  keys: [
    "installationId",
    "observedAt",
    "scope",
    "planType",
    "rateLimitsAvailable",
    "accountTokenUsageAvailable",
    "rateLimits",
    "accountTokenUsage",
  ],
  parse(record, context) {
    const snapshot: SharedSubscriptionSnapshot = {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      observedAt: expectIsoDate(record.observedAt, context.at("observedAt")),
      scope: expectLiteral(record.scope, "shared_chatgpt_account", context.at("scope")),
      planType: nullableString(record.planType, context.at("planType")),
      rateLimitsAvailable: booleanValue(record.rateLimitsAvailable, context.at("rateLimitsAvailable")),
      accountTokenUsageAvailable: booleanValue(
        record.accountTokenUsageAvailable,
        context.at("accountTokenUsageAvailable"),
      ),
      rateLimits: expectArray(
        record.rateLimits,
        context.at("rateLimits"),
        rateLimitBucket,
        { maxLength: 32 },
      ),
      accountTokenUsage: record.accountTokenUsage === null
        ? null
        : accountUsage(record.accountTokenUsage, context.at("accountTokenUsage")),
    };
    if (snapshot.rateLimitsAvailable !== (snapshot.rateLimits.length > 0)) {
      context.at("rateLimitsAvailable").fail("must reflect whether rateLimits contains data");
    }
    if (snapshot.accountTokenUsageAvailable !== (snapshot.accountTokenUsage !== null)) {
      context.at("accountTokenUsageAvailable").fail("must reflect whether accountTokenUsage exists");
    }
    return snapshot;
  },
});

export const zeroTokenUsage = Object.freeze<TokenUsageBreakdown>({
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
});

function numberMetric(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Parses the public, turn-bound `thread/tokenUsage/updated` payload. */
export function parseTurnTokenUsage(value: unknown): TokenUsageBreakdown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tokenUsage = "tokenUsage" in value ? value.tokenUsage : null;
  if (!tokenUsage || typeof tokenUsage !== "object" || Array.isArray(tokenUsage) || !("last" in tokenUsage)) {
    return null;
  }
  const last = tokenUsage.last;
  if (!last || typeof last !== "object" || Array.isArray(last)) return null;
  const parsed = {
    totalTokens: numberMetric("totalTokens" in last ? last.totalTokens : null),
    inputTokens: numberMetric("inputTokens" in last ? last.inputTokens : null),
    cachedInputTokens: numberMetric("cachedInputTokens" in last ? last.cachedInputTokens : null),
    cacheWriteInputTokens: numberMetric("cacheWriteInputTokens" in last ? last.cacheWriteInputTokens : null),
    outputTokens: numberMetric("outputTokens" in last ? last.outputTokens : null),
    reasoningOutputTokens: numberMetric("reasoningOutputTokens" in last ? last.reasoningOutputTokens : null),
  };
  return Object.values(parsed).some((item) => item === null)
    ? null
    : parsed as TokenUsageBreakdown;
}

export const usageResponseSchemas = Object.freeze({
  turn: turnUsageRecordSchema,
  sharedSubscription: sharedSubscriptionSnapshotSchema,
}) satisfies Readonly<Record<string, StorageSchema<unknown>>>;
