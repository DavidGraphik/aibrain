import "server-only";

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { loadInstallationConfig } from "@/config/installation";
import { workerAppServerForUser } from "@/runtime/worker-runtime-service";
import {
  aggregateTurnUsage,
  FileUsageStore,
} from "@/usage/file-usage-store";
import {
  sharedSubscriptionSnapshotSchema,
  type CompanyUsageResponse,
  type PersonalUsageResponse,
  type ProviderRateLimitBucket,
  type ProviderRateLimitWindow,
  type ProviderTokenUsageSummary,
  type SharedSubscriptionSnapshot,
  type TokenUsageBreakdown,
  type TurnUsageRecord,
} from "@/usage/contracts";

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 160
    ? value
    : null;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function finitePercent(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : null;
}

function decimalString(value: unknown) {
  if (typeof value === "string" && /^\d+$/.test(value) && value.length <= 40) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function rateLimitWindow(value: unknown): ProviderRateLimitWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = finitePercent(value.usedPercent);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    windowDurationMins: nonNegativeInteger(value.windowDurationMins),
    resetsAt: nonNegativeInteger(value.resetsAt),
  };
}

function rateLimitBucket(value: unknown, fallbackLimitId: string | null): ProviderRateLimitBucket | null {
  if (!isRecord(value)) return null;
  const primary = rateLimitWindow(value.primary);
  const secondary = rateLimitWindow(value.secondary);
  const limitId = nullableString(value.limitId) ?? fallbackLimitId;
  let credits: ProviderRateLimitBucket["credits"] = null;
  if (isRecord(value.credits) &&
      typeof value.credits.hasCredits === "boolean" &&
      typeof value.credits.unlimited === "boolean") {
    const balance = value.credits.balance === null ? null : nullableString(value.credits.balance);
    if (value.credits.balance === null || balance !== null) {
      credits = {
        hasCredits: value.credits.hasCredits,
        unlimited: value.credits.unlimited,
        balance,
      };
    }
  }
  let individualLimit: ProviderRateLimitBucket["individualLimit"] = null;
  if (isRecord(value.individualLimit)) {
    const limit = nullableString(value.individualLimit.limit);
    const used = nullableString(value.individualLimit.used);
    const remainingPercent = finitePercent(value.individualLimit.remainingPercent);
    const resetsAt = nonNegativeInteger(value.individualLimit.resetsAt);
    if (limit && used && remainingPercent !== null && resetsAt !== null) {
      individualLimit = { limit, used, remainingPercent, resetsAt };
    }
  }
  if (!limitId && !primary && !secondary && !credits && !individualLimit) return null;
  return {
    limitId,
    limitName: nullableString(value.limitName),
    planType: nullableString(value.planType),
    primary,
    secondary,
    credits,
    individualLimit,
    spendControlReached: typeof value.spendControlReached === "boolean"
      ? value.spendControlReached
      : null,
    rateLimitReachedType: nullableString(value.rateLimitReachedType),
  };
}

export function parseProviderRateLimits(result: unknown) {
  if (!isRecord(result)) return [];
  const buckets = new Map<string, ProviderRateLimitBucket>();
  if (isRecord(result.rateLimitsByLimitId)) {
    for (const [limitId, value] of Object.entries(result.rateLimitsByLimitId)) {
      const parsed = rateLimitBucket(value, limitId);
      if (parsed) buckets.set(parsed.limitId ?? limitId, parsed);
    }
  }
  const legacy = rateLimitBucket(result.rateLimits, null);
  if (legacy) buckets.set(legacy.limitId ?? "primary", legacy);
  return [...buckets.values()].slice(0, 32);
}

export function parseProviderAccountUsage(result: unknown): ProviderTokenUsageSummary | null {
  if (!isRecord(result) || !isRecord(result.summary)) return null;
  const summary = result.summary;
  const dailyUsageBuckets = Array.isArray(result.dailyUsageBuckets)
    ? result.dailyUsageBuckets.flatMap((value) => {
        if (!isRecord(value) || typeof value.startDate !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(value.startDate)) return [];
        const tokens = decimalString(value.tokens);
        return tokens === null ? [] : [{ startDate: value.startDate, tokens }];
      }).slice(0, 400)
    : [];
  return {
    lifetimeTokens: decimalString(summary.lifetimeTokens),
    peakDailyTokens: decimalString(summary.peakDailyTokens),
    longestRunningTurnSec: decimalString(summary.longestRunningTurnSec),
    currentStreakDays: decimalString(summary.currentStreakDays),
    longestStreakDays: decimalString(summary.longestStreakDays),
    dailyUsageBuckets,
  };
}

function parsePlanType(accountResult: unknown, rateLimits: readonly ProviderRateLimitBucket[]) {
  if (isRecord(accountResult) && isRecord(accountResult.account)) {
    const planType = nullableString(accountResult.account.planType);
    if (planType) return planType;
  }
  return rateLimits.find((bucket) => bucket.planType)?.planType ?? null;
}

function notices(snapshot: SharedSubscriptionSnapshot | null) {
  const result = [
    "Les mètriques internes per empleat provenen només dels torns d’aquesta instal·lació.",
    "El percentatge i l’ús del proveïdor pertanyen al compte ChatGPT compartit; no s’atribueixen a cap empleat.",
  ];
  if (!snapshot?.rateLimitsAvailable) {
    result.push("El proveïdor no ha retornat cap finestra de límit; el percentatge del pla no està disponible.");
  }
  if (!snapshot?.accountTokenUsageAvailable) {
    result.push("El proveïdor no ha retornat l’històric global de tokens.");
  }
  return result;
}

async function usageStore() {
  const installation = await loadInstallationConfig();
  return {
    installation,
    store: new FileUsageStore({
      installationId: installation.installationId,
      dataRoot: installation.paths.dataRoot,
    }),
  };
}

export async function refreshSharedSubscriptionUsage(userId: string) {
  const { installation, store } = await usageStore();
  const runtime = await workerAppServerForUser(userId);
  const requestId = randomUUID();
  const [accountResult, rateLimitResult, accountUsageResult] = await Promise.all([
    runtime.client.request(
      "account/read",
      { refreshToken: false },
      `usage-account:${requestId}`,
      10_000,
    ).catch(() => null),
    runtime.client.request(
      "account/rateLimits/read",
      undefined,
      `usage-rate-limits:${requestId}`,
      10_000,
    ).catch(() => null),
    runtime.client.request(
      "account/usage/read",
      undefined,
      `usage-account-tokens:${requestId}`,
      10_000,
    ).catch(() => null),
  ]);
  const rateLimits = parseProviderRateLimits(rateLimitResult);
  const accountTokenUsage = parseProviderAccountUsage(accountUsageResult);
  const snapshot = sharedSubscriptionSnapshotSchema.parse({
    schemaVersion: 1,
    installationId: installation.installationId,
    observedAt: new Date().toISOString(),
    scope: "shared_chatgpt_account",
    planType: parsePlanType(accountResult, rateLimits),
    rateLimitsAvailable: rateLimits.length > 0,
    accountTokenUsageAvailable: accountTokenUsage !== null,
    rateLimits,
    accountTokenUsage,
  });
  await store.recordSharedSubscription(snapshot);
  return snapshot;
}

export type RecordTurnUsageInput = Omit<
  TurnUsageRecord,
  "schemaVersion" | "tokenAttribution"
>;

/**
 * Durable, idempotent hook for the chat/runtime pipeline.
 *
 * `tokenUsage` must only contain the turn-bound `last` breakdown from a
 * `thread/tokenUsage/updated` event whose threadId and turnId match this turn.
 * Never pass account-wide `account/usage/read` data here.
 */
export async function recordTurnUsage(input: RecordTurnUsageInput) {
  const { installation, store } = await usageStore();
  if (input.installationId !== installation.installationId) {
    throw new Error("Turn usage installation does not match the active installation.");
  }
  return store.recordTurn({
    schemaVersion: 1,
    ...input,
    tokenAttribution: input.tokenUsage ? "app_server_turn_event" : null,
  });
}

async function currentOrLatestSnapshot(userId: string) {
  const { store } = await usageStore();
  try {
    return await refreshSharedSubscriptionUsage(userId);
  } catch {
    return store.latestSharedSubscription();
  }
}

export async function personalUsageForUser(userId: string): Promise<PersonalUsageResponse> {
  const { store } = await usageStore();
  const [turns, sharedSubscription] = await Promise.all([
    store.listTurns(userId),
    currentOrLatestSnapshot(userId),
  ]);
  return {
    schemaVersion: 1,
    scope: "personal",
    generatedAt: new Date().toISOString(),
    userId,
    internal: aggregateTurnUsage(turns),
    sharedSubscription,
    notices: notices(sharedSubscription),
  };
}

export async function companyUsageForUser(requestingUserId: string): Promise<CompanyUsageResponse> {
  const { installation, store } = await usageStore();
  const [turns, sharedSubscription] = await Promise.all([
    store.listTurns(),
    currentOrLatestSnapshot(requestingUserId),
  ]);
  const grouped = new Map<string, TurnUsageRecord[]>();
  for (const turn of turns) {
    const records = grouped.get(turn.userId) ?? [];
    records.push(turn);
    grouped.set(turn.userId, records);
  }
  const users = new FileLocalUserStore(installation.paths.usersRoot);
  const provisionedUserIds = (await readdir(installation.paths.usersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && USER_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  const memberIds = [...new Set([...provisionedUserIds, ...grouped.keys()])];
  const members = (await Promise.all(memberIds.map(async (userId) => {
    const user = await users.read(userId);
    if (!user?.enabled) return null;
    return {
      userId,
      displayName: user.displayName,
      email: user.email,
      usage: aggregateTurnUsage(grouped.get(userId) ?? []),
    };
  }))).filter((member): member is NonNullable<typeof member> => member !== null);
  members.sort((left, right) => left.displayName.localeCompare(right.displayName));
  return {
    schemaVersion: 1,
    scope: "company",
    generatedAt: new Date().toISOString(),
    installationId: installation.installationId,
    internal: aggregateTurnUsage(turns),
    members,
    sharedSubscription,
    notices: notices(sharedSubscription),
  };
}

export type { TokenUsageBreakdown };
