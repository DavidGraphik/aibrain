import type {
  AppServerEvent,
  AppServerRequest,
  JsonRpcFailure,
  JsonRpcSuccess,
  JsonValue,
} from "@/runtime/transport/contracts";
import { APP_SERVER_TRANSPORT_PROTOCOL_VERSION } from "@/runtime/transport/contracts";
import {
  assertCodexClientNotification,
  assertCodexClientRequest,
  assertCodexServerNotification,
  assertCodexServerRequest,
} from "@/runtime/transport/codex-contract-validation";

export type WorkerClientFrame =
  | {
      protocolVersion: 1;
      type: "resume";
      afterEventId: string | null;
      afterSequence: number | null;
    }
  | {
      protocolVersion: 1;
      type: "request";
      request: AppServerRequest;
    }
  | {
      protocolVersion: 1;
      type: "event-ack";
      eventId: string;
      sequence: number;
    }
  | {
      protocolVersion: 1;
      type: "ping";
      nonce: string;
      sentAt: string;
    };

export type WorkerServerFrame =
  | {
      protocolVersion: 1;
      type: "ready";
      sessionId: string;
      replaySupported: true;
    }
  | {
      protocolVersion: 1;
      type: "accepted";
      clientRequestId: string;
    }
  | {
      protocolVersion: 1;
      type: "event";
      event: AppServerEvent;
    }
  | {
      protocolVersion: 1;
      type: "pong";
      nonce: string;
      receivedAt: string;
    }
  | {
      protocolVersion: 1;
      type: "rejected";
      clientRequestId: string;
      error: {
        code: number;
        message: string;
        retryable: boolean;
        retryAfterMs?: number;
      };
    }
  | {
      protocolVersion: 1;
      type: "overloaded";
      retryAfterMs?: number;
    };

export class TransportProtocolError extends Error {
  readonly code = "TRANSPORT_PROTOCOL_ERROR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TransportProtocolError(`${context} contains unknown field ${key}.`);
    }
  }
}

function requiredString(value: unknown, context: string, maxLength = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TransportProtocolError(`${context} must be a non-empty safe string.`);
  }
  return value;
}

/** Diagnostic RPC text may contain JSON-escaped line breaks, unlike identities. */
function requiredErrorMessage(value: unknown, context: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TransportProtocolError(`${context} must be bounded safe diagnostic text.`);
  }
  return value;
}

function requestId(value: unknown, context: string) {
  if (typeof value === "string") return requiredString(value, context);
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new TransportProtocolError(`${context} must be a string or safe integer.`);
}

function nonNegativeInteger(value: unknown, context: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TransportProtocolError(`${context} must be a non-negative safe integer.`);
  }
  return value as number;
}

function jsonValue(value: unknown, context: string, depth = 0): asserts value is JsonValue {
  if (depth > 64) throw new TransportProtocolError(`${context} exceeds the maximum nesting depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) jsonValue(item, context, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        throw new TransportProtocolError(`${context}.${key} contains unsupported undefined.`);
      }
      jsonValue(item, context, depth + 1);
    }
    return;
  }
  throw new TransportProtocolError(`${context} must contain only JSON values.`);
}

function rpcSuccessOrFailure(value: unknown, context: string): JsonRpcSuccess | JsonRpcFailure {
  if (!isRecord(value)) throw new TransportProtocolError(`${context} must be an object.`);
  if ("result" in value) {
    exactKeys(value, ["id", "result"], context);
    requestId(value.id, `${context}.id`);
    jsonValue(value.result, `${context}.result`);
    return value as JsonRpcSuccess;
  }
  exactKeys(value, ["id", "error"], context);
  requestId(value.id, `${context}.id`);
  if (!isRecord(value.error)) throw new TransportProtocolError(`${context}.error must be an object.`);
  exactKeys(value.error, ["code", "message", "data"], `${context}.error`);
  if (!Number.isSafeInteger(value.error.code)) throw new TransportProtocolError(`${context}.error.code must be an integer.`);
  requiredErrorMessage(value.error.message, `${context}.error.message`);
  if (value.error.data !== undefined) jsonValue(value.error.data, `${context}.error.data`);
  return value as JsonRpcFailure;
}

export function validateAppServerRequest(value: unknown): asserts value is AppServerRequest {
  if (!isRecord(value)) throw new TransportProtocolError("request must be an object.");
  exactKeys(value, ["clientRequestId", "kind", "rpc"], "request");
  const clientRequestId = requiredString(value.clientRequestId, "request.clientRequestId", 128);
  if (value.kind === "rpc-request") {
    if (!isRecord(value.rpc)) throw new TransportProtocolError("request.rpc must be an object.");
    jsonValue(value.rpc, "request.rpc");
    assertCodexClientRequest(value.rpc);
    if (value.rpc.id !== clientRequestId) {
      throw new TransportProtocolError("request.rpc.id must equal clientRequestId for client requests.");
    }
    return;
  }
  if (value.kind === "rpc-notification") {
    jsonValue(value.rpc, "request.rpc");
    assertCodexClientNotification(value.rpc);
    return;
  }
  if (value.kind === "rpc-response") {
    rpcSuccessOrFailure(value.rpc, "request.rpc");
    return;
  }
  throw new TransportProtocolError("request.kind is invalid.");
}

export function parseAppServerEvent(value: unknown): AppServerEvent {
  if (!isRecord(value)) throw new TransportProtocolError("event must be an object.");
  exactKeys(value, ["eventId", "sequence", "occurredAt", "message"], "event");
  requiredString(value.eventId, "event.eventId");
  if (nonNegativeInteger(value.sequence, "event.sequence") < 1) {
    throw new TransportProtocolError("event.sequence must be a positive safe integer.");
  }
  const occurredAt = requiredString(value.occurredAt, "event.occurredAt", 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
    throw new TransportProtocolError("event.occurredAt must be an ISO-8601 UTC timestamp.");
  }
  if (!isRecord(value.message)) throw new TransportProtocolError("event.message must be an object.");
  exactKeys(value.message, ["kind", "rpc"], "event.message");
  if (value.message.kind === "rpc-response") rpcSuccessOrFailure(value.message.rpc, "event.message.rpc");
  else if (value.message.kind === "rpc-request") {
    jsonValue(value.message.rpc, "event.message.rpc");
    assertCodexServerRequest(value.message.rpc);
  } else if (value.message.kind === "rpc-notification") {
    jsonValue(value.message.rpc, "event.message.rpc");
    assertCodexServerNotification(value.message.rpc);
  }
  else throw new TransportProtocolError("event.message.kind is invalid.");
  return value as AppServerEvent;
}

export function serializeClientFrame(frame: WorkerClientFrame) {
  return JSON.stringify(frame);
}

export function parseServerFrame(raw: unknown): WorkerServerFrame {
  if (typeof raw !== "string") throw new TransportProtocolError("WebSocket frames must be UTF-8 text.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TransportProtocolError("WebSocket frame is not valid JSON.");
  }
  if (!isRecord(value)) throw new TransportProtocolError("WebSocket frame must be an object.");
  if (value.protocolVersion !== APP_SERVER_TRANSPORT_PROTOCOL_VERSION) {
    throw new TransportProtocolError("Unsupported worker transport protocol version.");
  }
  if (value.type === "ready") {
    exactKeys(value, ["protocolVersion", "type", "sessionId", "replaySupported"], "ready frame");
    requiredString(value.sessionId, "ready.sessionId");
    if (value.replaySupported !== true) throw new TransportProtocolError("Worker must support replay.");
  } else if (value.type === "accepted") {
    exactKeys(value, ["protocolVersion", "type", "clientRequestId"], "accepted frame");
    requiredString(value.clientRequestId, "accepted.clientRequestId", 128);
  } else if (value.type === "event") {
    exactKeys(value, ["protocolVersion", "type", "event"], "event frame");
    value.event = parseAppServerEvent(value.event);
  } else if (value.type === "pong") {
    exactKeys(value, ["protocolVersion", "type", "nonce", "receivedAt"], "pong frame");
    requiredString(value.nonce, "pong.nonce", 128);
    requiredString(value.receivedAt, "pong.receivedAt", 64);
  } else if (value.type === "rejected") {
    exactKeys(value, ["protocolVersion", "type", "clientRequestId", "error"], "rejected frame");
    requiredString(value.clientRequestId, "rejected.clientRequestId", 128);
    if (!isRecord(value.error)) throw new TransportProtocolError("rejected.error must be an object.");
    exactKeys(value.error, ["code", "message", "retryable", "retryAfterMs"], "rejected.error");
    if (!Number.isSafeInteger(value.error.code)) throw new TransportProtocolError("rejected.error.code must be an integer.");
    requiredErrorMessage(value.error.message, "rejected.error.message");
    if (typeof value.error.retryable !== "boolean") throw new TransportProtocolError("rejected.error.retryable must be boolean.");
    if (value.error.retryAfterMs !== undefined) nonNegativeInteger(value.error.retryAfterMs, "rejected.error.retryAfterMs");
  } else if (value.type === "overloaded") {
    exactKeys(value, ["protocolVersion", "type", "retryAfterMs"], "overloaded frame");
    if (value.retryAfterMs !== undefined) nonNegativeInteger(value.retryAfterMs, "overloaded.retryAfterMs");
  } else {
    throw new TransportProtocolError("Unknown worker frame type.");
  }
  return value as WorkerServerFrame;
}
