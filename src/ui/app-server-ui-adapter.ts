import { isChatStreamEvent, type ChatStreamEvent } from "@/lib/chat-contract";

import {
  isChatStreamWireChunk,
  MAX_CHAT_STREAM_LINE_LENGTH,
  type ChatStreamWireChunk,
} from "@/lib/chat-stream-wire";

export class ChatStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatStreamProtocolError";
  }
}

function parseWireValue(line: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ChatStreamProtocolError("El servicio ha enviado una respuesta incompleta.");
  }
  return value;
}

function parseEvent(value: unknown): ChatStreamEvent {
  if (!isChatStreamEvent(value)) {
    throw new ChatStreamProtocolError("El servicio ha enviado un evento no compatible.");
  }
  return value;
}

export async function consumeChatEventStream(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void,
  options: { signal?: AbortSignal; onActivity?: () => void; stopOnTerminal?: boolean } = {},
) {
  if (!response.body) {
    throw new ChatStreamProtocolError("La respuesta no contiene datos.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let assembly: { header: ChatStreamWireChunk; parts: string[] } | null = null;
  const abortError = () => options.signal?.reason instanceof Error
    ? options.signal.reason
    : new DOMException("La lectura del stream se ha cancelado.", "AbortError");
  const onAbort = () => { void reader.cancel(abortError()); };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const applyLine = (line: string) => {
    if (!line.trim()) return;
    if (line.length > MAX_CHAT_STREAM_LINE_LENGTH) {
      throw new ChatStreamProtocolError("El evento recibido supera el límite permitido.");
    }
    const value = parseWireValue(line);
    let event: ChatStreamEvent;
    if (value && typeof value === "object" && "type" in value && value.type === "chat-event-chunk") {
      if (!isChatStreamWireChunk(value)) throw new ChatStreamProtocolError("El fragmento recibido no es válido.");
      if (!assembly) {
        if (value.index !== 0) throw new ChatStreamProtocolError("Falta el inicio del evento fragmentado.");
        assembly = { header: value, parts: [] };
      }
      const { header, parts } = assembly;
      if (value.id !== header.id || value.count !== header.count || value.length !== header.length || value.index !== parts.length) {
        throw new ChatStreamProtocolError("Los fragmentos del evento no están completos u ordenados.");
      }
      parts.push(value.data);
      if (parts.length < header.count) return;
      const serialized = parts.join("");
      if (serialized.length !== header.length) throw new ChatStreamProtocolError("El evento fragmentado está incompleto.");
      assembly = null;
      // No partial snapshot/event reaches the UI. Apply the original contract
      // only after exact contiguous reassembly; nested wire chunks are invalid.
      event = parseEvent(parseWireValue(serialized));
    } else {
      if (assembly) throw new ChatStreamProtocolError("Se ha interrumpido un evento fragmentado.");
      event = parseEvent(value);
    }
    onEvent(event);
    terminal = options.stopOnTerminal === true && (event.type === "done" || event.type === "stopped" || event.type === "error" ||
      (event.type === "snapshot" && event.message.status !== "streaming"));
  };

  try {
    if (options.signal?.aborted) throw abortError();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      options.onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_CHAT_STREAM_LINE_LENGTH && !buffer.includes("\n")) {
        throw new ChatStreamProtocolError("El evento recibido supera el límite permitido.");
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        applyLine(line);
        if (terminal) { await reader.cancel().catch(() => undefined); return; }
      }
    }
    buffer += decoder.decode();
    applyLine(buffer);
    if (assembly) throw new ChatStreamProtocolError("El evento fragmentado está incompleto.");
    if (options.signal?.aborted) throw abortError();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
