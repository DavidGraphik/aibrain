import type { ChatMessage } from "@/lib/chat-contract";
import type { WorkbenchThread } from "@/workbench/types";

export type ThreadWorkState =
  | "idle"
  | "running"
  | "needs_attention"
  | "completed"
  | "failed";

export type ThreadNotificationPhase = "needs_attention" | "completed" | "failed";

export type ThreadReadMarker = {
  messageId: string;
  phase: ThreadNotificationPhase;
};

export type ThreadActivity = {
  state: ThreadWorkState;
  unreadCount: number;
};

function notificationPhase(message: ChatMessage): ThreadNotificationPhase | null {
  if (message.role !== "assistant") return null;
  if (message.approvals.some((approval) => approval.status === "pending")) {
    return "needs_attention";
  }
  if (message.status === "complete") return "completed";
  if (message.status === "error") return "failed";
  return null;
}

export function latestThreadReadMarker(
  thread: Pick<WorkbenchThread, "messages">,
): ThreadReadMarker | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    const phase = notificationPhase(message);
    if (phase) return { messageId: message.id, phase };
  }
  return null;
}

function unreadNotificationCount(
  thread: Pick<WorkbenchThread, "messages">,
  marker: ThreadReadMarker | null,
) {
  const assistantMessages = thread.messages.filter((message) => message.role === "assistant");
  if (!assistantMessages.length) return 0;

  const markerIndex = marker
    ? assistantMessages.findIndex((message) => message.id === marker.messageId)
    : -1;

  return assistantMessages.reduce((count, message, index) => {
    const phase = notificationPhase(message);
    if (!phase) return count;
    if (!marker) return count + 1;
    if (index < markerIndex) return count;
    if (index === markerIndex && message.id === marker.messageId && phase === marker.phase) {
      return count;
    }
    return count + 1;
  }, 0);
}

export function getThreadActivity(
  thread: Pick<WorkbenchThread, "messages">,
  marker: ThreadReadMarker | null,
  locallyRunning = false,
): ThreadActivity {
  const assistantMessages = thread.messages.filter((message) => message.role === "assistant");
  const latestAssistant = assistantMessages.at(-1) ?? null;
  const unreadCount = unreadNotificationCount(thread, marker);

  if (assistantMessages.some((message) =>
    message.approvals.some((approval) => approval.status === "pending"))) {
    return { state: "needs_attention", unreadCount };
  }
  if (locallyRunning || assistantMessages.some((message) => message.status === "streaming")) {
    return { state: "running", unreadCount };
  }
  if (latestAssistant?.status === "error") return { state: "failed", unreadCount };
  if (latestAssistant?.status === "complete" && unreadCount > 0) {
    return { state: "completed", unreadCount };
  }
  return { state: "idle", unreadCount };
}

export function isThreadReadMarker(value: unknown): value is ThreadReadMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return typeof marker.messageId === "string" && marker.messageId.length > 0 &&
    (marker.phase === "needs_attention" || marker.phase === "completed" || marker.phase === "failed");
}
