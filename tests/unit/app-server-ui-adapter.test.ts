import { describe, expect, it, vi } from "vitest";
import { ChatStreamProtocolError, consumeChatEventStream } from "@/ui/app-server-ui-adapter";
import { CHAT_STREAM_CHUNK_LENGTH, encodeChatStreamEvent, MAX_CHAT_STREAM_EVENT_LENGTH, MAX_CHAT_STREAM_LINE_LENGTH } from "@/lib/chat-stream-wire";
import type { ChatStreamEvent } from "@/lib/chat-contract";
import { largeChatFixture } from "../helpers/large-chat-fixture";

function responseFromChunks(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  }));
}

describe("App Server UI stream adapter", () => {
  it("preserves event order across arbitrary NDJSON chunk boundaries", async () => {
    const onEvent = vi.fn();
    await consumeChatEventStream(responseFromChunks([
      '{"type":"delta","value":"Ho',
      'la "}\n{"type":"delta","value":"mundo"}\n',
      '{"type":"done"}',
    ]), onEvent);

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "delta", value: "Hola " },
      { type: "delta", value: "mundo" },
      { type: "done" },
    ]);
  });

  it("fails closed on unknown or malformed events", async () => {
    await expect(consumeChatEventStream(
      responseFromChunks(['{"type":"invented"}\n']),
      () => undefined,
    )).rejects.toBeInstanceOf(ChatStreamProtocolError);
    await expect(consumeChatEventStream(
      responseFromChunks(["not-json\n"]),
      () => undefined,
    )).rejects.toBeInstanceOf(ChatStreamProtocolError);
  });

  it("cancels the reader and rejects when the request signal is aborted", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({
      pull() {
        return new Promise(() => undefined);
      },
      cancel: cancelled,
    }));
    const controller = new AbortController();
    const reading = consumeChatEventStream(response, () => undefined, { signal: controller.signal });
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("cancels the body when an event consumer fails", async () => {
    const cancelled = vi.fn();
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"delta","value":"hola"}\n'));
      },
      cancel: cancelled,
    }));
    const error = new Error("consumer failed");
    await expect(consumeChatEventStream(response, () => { throw error; })).rejects.toBe(error);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});


describe("bounded chat event fragments", () => {
  const decode = (event: ChatStreamEvent) => [...encodeChatStreamEvent(event)].map(bytes => new TextDecoder().decode(bytes));

  it.each(["streaming", "complete", "error", "stopped"] as const)("reassembles a 7.5 MB %s snapshot exactly without partial delivery", async status => {
    const event: ChatStreamEvent = { type: "snapshot", message: largeChatFixture(status) };
    expect(JSON.stringify(event).length).toBeGreaterThan(7_400_000);
    const lines = decode(event);
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.every(line => line.trimEnd().length <= MAX_CHAT_STREAM_LINE_LENGTH)).toBe(true);
    const onEvent = vi.fn();
    // Network boundaries may split wire JSON and UTF-8 independently of its
    // logical fragments; all saved tool output, image data and sequence survive.
    const bytes = [...encodeChatStreamEvent(event)];
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const part of bytes) { controller.enqueue(part.slice(0, 97)); controller.enqueue(part.slice(97)); }
      controller.close();
    } }));
    await consumeChatEventStream(response, onEvent, { stopOnTerminal: true });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("fragments an individual large live activity and preserves order with normal events", async () => {
    const activity: ChatStreamEvent = { type: "activity", item: largeChatFixture().activity[0] };
    const events: ChatStreamEvent[] = [{ type: "delta", value: "Before" }, activity, { type: "done" }];
    const observed: ChatStreamEvent[] = [];
    await consumeChatEventStream(responseFromChunks(events.flatMap(decode)), event => observed.push(event));
    expect(observed).toEqual(events);
  });

  it("preserves a Unicode pair split exactly across wire fragment boundaries", async () => {
    const prefix=JSON.stringify({type:"delta",value:""}).indexOf('""')+1;
    const event:ChatStreamEvent={type:"delta",value:"x".repeat(CHAT_STREAM_CHUNK_LENGTH-prefix-1)+"🙂"+"y".repeat(MAX_CHAT_STREAM_LINE_LENGTH)};
    const onEvent=vi.fn();
    await consumeChatEventStream(responseFromChunks(decode(event)),onEvent);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("keeps the existing unfragmented one-million-character line limit", async () => {
    const onEvent = vi.fn();
    await expect(consumeChatEventStream(responseFromChunks([JSON.stringify({type:"delta",value:"x".repeat(MAX_CHAT_STREAM_LINE_LENGTH)})+"\n"]),onEvent)).rejects.toThrow("límite permitido");
    expect(onEvent).not.toHaveBeenCalled();
  });

  it.each(["truncated", "reordered", "duplicate", "foreign-id", "interleaved", "oversized-total", "malformed-data", "unknown-fields"])("rejects %s assemblies before publishing any partial event", async fault => {
    const lines = decode({type:"activity",item:largeChatFixture().activity[0]});
    if (fault === "truncated") lines.pop();
    if (fault === "reordered") [lines[0],lines[1]]=[lines[1],lines[0]];
    if (fault === "duplicate") lines.splice(1,0,lines[0]);
    if (fault === "foreign-id") {const value=JSON.parse(lines[1]);value.id="ffffffff-ffff-4fff-8fff-ffffffffffff";lines[1]=JSON.stringify(value)+"\n";}
    if (fault === "interleaved") lines.splice(1,0,'{"type":"done"}\n');
    if (fault === "oversized-total") {const value=JSON.parse(lines[0]);value.length=MAX_CHAT_STREAM_EVENT_LENGTH+1;lines[0]=JSON.stringify(value)+"\n";}
    if (fault === "malformed-data") {const value=JSON.parse(lines[0]);value.data+="x";lines[0]=JSON.stringify(value)+"\n";}
    if (fault === "unknown-fields") {const value=JSON.parse(lines[0]);value.unexpected=true;lines[0]=JSON.stringify(value)+"\n";}
    const onEvent=vi.fn();
    await expect(consumeChatEventStream(responseFromChunks(lines),onEvent)).rejects.toBeInstanceOf(ChatStreamProtocolError);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("validates the original event schema after full assembly and starts retry assembly from scratch", async () => {
    const lines=decode({type:"snapshot",message:largeChatFixture("complete")});
    const onEvent=vi.fn();
    await expect(consumeChatEventStream(responseFromChunks(lines.slice(0,-1)),onEvent)).rejects.toThrow("incompleto");
    expect(onEvent).not.toHaveBeenCalled();
    await consumeChatEventStream(responseFromChunks(lines),onEvent,{stopOnTerminal:true});
    expect(onEvent).toHaveBeenCalledOnce();
    const invalid=decode({type:"activity",item:{...largeChatFixture().activity[0],status:"invented"}} as unknown as ChatStreamEvent);
    await expect(consumeChatEventStream(responseFromChunks(invalid),()=>undefined)).rejects.toThrow("no compatible");
  });
});
