import type { ActivityItem, ChatMessage, ToolResult } from "@/lib/chat-contract";

export type TurnTimelineEntry =
  | { type: "activity"; key: string; order: number; item: ActivityItem }
  | { type: "tool"; key: string; order: number; item: ToolResult };

const TOOL_ACTIVITY_KINDS = new Set<ActivityItem["kind"]>(["command", "file", "tool", "web"]);

/**
 * Combines independently persisted activity and tool-result collections using
 * their transport sequence. A reviewable tool card replaces its duplicate
 * generic activity row, while public reasoning summaries remain interleaved.
 */
export function buildTurnTimeline(
  activity: readonly ActivityItem[],
  toolResults: readonly ToolResult[],
): TurnTimelineEntry[] {
  const toolIds = new Set(toolResults.map((result) => result.id));
  const legacyBase = Number.MAX_SAFE_INTEGER - activity.length - toolResults.length - 1;
  const entries: TurnTimelineEntry[] = [];

  activity.forEach((item, index) => {
    if (toolIds.has(item.id) && TOOL_ACTIVITY_KINDS.has(item.kind)) return;
    entries.push({
      type: "activity",
      key: `activity:${item.id}`,
      order: item.sequence ?? legacyBase + index,
      item,
    });
  });
  toolResults.forEach((item, index) => {
    entries.push({
      type: "tool",
      key: `tool:${item.id}`,
      order: item.sequence ?? legacyBase + activity.length + index,
      item,
    });
  });

  return entries.sort((left, right) =>
    left.order - right.order ||
    (left.type === right.type ? 0 : left.type === "tool" ? -1 : 1));
}

function telemetryDurationMs(message: Pick<ChatMessage, "activity">) {
  const detail = message.activity.find((item) => item.id === "runtime-performance")?.detail;
  const match = detail?.match(/(?:^|·)\s*Total\s+(\d+)\s+ms(?:\s*·|$)/u);
  return match ? Number(match[1]) : null;
}

export function turnDurationMs(message: Pick<ChatMessage, "durationMs" | "activity">) {
  return message.durationMs ?? telemetryDurationMs(message);
}

export function formatWorkDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
