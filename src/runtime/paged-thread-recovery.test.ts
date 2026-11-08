import { describe, expect, it, vi } from "vitest";
import { requestPagedThreadRecovery } from "./paged-thread-recovery";
import type { WorkerAppServerClient } from "./worker-runtime-service";
import type { AppServerEvent, JsonValue } from "./transport";

const threadId = "private-thread";
const userMessageId = "admitted-message";
const turn = (id: string, clientId: string, text = "answer"): JsonValue => ({
  id, status: "completed", error: null,
  items: [
    { type: "userMessage", id: `${id}-user`, clientId, content: [] },
    { type: "agentMessage", id: `${id}-agent`, text, phase: "final_answer" },
  ],
});
function clientFor(responses: JsonValue[]) {
  let sequence = 0;
  const request = vi.fn(async (_method: string, _params: unknown, purpose: string, _timeout: number,
    beforeResolve?: (value: JsonValue, event: AppServerEvent) => void | Promise<void>) => {
    const result = responses.shift();
    if (!result) throw new Error("Unexpected extra request");
    const event: AppServerEvent = { eventId: `event-${++sequence}`, sequence,
      occurredAt: new Date().toISOString(), message: { kind: "rpc-response", rpc: { id: purpose, result } } };
    await beforeResolve?.(result, event);
    return result;
  });
  return { client: { request } as unknown as Pick<WorkerAppServerClient, "request">, request };
}

describe("paged thread recovery", () => {
  it("resumes a history larger than the transport limit without hydrating it or replaying a model action", async () => {
    const oldText = "x".repeat(5 * 1024 * 1024);
    const initial = { thread: { id: threadId, turns: [] }, model: "model",
      initialTurnsPage: { data: [turn("newer", "another-message", oldText)], nextCursor: "older" } };
    const { client, request } = clientFor([initial,
      { data: [turn("older", "previous-message", oldText)], nextCursor: "target" },
      { data: [turn("target", userMessageId)], nextCursor: null }]);
    const beforeResolve = vi.fn();
    const result = await requestPagedThreadRecovery(client, "thread/resume", { threadId, cwd: "/private/workspace" },
      "resume", 60_000, userMessageId, beforeResolve);
    expect(request.mock.calls[0][1]).toMatchObject({ threadId, cwd: "/private/workspace", excludeTurns: true,
      initialTurnsPage: { limit: 1, itemsView: "full", sortDirection: "desc" } });
    expect(request.mock.calls.slice(1).map((call) => call[1])).toEqual([
      { threadId, cursor: "older", limit: 1, sortDirection: "desc", itemsView: "full" },
      { threadId, cursor: "target", limit: 1, sortDirection: "desc", itemsView: "full" },
    ]);
    expect(result).toMatchObject({ thread: { id: threadId, turns: [turn("target", userMessageId)] } });
    expect(beforeResolve).toHaveBeenCalledOnce();
    expect(beforeResolve.mock.calls[0][1]).toMatchObject({ eventId: "event-3" });
    expect(request.mock.calls.map((call) => call[0])).toEqual(["thread/resume", "thread/turns/list", "thread/turns/list"]);
  });

  it("uses a metadata-only durable read and returns no turn when the admitted message was never submitted", async () => {
    const { client, request } = clientFor([{ thread: { id: threadId, turns: [] } },
      { data: [turn("other", "other-user-message")], nextCursor: null }]);
    const result = await requestPagedThreadRecovery(client, "thread/read", { threadId, includeTurns: true },
      "recover", 15_000, userMessageId);
    expect(request.mock.calls[0][1]).toEqual({ threadId, includeTurns: false });
    expect(result).toMatchObject({ thread: { id: threadId, turns: [] } });
  });

  it("rejects a foreign thread before consulting or projecting any of its turns", async () => {
    const { client, request } = clientFor([{ thread: { id: "foreign-thread", turns: [] } }]);
    const project = vi.fn();
    await expect(requestPagedThreadRecovery(client, "thread/read", { threadId }, "recover", 15_000,
      userMessageId, project)).rejects.toThrow("authorized conversation");
    expect(request).toHaveBeenCalledOnce();
    expect(project).not.toHaveBeenCalled();
  });

  it("fails closed when pagination stops advancing", async () => {
    const { client } = clientFor([{ thread: { id: threadId, turns: [] } },
      { data: [], nextCursor: "repeat" }, { data: [], nextCursor: "repeat" }]);
    await expect(requestPagedThreadRecovery(client, "thread/read", { threadId }, "recover", 15_000,
      userMessageId)).rejects.toThrow("cursor did not advance");
  });
});
