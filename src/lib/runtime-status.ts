export type RuntimeReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type RuntimeModelOption = {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
  inputModalities: ("text" | "image" | "audio")[];
  supportedReasoningEfforts: RuntimeReasoningEffort[];
  defaultReasoningEffort: RuntimeReasoningEffort | null;
  supportsPersonality: boolean;
};

export type RuntimeSkillOption = {
  id: string;
  label: string;
  description: string;
};

export type RuntimeStatus = {
  tenantId: string;
  projectId: string | null;
  projectName: string;
  mode: "demo" | "codex";
  codex: "checking" | "connected" | "unavailable" | "disabled";
  isolated: boolean;
  ready: boolean;
  authenticationRequired?: boolean;
  authMode: "chatgpt" | "apiKey" | "amazonBedrock" | null;
  planType: string | null;
  processWarm: boolean;
  rateLimit: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  usage: {
    lifetimeTokens: number | null;
    currentStreakDays: number | null;
    longestRunningTurnSec: number | null;
  } | null;
  workspaceName: string;
  model: string | null;
  approvalPolicy: "never" | "on-request";
  sandbox: "read-only" | "workspace-write";
  models: RuntimeModelOption[];
  skills: RuntimeSkillOption[];
  capabilities: {
    webSearch: boolean;
    imageInput: boolean;
    imageGeneration: boolean;
  };
};

export const initialRuntimeStatus: RuntimeStatus = {
  tenantId: "",
  projectId: null,
  projectName: "Proyecto",
  mode: "codex",
  codex: "checking",
  isolated: false,
  ready: false,
  authMode: null,
  planType: null,
  processWarm: false,
  rateLimit: null,
  usage: null,
  workspaceName: "workspace",
  model: null,
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  models: [],
  skills: [],
  capabilities: { webSearch: false, imageInput: false, imageGeneration: false },
};

export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  if (!value || typeof value !== "object") return false;
  return (
    "tenantId" in value &&
    typeof value.tenantId === "string" &&
    "projectId" in value &&
    (value.projectId === null || typeof value.projectId === "string") &&
    "projectName" in value &&
    typeof value.projectName === "string" &&
    "mode" in value &&
    (value.mode === "demo" || value.mode === "codex") &&
    "codex" in value &&
    (value.codex === "checking" ||
      value.codex === "connected" ||
      value.codex === "unavailable" ||
      value.codex === "disabled") &&
    "isolated" in value &&
    typeof value.isolated === "boolean" &&
    "ready" in value &&
    typeof value.ready === "boolean" &&
    (!("authenticationRequired" in value) || typeof value.authenticationRequired === "boolean") &&
    "authMode" in value &&
    (value.authMode === null || value.authMode === "chatgpt" || value.authMode === "apiKey" || value.authMode === "amazonBedrock") &&
    "planType" in value &&
    (value.planType === null || typeof value.planType === "string") &&
    "processWarm" in value &&
    typeof value.processWarm === "boolean" &&
    "rateLimit" in value &&
    (value.rateLimit === null || Boolean(value.rateLimit && typeof value.rateLimit === "object")) &&
    "usage" in value &&
    (value.usage === null || Boolean(value.usage && typeof value.usage === "object")) &&
    "workspaceName" in value &&
    typeof value.workspaceName === "string" &&
    "model" in value &&
    (value.model === null || typeof value.model === "string") &&
    "approvalPolicy" in value &&
    (value.approvalPolicy === "never" || value.approvalPolicy === "on-request") &&
    "sandbox" in value &&
    (value.sandbox === "read-only" || value.sandbox === "workspace-write") &&
    "models" in value &&
    Array.isArray(value.models) &&
    value.models.every((model) => Boolean(model && typeof model === "object" && "id" in model && typeof model.id === "string" && "label" in model && typeof model.label === "string")) &&
    "skills" in value &&
    Array.isArray(value.skills) &&
    value.skills.every((skill) => Boolean(skill && typeof skill === "object" && "id" in skill && typeof skill.id === "string" && "label" in skill && typeof skill.label === "string")) &&
    "capabilities" in value &&
    Boolean(value.capabilities && typeof value.capabilities === "object")
  );
}
