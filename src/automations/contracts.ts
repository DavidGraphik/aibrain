export const AUTOMATION_TIME_ZONES = [
  "Europe/Madrid",
  "UTC",
  "Atlantic/Canary",
] as const;

export type AutomationTimeZone = string;
export type AutomationState = "active" | "paused" | "completed";
export type AutomationRunStatus = "running" | "succeeded" | "failed";

export type AutomationAudience = {
  /** Group membership is resolved on every authorized read and delivery. */
  membershipPolicy: "current";
  userIds: string[];
  groupIds: string[];
};

export type AutomationSchedule =
  | { kind: "external" }
  | { kind: "interval"; minutes: number; anchorAt: string; startAt?: string; window?: { weekdays: number[]; startHour: number; endHour: number } }
  | { kind: "once"; runAt: string }
  | { kind: "daily"; hour: number; minute: number; startAt?: string }
  | { kind: "monthly"; months: number[]; day: number; hour: number; minute: number; startAt?: string }
  | { kind: "weekly"; weekdays: number[]; hour: number; minute: number; intervalWeeks?: 2; anchorDate?: string; startAt?: string };

export type AutomationAllowedEffect = "attio-task" | "mail-draft" | "attio-note";
export type AutomationEffectGrant = {
  schemaVersion: 1;
  installationId: string;
  userId: string;
  projectId: string;
  sourceThreadId: string;
  sourceTurnId: string;
  sourceMessage: string;
  requestHash: string;
  actionPromptHash: string;
};

export type AutomationExecutionContext = {
  /** Absent on legacy tasks: scheduled execution remains read-only. */
  allowedEffects?: AutomationAllowedEffect[];
  /** Issued only by the server during an authenticated chat creation. */
  effectGrant?: AutomationEffectGrant;
  /** Scheduled work always requests live web search and fails closed if the
   * current user or runtime no longer authorizes it. */
  webSearch: true;
  /** Effective managed skills and connected catalog resources are resolved
   * again for the owner immediately before every run. */
  inheritAuthorizedSkills: true;
  inheritAuthorizedConnectors: true;
};

export const DEFAULT_AUTOMATION_EXECUTION_CONTEXT: AutomationExecutionContext = {
  webSearch: true,
  inheritAuthorizedSkills: true,
  inheritAuthorizedConnectors: true,
};

export type AutomationLease = {
  runKey: string;
  ownerId: string;
  /** Changes for every claim, so an expired process cannot settle a newer claim. */
  fenceToken: string;
  scheduledFor: string;
  expiresAt: string;
};

export type AutomationTask = {
  schemaVersion: 1;
  id: string;
  installationId: string;
  /** The creator owns lifecycle changes but is not implicitly a recipient. */
  userId: string;
  audience: AutomationAudience;
  name: string;
  prompt: string;
  projectId: string;
  projectName: string;
  timeZone: AutomationTimeZone;
  schedule: AutomationSchedule;
  executionContext: AutomationExecutionContext;
  /** Operator-controlled preparation gate; never accepted from public patches. */
  preparationBlock?: string | null;
  state: AutomationState;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: Exclude<AutomationRunStatus, "running"> | null;
  lastRunError: string | null;
  /** Retry retains the same occurrence and its deterministic idempotency key. */
  retryAt: string | null;
  /** A manual occurrence is independent from the recurring schedule and its
   * request id is the durable exactly-once key for repeated HTTP requests. */
  manualRun: { requestId: string; scheduledFor: string } | null;
  /** A soft-deleted task stays available to the worker only long enough to
   * fence and record an in-flight turn. It is never returned to its owner. */
  deletedAt: string | null;
  /** A pause/delete requested during a lease aborts the turn cooperatively. */
  cancellationRequestedAt: string | null;
  lease: AutomationLease | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRun = {
  schemaVersion: 1;
  runKey: string;
  taskId: string;
  installationId: string;
  userId: string;
  scheduledFor: string;
  status: AutomationRunStatus;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  threadId: string | null;
  error: string | null;
};

/** Read-only history projection; interruption is proven by a successor attempt. */
export type AutomationRunHistory = Omit<AutomationRun, "status"> & {
  status: AutomationRunStatus | "interrupted";
  recoveredByAttempt?: number;
  recoveredAt?: string;
};

export type AutomationTaskInput = {
  name: string;
  prompt: string;
  projectId: string;
  projectName: string;
  timeZone: string;
  schedule: AutomationSchedule;
  executionContext?: AutomationExecutionContext;
  /** Omitted only by legacy clients; the server defaults it to the owner. */
  audience?: AutomationAudience;
};

export type AutomationTaskPatch = Partial<AutomationTaskInput> & {
  state?: "active" | "paused";
};

export type AutomationSnapshot = {
  schemaVersion: 1;
  tasks: AutomationTask[];
};

export type AutomationTaskView = AutomationTask & {
  owner: { userId: string; name: string };
  access: {
    canManage: boolean;
    canViewResults: boolean;
  };
};

export type AutomationAudienceDirectory = {
  membershipPolicy: "current";
  currentUserId: string;
  users: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function isAutomationSchedule(value: unknown): value is AutomationSchedule {
  if (!isRecord(value)) return false;
  if (value.kind === "external") return Object.keys(value).length === 1;
  const recurring = ["interval", "daily", "weekly", "monthly"].includes(String(value.kind));
  if (recurring && "startAt" in value && !isIsoDate(value.startAt)) return false;
  const startKeys = recurring && "startAt" in value ? 1 : 0;
  if (value.kind === "interval") {
    const window = value.window;
    const validWindow = window === undefined || isRecord(window) && Object.keys(window).length === 3 &&
      Array.isArray(window.weekdays) && window.weekdays.length > 0 && window.weekdays.length <= 7 &&
      new Set(window.weekdays).size === window.weekdays.length && window.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6) &&
      Number.isInteger(window.startHour) && Number(window.startHour) >= 0 && Number(window.startHour) <= 23 &&
      Number.isInteger(window.endHour) && Number(window.endHour) > Number(window.startHour) && Number(window.endHour) <= 24;
    return Object.keys(value).length === (window === undefined ? 3 : 4) + startKeys && validWindow &&
      Number.isSafeInteger(value.minutes) && Number(value.minutes) >= 30 && Number(value.minutes) <= 10080 && isIsoDate(value.anchorAt);
  }
  if (value.kind === "once") return Object.keys(value).length === 2 && isIsoDate(value.runAt);
  const hasTime = Number.isInteger(value.hour) && Number(value.hour) >= 0 && Number(value.hour) <= 23 &&
    Number.isInteger(value.minute) && Number(value.minute) >= 0 && Number(value.minute) <= 59;
  if (value.kind === "daily") return Object.keys(value).length === 3 + startKeys && hasTime;
  if (value.kind === "monthly") return Object.keys(value).length === (value.startAt === undefined ? 5 : 6) && (value.startAt === undefined || isIsoDate(value.startAt)) && hasTime &&
    Number.isInteger(value.day) && Number(value.day) >= 1 && Number(value.day) <= 31 &&
    Array.isArray(value.months) && value.months.length > 0 && value.months.length <= 12 &&
    new Set(value.months).size === value.months.length && value.months.every(month => Number.isInteger(month) && month >= 1 && month <= 12);
  const fortnightly = value.intervalWeeks === 2 && typeof value.anchorDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.anchorDate) && Number.isFinite(Date.parse(value.anchorDate)) && new Date(value.anchorDate).toISOString().slice(0,10) === value.anchorDate;
  if (value.kind !== "weekly" || !(Object.keys(value).length === 4 + startKeys && value.intervalWeeks === undefined && value.anchorDate === undefined || Object.keys(value).length === 6 + startKeys && fortnightly) || !hasTime ||
    !Array.isArray(value.weekdays) || value.weekdays.length === 0 || value.weekdays.length > 7) return false;
  return new Set(value.weekdays).size === value.weekdays.length &&
    value.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

export function isAutomationAudience(value: unknown): value is AutomationAudience {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.membershipPolicy !== "current" ||
    !Array.isArray(value.userIds) || !Array.isArray(value.groupIds) ||
    value.userIds.length > 200 || value.groupIds.length > 200 ||
    value.userIds.length + value.groupIds.length === 0 ||
    !value.userIds.every((id) => typeof id === "string" && UUID.test(id)) ||
    !value.groupIds.every((id) => typeof id === "string" && UUID.test(id))) return false;
  return new Set(value.userIds).size === value.userIds.length &&
    new Set(value.groupIds).size === value.groupIds.length;
}

export function isAutomationExecutionContext(value: unknown): value is AutomationExecutionContext {
  if (!isRecord(value) || Object.keys(value).some(key => !["webSearch", "inheritAuthorizedSkills", "inheritAuthorizedConnectors", "allowedEffects", "effectGrant"].includes(key)) ||
    value.webSearch !== true || value.inheritAuthorizedSkills !== true || value.inheritAuthorizedConnectors !== true) return false;
  if (value.allowedEffects === undefined) return value.effectGrant === undefined;
  if (!Array.isArray(value.allowedEffects) || value.allowedEffects.length > 3 || new Set(value.allowedEffects).size !== value.allowedEffects.length ||
    value.allowedEffects.some(effect => effect !== "attio-task" && effect !== "mail-draft" && effect !== "attio-note")) return false;
  if (!value.allowedEffects.length) return value.effectGrant === undefined;
  const grant = value.effectGrant;
  return isRecord(grant) && Object.keys(grant).length === 9 && grant.schemaVersion === 1 &&
    typeof grant.installationId === "string" && /^[a-z0-9-]{2,63}$/u.test(grant.installationId) &&
    ["userId", "projectId", "sourceThreadId", "sourceTurnId"].every(key => typeof grant[key] === "string" && UUID.test(grant[key] as string)) &&
    typeof grant.sourceMessage === "string" && grant.sourceMessage.trim().length > 0 && grant.sourceMessage.length <= 20_000 &&
    typeof grant.requestHash === "string" && /^[a-f0-9]{64}$/u.test(grant.requestHash) &&
    typeof grant.actionPromptHash === "string" && /^[a-f0-9]{64}$/u.test(grant.actionPromptHash);
}

export function parseAutomationInput(value: unknown): AutomationTaskInput | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const projectId = typeof value.projectId === "string" ? value.projectId : "";
  const projectName = typeof value.projectName === "string" ? value.projectName.trim() : "";
  if (!name || name.length > 100 || !prompt || prompt.length > 20_000 ||
    !/^[0-9a-f-]{36}$/i.test(projectId) || !projectName || projectName.length > 100 ||
    !isValidTimeZone(value.timeZone) || !isAutomationSchedule(value.schedule) || value.schedule.kind === "external" ||
    ("executionContext" in value && (!isAutomationExecutionContext(value.executionContext) || Boolean(value.executionContext.allowedEffects?.length) || value.executionContext.effectGrant !== undefined)) ||
    ("audience" in value && !isAutomationAudience(value.audience))) return null;
  return {
    name,
    prompt,
    projectId,
    projectName,
    timeZone: value.timeZone,
    schedule: value.schedule,
    executionContext: isAutomationExecutionContext(value.executionContext)
      ? value.executionContext : DEFAULT_AUTOMATION_EXECUTION_CONTEXT,
    ...(isAutomationAudience(value.audience) ? { audience: value.audience } : {}),
  };
}

export function parseAutomationPatch(value: unknown): AutomationTaskPatch | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(["name", "prompt", "projectId", "projectName", "timeZone", "schedule", "state", "audience"]);
  if (Object.keys(value).length === 0 || Object.keys(value).some((key) => !allowed.has(key))) return null;
  const patch: AutomationTaskPatch = {};
  if ("name" in value) {
    if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 100) return null;
    patch.name = value.name.trim();
  }
  if ("prompt" in value) {
    if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.trim().length > 20_000) return null;
    patch.prompt = value.prompt.trim();
  }
  if ("projectId" in value) {
    if (typeof value.projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.projectId)) return null;
    patch.projectId = value.projectId;
  }
  if ("projectName" in value) {
    if (typeof value.projectName !== "string" || !value.projectName.trim() || value.projectName.trim().length > 100) return null;
    patch.projectName = value.projectName.trim();
  }
  if ("timeZone" in value) {
    if (!isValidTimeZone(value.timeZone)) return null;
    patch.timeZone = value.timeZone;
  }
  if ("schedule" in value) {
    if (!isAutomationSchedule(value.schedule) || value.schedule.kind === "external") return null;
    patch.schedule = value.schedule;
  }
  if ("audience" in value) {
    if (!isAutomationAudience(value.audience)) return null;
    patch.audience = value.audience;
  }
  if ("state" in value) {
    if (value.state !== "active" && value.state !== "paused") return null;
    patch.state = value.state;
  }
  return patch;
}
