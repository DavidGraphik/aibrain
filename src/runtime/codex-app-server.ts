import { createHash } from "node:crypto";
import type {
  ActivityFileChange,
  ActivityItem,
  ApprovalDecision,
  ApprovalItem,
  ChatRequest,
  ChatStreamEvent,
  PlanStep,
  ToolResult,
  TurnSource,
} from "@/lib/chat-contract";
import {
  publicActivityText,
  publicCommandTitle,
  publicProjectPath,
  publicToolName,
  publicToolOutput,
} from "@/ui/public-activity";
import type { ApprovalRequestType } from "@/runtime/approval-store";
import type { RuntimeConfig } from "@/runtime/config";
import type {
  RuntimeModelOption,
  RuntimeReasoningEffort,
  RuntimeSkillOption,
} from "@/lib/runtime-status";

export type LegacyServerRequest = {
  kind: "serverRequest";
  id: number | string;
  method: string;
  params: unknown;
};
type ServerRequest = LegacyServerRequest;
export type CodexTurnEvent = ChatStreamEvent | {
  type: "runtimeThread";
  threadToken: string;
};

export type CodexConnection = {
  connected: boolean;
  authenticationRequired?: boolean;
  authMode: "chatgpt" | "apiKey" | "amazonBedrock" | null;
  planType: string | null;
  models: RuntimeModelOption[];
  skills: RuntimeSkillOption[];
  webSearch: boolean;
  imageGeneration: boolean;
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
};

export class RuntimeNotReadyError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

export function extractThreadId(result: unknown) {
  if (!isRecord(result) || !isRecord(result.thread)) return null;
  return typeof result.thread.id === "string" ? result.thread.id : null;
}

export function extractTurnId(result: unknown) {
  if (!isRecord(result) || !isRecord(result.turn)) return null;
  return typeof result.turn.id === "string" ? result.turn.id : null;
}

export function parseAccount(result: unknown): CodexConnection {
  if (!isRecord(result) || !isRecord(result.account)) {
    return { connected: false,
      authenticationRequired: isRecord(result) && result.account === null && result.requiresOpenaiAuth === true,
      authMode: null, planType: null, models: [], skills: [], webSearch: false, imageGeneration: false, processWarm: false, rateLimit: null, usage: null };
  }

  const account = result.account;
  if (account.type === "chatgpt") {
    return {
      connected: true,
      authMode: "chatgpt",
      planType: typeof account.planType === "string" ? account.planType : null,
      models: [], skills: [], webSearch: false, imageGeneration: false, processWarm: false, rateLimit: null, usage: null,
    };
  }
  if (account.type === "apiKey") {
    // account/read explicitly reports the API-key mode after loading the
    // worker's private credential. Like ChatGPT mode this is account readiness,
    // not proof of quota, model entitlement or a successful paid request.
    return { connected: true, authMode: "apiKey", planType: null, models: [], skills: [], webSearch: false, imageGeneration: false, processWarm: false, rateLimit: null, usage: null };
  }
  if (account.type === "amazonBedrock") {
    return { connected: false, authMode: "amazonBedrock", planType: null, models: [], skills: [], webSearch: false, imageGeneration: false, processWarm: false, rateLimit: null, usage: null };
  }

  return { connected: false, authMode: null, planType: null, models: [], skills: [], webSearch: false, imageGeneration: false, processWarm: false, rateLimit: null, usage: null };
}

const reasoningEfforts = new Set<RuntimeReasoningEffort>([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

function reasoningEffort(value: unknown): RuntimeReasoningEffort | null {
  return typeof value === "string" && reasoningEfforts.has(value as RuntimeReasoningEffort)
    ? value as RuntimeReasoningEffort
    : null;
}

export function parseModels(result: unknown): RuntimeModelOption[] {
  if (!isRecord(result) || !Array.isArray(result.data)) return [];
  return result.data.flatMap((model) => {
    if (!isRecord(model) || typeof model.model !== "string" || model.hidden === true) return [];
    const modalities = Array.isArray(model.inputModalities)
      ? model.inputModalities.filter((item): item is "text" | "image" | "audio" => item === "text" || item === "image" || item === "audio")
      : ["text" as const];
    return [{
      id: model.model,
      label: typeof model.displayName === "string" ? model.displayName : model.model,
      description: typeof model.description === "string" ? model.description : "Model disponible al runtime",
      isDefault: model.isDefault === true,
      inputModalities: modalities,
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.flatMap((option) => {
            const value = isRecord(option) ? option.reasoningEffort : option;
            const parsed = reasoningEffort(value);
            return parsed ? [parsed] : [];
          })
        : [],
      defaultReasoningEffort: reasoningEffort(model.defaultReasoningEffort),
      supportsPersonality: model.supportsPersonality === true,
    }];
  }).slice(0, 24);
}

export type ResolvedSkill = RuntimeSkillOption & { path: string };

export function parseSkills(result: unknown): ResolvedSkill[] {
  if (!isRecord(result) || !Array.isArray(result.data)) return [];
  const resolved: ResolvedSkill[] = [];
  for (const entry of result.data) {
    if (!isRecord(entry) || !Array.isArray(entry.skills)) continue;
    for (const skill of entry.skills) {
      if (!isRecord(skill) || skill.enabled !== true || typeof skill.name !== "string" || typeof skill.path !== "string") continue;
      resolved.push({
        id: skill.name,
        label: isRecord(skill.interface) && typeof skill.interface.displayName === "string" ? skill.interface.displayName : skill.name,
        description: typeof skill.description === "string" ? skill.description : "Skill del workspace",
        path: skill.path,
      });
    }
  }
  return [...new Map(resolved.map((skill) => [skill.id, skill])).values()].slice(0, 80);
}

export function parseRateLimit(result: unknown): CodexConnection["rateLimit"] {
  if (!isRecord(result) || !isRecord(result.rateLimits) || !isRecord(result.rateLimits.primary)) return null;
  const primary = result.rateLimits.primary;
  if (typeof primary.usedPercent !== "number") return null;
  return {
    usedPercent: Math.max(0, Math.min(100, primary.usedPercent)),
    windowDurationMins: typeof primary.windowDurationMins === "number" ? primary.windowDurationMins : null,
    resetsAt: typeof primary.resetsAt === "number" ? primary.resetsAt : null,
  };
}

export function parseUsage(result: unknown): CodexConnection["usage"] {
  if (!isRecord(result) || !isRecord(result.summary)) return null;
  const summary = result.summary;
  const metric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    lifetimeTokens: metric(summary.lifetimeTokens),
    currentStreakDays: metric(summary.currentStreakDays),
    longestRunningTurnSec: metric(summary.longestRunningTurnSec),
  };
}

function statusFromItem(value: unknown, completed: boolean): ActivityItem["status"] {
  if (value === "failed") return "failed";
  if (value === "declined") return "stopped";
  if (value === "completed" || completed) return "complete";
  return "running";
}

function joinedStrings(value: unknown) {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings.join("\n") : null;
}

function fileActivityChanges(changes: unknown): ActivityItem["files"] {
  if (!Array.isArray(changes)) return undefined;
  const files = changes.flatMap((change) => {
    if (
      !isRecord(change) ||
      typeof change.path !== "string" ||
      !isRecord(change.kind)
    ) return [];
    const publicPath = publicProjectPath(change.path);
    if (!publicPath) return [];
    const type = change.kind.type;
    if (type !== "add" && type !== "update" && type !== "delete") return [];
    return [{ path: publicPath, change: type } satisfies ActivityFileChange];
  });
  return files.length > 0 ? files : undefined;
}

function fileChangeSummary(changes: unknown) {
  const files = fileActivityChanges(changes);
  return files?.map((file) => file.path).join(", ") ?? null;
}

function compactRuntimeText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const compact = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "\uFFFD")
    .replace(/\s+/gu, " ")
    .trim();
  return compact ? compact.slice(0, maximum) : null;
}

function runtimeUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function runtimeDate(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function sourceId(itemId: string, url: string) {
  return `source-${createHash("sha256").update(`${itemId}\0${url}`).digest("hex").slice(0, 32)}`;
}

function sourceFromRecord(value: unknown, itemId: string, kind: TurnSource["kind"]): TurnSource | null {
  if (!isRecord(value)) return null;
  const parsedUrl = runtimeUrl(value.url ?? value.link ?? value.uri);
  if (!parsedUrl) return null;
  const title = compactRuntimeText(value.title ?? value.name, 240) ?? parsedUrl.hostname;
  const snippet = compactRuntimeText(
    value.snippet ?? value.excerpt ?? value.description ?? value.text,
    2_000,
  );
  const publishedAt = runtimeDate(
    value.publishedAt ?? value.published_at ?? value.publicationDate ?? value.date,
  );
  return {
    id: sourceId(itemId, parsedUrl.href),
    kind,
    title,
    url: parsedUrl.href,
    domain: parsedUrl.hostname,
    snippet,
    publishedAt,
  };
}

function candidateRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord).slice(0, 100);
  if (!isRecord(value)) return [];
  for (const key of ["results", "items", "sources", "data"]) {
    if (Array.isArray(value[key])) return value[key].filter(isRecord).slice(0, 100);
  }
  return [value];
}

function parsedJson(value: unknown) {
  if (typeof value !== "string" || value.length > 100_000) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Extracts only source metadata that the runtime actually supplied. */
export function itemSources(params: unknown): TurnSource[] {
  if (!isRecord(params) || !isRecord(params.item) || typeof params.item.id !== "string") return [];
  const item = params.item;
  const itemId = String(item.id);
  const records: Record<string, unknown>[] = [];
  let kind: TurnSource["kind"] = "app";
  if (item.type === "webSearch") {
    kind = "web";
    records.push(...candidateRecords(item.results));
    if (isRecord(item.action) && item.action.type === "openPage" && runtimeUrl(item.action.url)) {
      records.push({ url: item.action.url });
    }
  } else if (item.type === "mcpToolCall" && isRecord(item.result)) {
    records.push(...candidateRecords(item.result.structuredContent));
    if (Array.isArray(item.result.content)) {
      for (const content of item.result.content) {
        if (!isRecord(content)) continue;
        records.push(content);
        if (isRecord(content.resource)) records.push(content.resource);
      }
    }
  } else if (item.type === "dynamicToolCall" && Array.isArray(item.contentItems)) {
    kind = item.namespace === "aibrain_browser" ? "web" : "app";
    for (const content of item.contentItems) {
      if (!isRecord(content) || content.type !== "inputText") continue;
      records.push(...candidateRecords(parsedJson(content.text)));
    }
  } else {
    return [];
  }
  const unique = new Map<string, TurnSource>();
  for (const record of records) {
    const source = sourceFromRecord(record, itemId, kind);
    if (source?.url) unique.set(source.url, source);
  }
  return [...unique.values()].slice(0, 100);
}

export function safeRuntimeOutput(value: unknown) {
  let output: string;
  if (typeof value === "string") output = value;
  else if (value === null || value === undefined) return null;
  else {
    try {
      output = JSON.stringify(value, null, 2);
    } catch {
      return null;
    }
  }
  return output
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "\uFFFD")
    .slice(0, 64_000);
}

function mcpOutput(result: unknown) {
  if (!isRecord(result)) return null;
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const entry of result.content) {
      if (isRecord(entry) && typeof entry.text === "string") parts.push(entry.text);
    }
  }
  if (parts.length > 0) return safeRuntimeOutput(parts.join("\n\n"));
  return safeRuntimeOutput(result.structuredContent);
}

function toolResultStatus(item: Record<string, unknown>, completed: boolean): ToolResult["status"] {
  if (item.status === "failed" || item.success === false) return "failed";
  if (item.status === "declined") return "stopped";
  if (item.status === "completed" || completed) return "complete";
  return "running";
}

function itemObservedAt(params: Record<string, unknown>, fallback: string) {
  const timestamp = params.completedAtMs ?? params.startedAtMs;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return fallback;
}

/** Projects one reviewable tool result without interpreting assistant prose as tool output. */
export function itemToolResult(
  params: unknown,
  completed: boolean,
  observedAt: string,
): ToolResult | null {
  if (!isRecord(params) || !isRecord(params.item)) return null;
  const item = params.item;
  if (typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.id)) return null;
  const sources = itemSources(params);
  const common = {
    id: item.id,
    status: toolResultStatus(item, completed),
    sourceIds: sources.map((source) => source.id),
    createdAt: itemObservedAt(params, observedAt),
  };
  if (item.type === "commandExecution") {
    const running = toolResultStatus(item, completed) === "running";
    return {
      ...common,
      kind: "command",
      title: publicCommandTitle(item.command, running),
      summary: typeof item.exitCode === "number" ? `Código de salida ${item.exitCode}` : null,
      output: publicToolOutput(item.aggregatedOutput),
    };
  }
  if (item.type === "fileChange") {
    const paths = fileChangeSummary(item.changes);
    return {
      ...common,
      kind: "file",
      title: "Cambios en archivos",
      summary: compactRuntimeText(paths, 4_000),
      output: null,
    };
  }
  if (item.type === "webSearch") {
    const query = compactRuntimeText(item.query, 240);
    return {
      ...common,
      kind: "web",
      title: query ? `Búsqueda: ${query}` : "Búsqueda web",
      summary: sources.length ? `${sources.length} ${sources.length === 1 ? "fuente consultada" : "fuentes consultadas"}` : "Sin fuentes enlazables en los metadatos",
      output: null,
    };
  }
  if (item.type === "mcpToolCall") {
    const appContext = isRecord(item.appContext) ? item.appContext : null;
    const app = publicToolName(appContext?.appName, "");
    const tool = publicToolName(appContext?.actionName ?? item.tool);
    const error = isRecord(item.error) ? publicActivityText(item.error.message, 4_000) : null;
    return {
      ...common,
      kind: "app",
      title: app ? `${app} · ${tool}` : tool,
      summary: error,
      output: publicToolOutput(mcpOutput(item.result)),
    };
  }
  if (item.type === "dynamicToolCall") {
    const browser = item.namespace === "aibrain_browser";
    const content = Array.isArray(item.contentItems)
      ? item.contentItems.flatMap((entry) => isRecord(entry) && entry.type === "inputText" && typeof entry.text === "string" ? [entry.text] : [])
      : [];
    return {
      ...common,
      kind: browser ? "browser" : "app",
      title: `${publicToolName(item.namespace, browser ? "Navegador" : "Herramienta")} · ${publicToolName(item.tool, "Acción")}`,
      summary: null,
      output: content.length ? publicToolOutput(content.join("\n\n")) : null,
    };
  }
  return null;
}

export function itemActivity(params: unknown, completed: boolean): ActivityItem | null {
  if (!isRecord(params) || !isRecord(params.item)) return null;
  const item = params.item;
  if (typeof item.id !== "string" || typeof item.type !== "string") return null;

  const status = statusFromItem(item.status, completed);

  if (item.type === "commandExecution") {
    return {
      id: item.id,
      kind: "command",
      label: status === "running" ? "Executant una ordre" : "Ordre executada",
      detail: publicCommandTitle(item.command, status === "running"),
      ...(typeof item.aggregatedOutput === "string"
        ? { output: publicToolOutput(item.aggregatedOutput) ?? "" }
        : {}),
      status,
    };
  }

  if (item.type === "fileChange") {
    const files = fileActivityChanges(item.changes);
    return {
      id: item.id,
      kind: "file",
      label: status === "running" ? "Preparant canvis" : "Canvis de fitxers",
      ...(files ? { files } : {}),
      ...(fileChangeSummary(item.changes)
        ? { detail: fileChangeSummary(item.changes) ?? undefined }
        : {}),
      status,
    };
  }

  if (item.type === "mcpToolCall") {
    const appContext = isRecord(item.appContext) ? item.appContext : null;
    const tool = publicToolName(appContext?.appName ?? item.tool);
    return {
      id: item.id,
      kind: "tool",
      label: status === "running" ? `Utilitzant ${tool}` : `${tool} completat`,
      status,
    };
  }

  if (item.type === "dynamicToolCall") {
    const tool = publicToolName(item.namespace, "Herramienta");
    return {
      id: item.id,
      kind: "tool",
      label: status === "running" ? `Utilitzant ${tool}` : `${tool} completat`,
      status,
    };
  }

  if (item.type === "webSearch") {
    return {
      id: item.id,
      kind: "web",
      label: status === "running" ? "Cercant al web" : "Cerca web completada",
      ...(publicActivityText(item.query, 240) ? { detail: publicActivityText(item.query, 240) ?? undefined } : {}),
      status,
    };
  }

  if (item.type === "reasoning") {
    return {
      id: item.id,
      kind: "reasoning",
      label: status === "running" ? "Raonant" : "Raonament completat",
      ...(publicActivityText(joinedStrings(item.summary)) ? { detail: publicActivityText(joinedStrings(item.summary)) ?? undefined } : {}),
      status,
    };
  }

  if (item.type === "agentMessage" && item.phase === "commentary" && typeof item.text === "string") {
    const detail = publicActivityText(item.text, 12_000);
    if (!detail) return null;
    return {
      id: item.id,
      kind: "reasoning",
      label: "Actualización de trabajo",
      detail,
      status,
    };
  }

  if (item.type === "plan") {
    return {
      id: item.id,
      kind: "plan",
      label: status === "running" ? "Preparant el pla" : "Pla preparat",
      ...(publicActivityText(item.text) ? { detail: publicActivityText(item.text) ?? undefined } : {}),
      status,
    };
  }

  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
    return {
      id: item.id,
      kind: "agent",
      label: status === "running" ? "Coordinant agents" : "Coordinació completada",
      ...(publicActivityText(item.tool, 240) ? { detail: publicActivityText(item.tool, 240) ?? undefined } : {}),
      status,
    };
  }

  return null;
}

export function notificationDelta(params: unknown) {
  return isRecord(params) && typeof params.delta === "string" ? params.delta : null;
}

export function notificationItemId(params: unknown) {
  return isRecord(params) && typeof params.itemId === "string" ? params.itemId : null;
}

export function planFromNotification(params: unknown): {
  explanation: string | null;
  steps: PlanStep[];
} | null {
  if (!isRecord(params) || !Array.isArray(params.plan)) return null;

  const steps: PlanStep[] = [];
  for (const value of params.plan) {
    if (!isRecord(value) || typeof value.step !== "string") continue;
    const step = publicActivityText(value.step, 1_000);
    if (!step) continue;
    if (value.status === "pending" || value.status === "completed") {
      steps.push({ step, status: value.status });
    } else if (value.status === "inProgress") {
      steps.push({ step, status: "in_progress" });
    }
  }

  return {
    explanation: publicActivityText(params.explanation),
    steps,
  };
}

export function completedTurnStatus(params: unknown) {
  if (!isRecord(params) || !isRecord(params.turn)) return null;
  const turn = params.turn;
  const error = isRecord(turn.error) ? turn.error : null;
  return {
    status: typeof turn.status === "string" ? turn.status : null,
    error: error && typeof error.message === "string" ? error.message : null,
  };
}

export type PendingServerApproval = {
  item: ApprovalItem;
  requestType: ApprovalRequestType;
  response: (decision: ApprovalDecision | "cancel") => object;
};

function approvalRouting(request: ServerRequest) {
  if (!isRecord(request.params)) return null;
  const { threadId, turnId, itemId } = request.params;
  const valid = (value: unknown) => typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
  if (!valid(threadId) || !valid(turnId) || !valid(itemId)) return null;
  const explicitApprovalId = request.params.approvalId;
  if (explicitApprovalId !== undefined && explicitApprovalId !== null &&
      !valid(explicitApprovalId)) return null;
  const approvalId = typeof explicitApprovalId === "string"
    ? explicitApprovalId
    : `approval-${createHash("sha256").update(JSON.stringify([
        request.method,
        threadId,
        turnId,
        itemId,
      ])).digest("hex")}`;
  return {
    id: approvalId,
    threadId: threadId as string,
    turnId: turnId as string,
    itemId: itemId as string,
  };
}

function permissionGrant(value: unknown) {
  if (!isRecord(value)) return {};
  const grant: Record<string, unknown> = {};
  if (value.network !== null && value.network !== undefined) {
    grant.network = value.network;
  }
  if (value.fileSystem !== null && value.fileSystem !== undefined) {
    grant.fileSystem = value.fileSystem;
  }
  return grant;
}

function permissionSummary(value: unknown) {
  if (!isRecord(value)) return null;
  const parts: string[] = [];
  if (isRecord(value.fileSystem)) {
    const read = joinedStrings(value.fileSystem.read);
    const write = joinedStrings(value.fileSystem.write);
    if (read) parts.push(`Lectura: ${read}`);
    if (write) parts.push(`Escriptura: ${write}`);
  }
  if (isRecord(value.network) && value.network.enabled === true) {
    parts.push("Accés de xarxa");
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function approvalFromRequest(request: ServerRequest): PendingServerApproval | null {
  if (!isRecord(request.params)) return null;
  const params = request.params;
  const routing = approvalRouting(request);
  if (!routing) return null;
  const reason = typeof params.reason === "string" ? params.reason : null;

  if (request.method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : null;
    return {
      item: {
        ...routing,
        kind: "command",
        title: "Em dones permís per completar aquest pas?",
        detail: reason ?? command ?? "Revisa l’ordre abans de continuar.",
        ...(command ? { command } : {}),
        ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
        status: "pending",
      },
      requestType: "command",
      response: (decision) => ({ decision }),
    };
  }

  if (request.method === "item/fileChange/requestApproval") {
    return {
      item: {
        ...routing,
        kind: "file",
        title: "Vols que apliqui aquests canvis?",
        detail: reason ?? "Revisa els canvis abans de continuar.",
        status: "pending",
      },
      requestType: "file",
      response: (decision) => ({ decision }),
    };
  }

  if (request.method === "item/permissions/requestApproval") {
    const requested = isRecord(params.permissions) ? params.permissions : {};
    return {
      item: {
        ...routing,
        kind: "command",
        title: "Codex demana permisos addicionals",
        detail:
          reason ??
          permissionSummary(requested) ??
          "Revisa els permisos abans de continuar.",
        ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
        status: "pending",
      },
      requestType: "permissions",
      response: (decision) => ({
        permissions:
          decision === "decline" || decision === "cancel"
            ? {}
            : permissionGrant(requested),
        scope: decision === "acceptForSession" ? "session" : "turn",
      }),
    };
  }

  return null;
}

export function resolvedApproval(
  approval: ApprovalItem,
  decision: ApprovalDecision | "cancel",
): ApprovalItem {
  const status =
    decision === "accept"
      ? "accepted"
      : decision === "acceptForSession"
        ? "accepted_session"
        : "declined";
  return { ...approval, status };
}

export function effectiveSandbox(config: RuntimeConfig, chatRequest: ChatRequest) {
  return chatRequest.options.mode === "agent" ? config.sandbox : "read-only";
}

export function sandboxPolicy(
  config: RuntimeConfig,
  chatRequest: ChatRequest,
  additionalWritableRoots: readonly string[] = [],
) {
  if (effectiveSandbox(config, chatRequest) === "read-only") {
    return { type: "readOnly" as const, networkAccess: false };
  }
  return {
    type: "workspaceWrite" as const,
    writableRoots: [config.workspace, ...additionalWritableRoots],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
