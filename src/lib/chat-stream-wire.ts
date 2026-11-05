import type { ChatStreamEvent } from "@/lib/chat-contract";

/** Retain the existing per-line bound. Large durable snapshots use ordered,
 * bounded wire fragments; consumers publish only a fully validated event. */
export const MAX_CHAT_STREAM_LINE_LENGTH = 1_000_000;
// Matches the durable projection ceiling, without allowing an unbounded client
// assembly or changing the ordinary line/frame safety limit.
export const MAX_CHAT_STREAM_EVENT_LENGTH = 64 * 1024 * 1024;
export const CHAT_STREAM_CHUNK_LENGTH = 64 * 1024;
const encoder = new TextEncoder();

export type ChatStreamWireChunk = {
  type: "chat-event-chunk";
  version: 1;
  id: string;
  index: number;
  count: number;
  length: number;
  data: string;
};

export function isChatStreamWireChunk(value: unknown): value is ChatStreamWireChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as ChatStreamWireChunk;
  return Object.keys(chunk).sort().join() === "count,data,id,index,length,type,version" &&
    chunk.type === "chat-event-chunk" && chunk.version === 1 &&
    typeof chunk.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(chunk.id) &&
    Number.isSafeInteger(chunk.length) && chunk.length > MAX_CHAT_STREAM_LINE_LENGTH && chunk.length <= MAX_CHAT_STREAM_EVENT_LENGTH &&
    Number.isSafeInteger(chunk.count) && chunk.count === Math.ceil(chunk.length / CHAT_STREAM_CHUNK_LENGTH) &&
    Number.isSafeInteger(chunk.index) && chunk.index >= 0 && chunk.index < chunk.count &&
    typeof chunk.data === "string" && chunk.data.length === Math.min(CHAT_STREAM_CHUNK_LENGTH, chunk.length - chunk.index * CHAT_STREAM_CHUNK_LENGTH);
}

/** Both initial live events/keepalives and replays use this same encoder. This
 * changes transport only: the original event, sequence and message stay exact. */
export function* encodeChatStreamEvent(event: ChatStreamEvent): Generator<Uint8Array> {
  const serialized = JSON.stringify(event);
  if (serialized.length > MAX_CHAT_STREAM_EVENT_LENGTH) throw new Error("Chat event exceeds its bounded assembly limit.");
  if (serialized.length <= MAX_CHAT_STREAM_LINE_LENGTH) {
    yield encoder.encode(`${serialized}\n`);
    return;
  }
  const id = globalThis.crypto.randomUUID();
  const count = Math.ceil(serialized.length / CHAT_STREAM_CHUNK_LENGTH);
  for (let index = 0; index < count; index++) {
    const chunk: ChatStreamWireChunk = {
      type: "chat-event-chunk", version: 1, id, index, count, length: serialized.length,
      data: serialized.slice(index * CHAT_STREAM_CHUNK_LENGTH, (index + 1) * CHAT_STREAM_CHUNK_LENGTH),
    };
    const line = JSON.stringify(chunk);
    if (line.length > MAX_CHAT_STREAM_LINE_LENGTH) throw new Error("Chat fragment exceeds its bounded line limit.");
    yield encoder.encode(`${line}\n`);
  }
}
