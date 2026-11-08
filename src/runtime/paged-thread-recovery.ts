import type { WorkerAppServerClient } from "@/runtime/worker-runtime-service";
import type { AppServerEvent, JsonValue } from "@/runtime/transport";

function record(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Read only the matching admitted turn; never hydrate the entire thread. */
export async function requestPagedThreadRecovery(
  client: Pick<WorkerAppServerClient, "request">,
  method: "thread/read" | "thread/resume",
  params: Record<string, unknown>,
  purpose: string,
  timeoutMs: number,
  clientUserMessageId: string,
  beforeResolve?: (value: JsonValue, event: AppServerEvent) => void | Promise<void>,
): Promise<JsonValue> {
  const deadline = Date.now() + timeoutMs;
  let envelope: AppServerEvent | undefined;
  const capture = (_value: JsonValue, event: AppServerEvent) => { envelope = event; };
  const result = await client.request(method, {
    ...params,
    ...(method === "thread/read" ? { includeTurns: false } : {
      excludeTurns: true,
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
    }),
  }, purpose, timeoutMs, capture);
  if (!record(result) || !record(result.thread) || result.thread.id !== params.threadId) {
    throw new Error("The recovered thread does not match the authorized conversation.");
  }
  // Older App Server responses already contain the requested turns. Modern
  // resume responses supply initialTurnsPage explicitly.
  if ((Array.isArray(result.thread.turns) && result.thread.turns.length > 0) ||
      (method === "thread/resume" && !("initialTurnsPage" in result))) {
    if (envelope) await beforeResolve?.(result, envelope);
    return result;
  }
  let page = record(result.initialTurnsPage) ? result.initialTurnsPage : null;
  let cursor: JsonValue = null;
  const seen = new Set<string>();
  let matching: JsonValue[] = [];
  for (let index = 0; index < 256; index += 1) {
    if (!page) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Conversation recovery exceeded its bounded deadline.");
      const next = await client.request("thread/turns/list", {
        threadId: params.threadId, cursor, limit: 1,
        sortDirection: "desc", itemsView: "full",
      }, `${purpose}:p${index}`, remaining, capture);
      if (!record(next) || !Array.isArray(next.data)) throw new Error("Invalid conversation recovery page.");
      page = next;
    }
    if (!Array.isArray(page.data)) throw new Error("Invalid conversation recovery page.");
    const turn = page.data.find((candidate) => record(candidate) && Array.isArray(candidate.items) &&
      candidate.items.some((item) => record(item) && item.type === "userMessage" && item.clientId === clientUserMessageId));
    if (turn) { matching = [turn]; break; }
    if (!("nextCursor" in page)) throw new Error("Invalid conversation recovery cursor.");
    cursor = page.nextCursor;
    if (cursor == null) break;
    if (typeof cursor !== "string" || seen.has(cursor)) throw new Error("Conversation recovery cursor did not advance.");
    seen.add(cursor);
    page = null;
    if (index === 255) throw new Error("Conversation recovery exceeded its bounded page limit.");
  }
  const recovered: JsonValue = { ...result, thread: { ...result.thread, turns: matching } };
  if (!envelope) throw new Error("Conversation recovery has no durable response envelope.");
  await beforeResolve?.(recovered, envelope);
  return recovered;
}
