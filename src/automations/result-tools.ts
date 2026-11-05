import "server-only";

import type { DynamicToolNamespaceTool } from "../../contracts/codex/0.162.1/types/v2/DynamicToolNamespaceTool";
import type { AuthSession } from "@/auth/types";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { isRecord, type AutomationRunHistory } from "./contracts";
import { automationWorkspaceForSession } from "./server-service";
import { FileAutomationStore } from "./store";
import { automationRunIdentities, isAutomationResultThread } from "./run-identities";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const taskIdSchema = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } as const;
export const AUTOMATION_RESULT_TOOLS: DynamicToolNamespaceTool[] = [{
  type: "function", name: "list_runs",
  description: "List persisted occurrences of one OWNED automation, newest first. Filter scheduledFor with after/before ISO timestamps. Returns bounded metadata, status, error and result threadId; success is not proof of external delivery. No foreign owner or tenant override.",
  inputSchema: { type: "object", properties: { taskId: taskIdSchema, after: { type: "string", format: "date-time" }, before: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 50 }, offset: { type: "integer", minimum: 0 } }, required: ["taskId"], additionalProperties: false },
}, {
  type: "function", name: "get_run",
  description: "Read an OWNED automation occurrence's original persisted assistant result in its exact thread, without repeating the task or reconstructing a report. Use list_runs first. Content is paged by character offset/limit; follow nextOffset to read the complete result. Never reads other conversations or exposes runtime tokens/prompts/grants.",
  inputSchema: { type: "object", properties: { taskId: taskIdSchema, runKey: { type: "string", minLength: 1, maxLength: 512 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16000 } }, required: ["taskId", "runKey"], additionalProperties: false },
}];
export const AUTOMATION_RESULT_INSTRUCTIONS = "Si el usuario pide un informe, resumen o resultado de una automatización anterior, usa list/get para localizar su tarea propia y aibrain_automations.list_runs/get_run para recuperar el resultado original persistido, aunque esté en otra conversación. Lee las páginas necesarias con nextOffset. No reconstruyas un informe histórico a partir del estado actual si existe el original. Distingue ejecución correcta, resultado guardado y entrega externa; si no hay resultado o falló, indica ese estado concreto sin volver a ejecutar ni inventar contenido.";

function invalid(): never { throw Error("La consulta del resultado de automatización no es válida."); }
function missing(): never { throw Error("Resultado de automatización no encontrado."); }
function integer(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid();
  return value;
}
function timestamp(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return Date.parse(value);
}
function runView(run: AutomationRunHistory) {
  return { runKey: run.runKey, scheduledFor: run.scheduledFor, status: run.status, attempt: run.attempt, startedAt: run.startedAt, finishedAt: run.finishedAt, threadId: run.threadId, error: run.error?.slice(0, 1000) ?? null };
}

/** Current canonical owner only, even if an admin can manage a different user's task. */
export async function readAutomationResultTool(session: AuthSession, tool: string, args: unknown) {
  if (!isRecord(args) || typeof args.taskId !== "string" || !UUID.test(args.taskId)) invalid();
  const allowed = tool === "list_runs" ? ["taskId", "after", "before", "limit", "offset"] : tool === "get_run" ? ["taskId", "runKey", "limit", "offset"] : invalid();
  if (Object.keys(args).some(key => !allowed.includes(key))) invalid();
  const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(args.limit, tool === "list_runs" ? 10 : 12000, tool === "list_runs" ? 50 : 16000);
  if (!limit) invalid();
  const after = timestamp(args.after), before = timestamp(args.before);
  if (after !== null && before !== null && after > before) invalid();
  if (tool === "get_run" && (typeof args.runKey !== "string" || !args.runKey.length || args.runKey.length > 512)) invalid();
  const { installation, principal } = await automationWorkspaceForSession(session);
  const store = new FileAutomationStore({ installationId: installation.installationId, usersRoot: installation.paths.usersRoot, userId: principal.userId });
  // No list across owners, received audience or target path supplied by the model.
  const task = await store.get(args.taskId).catch(() => missing());
  if (task.userId !== principal.userId || task.installationId !== installation.installationId) missing();
  const latest = new Map<string, AutomationRunHistory>();
  for (const run of await store.listRuns(task.id)) {
    if (run.taskId !== task.id || run.userId !== principal.userId || run.installationId !== installation.installationId) missing();
    if (!latest.has(run.runKey) || latest.get(run.runKey)!.attempt < run.attempt) latest.set(run.runKey, run);
  }
  if (tool === "list_runs") {
    const runs = [...latest.values()].filter(run => (after === null || Date.parse(run.scheduledFor) >= after) && (before === null || Date.parse(run.scheduledFor) <= before))
      .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor) || b.runKey.localeCompare(a.runKey));
    const page = runs.slice(offset, offset + limit);
    return { taskId: task.id, taskName: task.name, timeZone: task.timeZone, runs: page.map(runView), total: runs.length, nextOffset: offset + page.length < runs.length ? offset + page.length : null };
  }
  const run = latest.get(args.runKey as string);
  if (!run) missing();
  const metadata = { taskId: task.id, taskName: task.name, timeZone: task.timeZone, run: runView(run) };
  if (!run.threadId) return { ...metadata, result: null, reason: "No persisted result thread" };
  if (!isAutomationResultThread(task, run.runKey, run.threadId)) missing();
  const thread = await new FileWorkbenchStore({ installationId: installation.installationId, usersRoot: installation.paths.usersRoot }).getThread(principal.userId, run.threadId);
  if (thread.projectId !== task.projectId) missing();
  // Select only messages generated for this occurrence, never later human replies.
  const keys = [run.runKey, `${run.runKey}:capacity-continuation:1`, `${run.runKey}:capacity-continuation:2`];
  const result = keys.map(key => {
    const ids = automationRunIdentities(key);
    const index = thread.messages.findIndex(message => message.id === ids.userMessageId && message.role === "user");
    const assistant = thread.messages[index + 1];
    return index >= 0 && assistant?.id === ids.assistantMessageId && assistant.role === "assistant" ? assistant : null;
  }).filter(message => message !== null).at(-1);
  if (!result) return { ...metadata, result: null, reason: "No persisted assistant result" };
  const text = result.content;
  return { ...metadata, result: { source: "persisted-automation-result", messageId: result.id, status: result.status, createdAt: result.createdAt, threadId: thread.id, threadTitle: thread.title, threadStatus: thread.status, content: text.slice(offset, offset + limit), totalCharacters: text.length, offset, nextOffset: offset + limit < text.length ? offset + limit : null } };
}
