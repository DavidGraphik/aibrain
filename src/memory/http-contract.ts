import type { MemoryKind, MemoryStatus } from "@/memory/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.join("\0") === [...expected].sort().join("\0");
}

function boundedText(value: unknown, maximum: number) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maximum
    && !/\p{C}/u.test(value.replace(/[\t\n\r]/gu, ""));
}

export type CreateExplicitMemoryRequest = {
  explicit: true;
  kind: MemoryKind;
  content: string;
  sourceExcerpt: string;
  clientRequestId: string;
};

export function isCreateExplicitMemoryRequest(value: unknown): value is CreateExplicitMemoryRequest {
  if (!isRecord(value) || !hasExactKeys(value, [
    "explicit", "kind", "content", "sourceExcerpt", "clientRequestId",
  ])) return false;
  return value.explicit === true
    && (value.kind === "recollection" || value.kind === "decision")
    && boundedText(value.content, 32_000)
    && boundedText(value.sourceExcerpt, 4_000)
    && typeof value.clientRequestId === "string"
    && UUID_PATTERN.test(value.clientRequestId);
}

export type RevokeExplicitMemoryRequest = {
  explicit: true;
  reason: string;
  clientRequestId: string;
};

export function isRevokeExplicitMemoryRequest(value: unknown): value is RevokeExplicitMemoryRequest {
  if (!isRecord(value) || !hasExactKeys(value, ["explicit", "reason", "clientRequestId"])) {
    return false;
  }
  return value.explicit === true
    && boundedText(value.reason, 2_000)
    && typeof value.clientRequestId === "string"
    && UUID_PATTERN.test(value.clientRequestId);
}

export type MemoryListQuery = {
  status: MemoryStatus | "all";
  kind?: MemoryKind;
  limit: number;
};

export function parseMemoryListQuery(searchParams: URLSearchParams): MemoryListQuery | null {
  if ([...searchParams.keys()].some((key) => key !== "status" && key !== "kind" && key !== "limit")) {
    return null;
  }
  if (["status", "kind", "limit"].some((key) => searchParams.getAll(key).length > 1)) return null;
  const rawStatus = searchParams.get("status");
  const status = rawStatus ?? "active";
  if (status !== "active" && status !== "revoked" && status !== "all") return null;
  const rawKind = searchParams.get("kind");
  if (rawKind !== null && rawKind !== "recollection" && rawKind !== "decision") return null;
  const rawLimit = searchParams.get("limit");
  if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/u.test(rawLimit)) return null;
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > 100) return null;
  return {
    status,
    ...(rawKind === null ? {} : { kind: rawKind }),
    limit,
  };
}

export function isMemoryProjectId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isConfirmMemoryProposalRequest(value: unknown): value is {
  explicit: true; projectId: string; content: string; scope: "private" | "project" | "company";
} {
  return isRecord(value) && hasExactKeys(value, ["explicit", "projectId", "content", "scope"]) &&
    value.explicit === true && isMemoryProjectId(value.projectId) && boundedText(value.content, 32_000) &&
    (value.scope === "private" || value.scope === "project" || value.scope === "company");
}

export function isRejectMemoryProposalRequest(value: unknown): value is { explicit: true; projectId: string; reason: string } {
  return isRecord(value) && hasExactKeys(value, ["explicit", "projectId", "reason"]) && value.explicit === true &&
    isMemoryProjectId(value.projectId) && boundedText(value.reason, 2_000);
}

export function isUpdateGovernedMemoryRequest(value: unknown): value is { explicit: true; projectId: string; expectedRevision: number; content: string } {
  return isRecord(value) && hasExactKeys(value, ["explicit", "projectId", "expectedRevision", "content"]) && value.explicit === true &&
    isMemoryProjectId(value.projectId) && Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) >= 1 && boundedText(value.content, 32_000);
}

export function isDeleteGovernedMemoryRequest(value: unknown): value is { explicit: true; projectId: string; expectedRevision: number } {
  return isRecord(value) && hasExactKeys(value, ["explicit", "projectId", "expectedRevision"]) && value.explicit === true &&
    isMemoryProjectId(value.projectId) && Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) >= 1;
}

export const isRestoreGovernedMemoryRequest = isDeleteGovernedMemoryRequest;
