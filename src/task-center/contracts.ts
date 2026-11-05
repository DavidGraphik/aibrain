import type { ChatMessage } from "@/lib/chat-contract";
import type { WorkbenchProject, WorkbenchSnapshot, WorkbenchThread } from "@/workbench/types";

export type TaskCenterStatus = "running" | "needs_attention" | "completed" | "failed";
export type TaskCenterFilter = "all" | TaskCenterStatus;

export type TaskNotificationPreferences = {
  inApp: boolean;
  desktop: boolean;
};

export type TaskCenterReadState = {
  readTaskIds: string[];
  preferences: TaskNotificationPreferences;
};

export type TaskCenterItem = {
  id: string;
  threadId: string;
  projectId: string;
  threadTitle: string;
  projectName: string | null;
  status: TaskCenterStatus;
  title: string;
  detail: string;
  createdAt: string;
  updatedAt: string;
  unread: boolean;
};

export type TaskCenterPayload = {
  tasks: TaskCenterItem[];
  readTaskIds: string[];
  preferences: TaskNotificationPreferences;
  continuity: "worker_required";
};

export const DEFAULT_TASK_NOTIFICATION_PREFERENCES: TaskNotificationPreferences = {
  inApp: true,
  desktop: false,
};

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TASK_ID_PATTERN = new RegExp(`^${UUID_PATTERN}\\.${UUID_PATTERN}$`, "i");

export function isTaskCenterId(value: unknown): value is string {
  return typeof value === "string" && TASK_ID_PATTERN.test(value);
}

export function taskCenterId(threadId: string, messageId: string) {
  return `${threadId}.${messageId}`;
}

function taskStatus(message: ChatMessage): TaskCenterStatus | null {
  if (message.role !== "assistant") return null;
  if (message.approvals.some((approval) => approval.status === "pending")) {
    return "needs_attention";
  }
  if (message.status === "streaming") return "running";
  if (message.status === "complete") return "completed";
  if (message.status === "error" || message.status === "stopped") return "failed";
  return null;
}

function taskTitle(status: TaskCenterStatus, content: string) {
  const firstLine = content.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (firstLine) return firstLine.length > 92 ? `${firstLine.slice(0, 89)}…` : firstLine;
  if (status === "running") return "Trabajando en tu solicitud";
  if (status === "needs_attention") return "Necesita una decisión tuya";
  if (status === "failed") return "La tarea no se ha podido completar";
  return "Tarea completada";
}

function taskDetail(status: TaskCenterStatus, message: ChatMessage) {
  if (status === "needs_attention") {
    return message.approvals.find((approval) => approval.status === "pending")?.title ??
      "Abre la conversación para revisar la acción pendiente.";
  }
  if (status === "running") {
    return message.activity.findLast((item) => item.status === "running")?.label ??
      "La respuesta continúa mientras el servidor y el worker estén activos.";
  }
  if (status === "failed") {
    return message.status === "stopped"
      ? "La tarea se detuvo antes de terminar."
      : "Abre la conversación para ver el error y volver a intentarlo.";
  }
  return "El resultado ya está disponible en la conversación.";
}

function taskUpdatedAt(message: ChatMessage, thread: WorkbenchThread) {
  const latestActivity = message.activity.at(-1);
  return latestActivity ? thread.updatedAt : message.createdAt;
}

export function deriveTaskCenterItems(
  snapshot: Pick<WorkbenchSnapshot, "projects" | "threads">,
  readTaskIds: readonly string[],
) {
  const projectById = new Map<string, WorkbenchProject>(
    snapshot.projects.map((project) => [project.id, project]),
  );
  const read = new Set(readTaskIds);
  const tasks: TaskCenterItem[] = [];

  for (const thread of snapshot.threads) {
    let hasUserRequest = false;
    for (const message of thread.messages) {
      if (message.role === "user") {
        hasUserRequest = true;
        continue;
      }
      if (!hasUserRequest) continue;
      const status = taskStatus(message);
      if (!status) continue;
      const id = taskCenterId(thread.id, message.id);
      tasks.push({
        id,
        threadId: thread.id,
        projectId: thread.projectId,
        threadTitle: thread.title,
        projectName: projectById.get(thread.projectId)?.name ?? null,
        status,
        title: taskTitle(status, message.content),
        detail: taskDetail(status, message),
        createdAt: message.createdAt,
        updatedAt: taskUpdatedAt(message, thread),
        unread: status !== "running" && !read.has(id),
      });
    }
  }

  return tasks.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

export function isTaskNotificationPreferences(value: unknown): value is TaskNotificationPreferences {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    "inApp" in value && typeof value.inApp === "boolean" &&
    "desktop" in value && typeof value.desktop === "boolean");
}

export function isTaskCenterPayload(value: unknown): value is TaskCenterPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("tasks" in value) || !Array.isArray(value.tasks) ||
    !("readTaskIds" in value) || !Array.isArray(value.readTaskIds) || !value.readTaskIds.every(isTaskCenterId) ||
    !("preferences" in value) || !isTaskNotificationPreferences(value.preferences) ||
    !("continuity" in value) || value.continuity !== "worker_required") return false;
  return value.tasks.every((task) => Boolean(task && typeof task === "object" && !Array.isArray(task) &&
    "id" in task && isTaskCenterId(task.id) &&
    "threadId" in task && typeof task.threadId === "string" &&
    "projectId" in task && typeof task.projectId === "string" &&
    "threadTitle" in task && typeof task.threadTitle === "string" &&
    "projectName" in task && (task.projectName === null || typeof task.projectName === "string") &&
    "status" in task && ["running", "needs_attention", "completed", "failed"].includes(String(task.status)) &&
    "title" in task && typeof task.title === "string" &&
    "detail" in task && typeof task.detail === "string" &&
    "createdAt" in task && typeof task.createdAt === "string" &&
    "updatedAt" in task && typeof task.updatedAt === "string" &&
    "unread" in task && typeof task.unread === "boolean"));
}
