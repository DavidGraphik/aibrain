import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/chat-contract";
import {
  getThreadActivity,
  latestThreadReadMarker,
  type ThreadReadMarker,
} from "@/workbench/thread-activity";

function assistant(
  id: string,
  status: ChatMessage["status"],
  approval: "pending" | "accepted" | null = null,
): ChatMessage {
  return {
    id,
    role: "assistant",
    content: status === "complete" ? "Listo" : "",
    createdAt: new Date().toISOString(),
    status,
    activity: [],
    plan: [],
    approvals: approval ? [{
      id: `approval-${id}`,
      threadId: "runtime-thread",
      turnId: "runtime-turn",
      itemId: "runtime-item",
      kind: "command",
      title: "Confirmar",
      detail: "Confirma la acción",
      status: approval,
    }] : [],
    diff: "",
    attachments: [],
    artifacts: [],
  };
}

describe("thread activity", () => {
  it("reports a real running turn without creating an unread result", () => {
    expect(getThreadActivity({ messages: [assistant("a-1", "streaming")] }, null))
      .toEqual({ state: "running", unreadCount: 0 });
  });

  it("prioritizes a pending approval over the streaming state", () => {
    expect(getThreadActivity({ messages: [assistant("a-1", "streaming", "pending")] }, null))
      .toEqual({ state: "needs_attention", unreadCount: 1 });
  });

  it("marks an off-screen completion unread until its exact phase is read", () => {
    const messages = [assistant("a-1", "complete")];
    expect(getThreadActivity({ messages }, null)).toEqual({ state: "completed", unreadCount: 1 });
    const marker = latestThreadReadMarker({ messages });
    expect(marker).toEqual({ messageId: "a-1", phase: "completed" });
    expect(getThreadActivity({ messages }, marker)).toEqual({ state: "idle", unreadCount: 0 });
  });

  it("notifies again when the same assistant turn moves from approval to completion", () => {
    const marker: ThreadReadMarker = { messageId: "a-1", phase: "needs_attention" };
    expect(getThreadActivity({ messages: [assistant("a-1", "complete", "accepted")] }, marker))
      .toEqual({ state: "completed", unreadCount: 1 });
  });

  it("keeps failures visible and counts only notifications after the read marker", () => {
    const messages = [assistant("a-1", "complete"), assistant("a-2", "error")];
    expect(getThreadActivity(
      { messages },
      { messageId: "a-1", phase: "completed" },
    )).toEqual({ state: "failed", unreadCount: 1 });
  });

  it("supports a locally reserved turn before the streaming message is projected", () => {
    expect(getThreadActivity({ messages: [] }, null, true))
      .toEqual({ state: "running", unreadCount: 0 });
  });
});
