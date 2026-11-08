import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/chat-contract";
import {
  deriveTaskCenterItems,
  taskCenterId,
} from "@/task-center/contracts";
import type { WorkbenchProject, WorkbenchThread } from "@/workbench/types";

const PROJECT_ID = "0198b9f0-6631-7000-8000-000000000201";
const THREAD_ID = "0198b9f0-6631-7000-8000-000000000202";
const USER_MESSAGE_ID = "0198b9f0-6631-7000-8000-000000000203";
const ASSISTANT_MESSAGE_ID = "0198b9f0-6631-7000-8000-000000000204";
const NOW = "2026-08-28T08:00:00.000Z";

function message(role: ChatMessage["role"], status: ChatMessage["status"]): ChatMessage {
  return {
    id: role === "user" ? USER_MESSAGE_ID : ASSISTANT_MESSAGE_ID,
    role,
    content: role === "user" ? "Prepara el informe" : "Informe preparado y revisado.",
    createdAt: NOW,
    status,
    activity: [],
    plan: [],
    approvals: [],
    diff: "",
    attachments: [],
    artifacts: [],
  };
}

function fixture(status: ChatMessage["status"], approval = false) {
  const project: WorkbenchProject = {
    id: PROJECT_ID,
    name: "Operaciones",
    slug: "operaciones",
    status: "active",
    pinned: false,
    instructions: "",
    sources: [],
    memory: { enabled: true, notes: "", updatedAt: null },
    sharing: { visibility: "private", members: [] },
    workspace: { id: "0198b9f0-6631-7000-8000-000000000205", label: "Principal", hostType: "managed", status: "ready", isPrimary: true },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const assistant = message("assistant", status);
  if (approval) assistant.approvals.push({
    id: "approval-1",
    threadId: "runtime-thread",
    turnId: "runtime-turn",
    itemId: "runtime-item",
    kind: "command",
    title: "Enviar el informe",
    detail: "Revisa antes de enviar",
    status: "pending",
  });
  const thread: WorkbenchThread = {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Informe semanal",
    status: "active",
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    messages: [message("user", "complete"), assistant],
  };
  return { projects: [project], threads: [thread] };
}

describe("task center contracts", () => {
  it("rebuilds running and completed tasks from the durable conversation", () => {
    expect(deriveTaskCenterItems(fixture("streaming"), [])).toMatchObject([{
      status: "running",
      unread: false,
      threadTitle: "Informe semanal",
      projectName: "Operaciones",
    }]);
    expect(deriveTaskCenterItems(fixture("complete"), [])).toMatchObject([{
      status: "completed",
      unread: true,
      title: "Informe preparado y revisado.",
    }]);
  });

  it("prioritizes pending attention and preserves exact read history", () => {
    const id = taskCenterId(THREAD_ID, ASSISTANT_MESSAGE_ID);
    expect(deriveTaskCenterItems(fixture("streaming", true), [id])).toMatchObject([{
      id,
      status: "needs_attention",
      unread: false,
      detail: "Enviar el informe",
    }]);
  });

  it("does not turn welcome messages without a user request into tasks", () => {
    const value = fixture("complete");
    value.threads[0].messages = [message("assistant", "complete")];
    expect(deriveTaskCenterItems(value, [])).toEqual([]);
  });
});
