import { expect, it } from "vitest";
import { parseAppServerEvent, parseServerFrame, TransportProtocolError, validateAppServerRequest } from "./wire-protocol";

const message = "Invalid request: unknown variant ``, expected one of `user`, `auto_review`, `guardian_subagent`\n\tin `apps._default.approvals_reviewer`\r\n";
const event = (errorMessage = message) => ({ eventId: "response-1", sequence: 1, occurredAt: "2026-10-16T00:00:00.000Z",
  message: { kind: "rpc-response", rpc: { id: "thread-start:exact", error: { code: -32600, message: errorMessage } } } });

it("roundtrips the real multiline RPC validation error without changing diagnostic bytes", () => {
  const source = event();
  expect(parseAppServerEvent(JSON.parse(JSON.stringify(source)))).toEqual(source);
  expect(parseServerFrame(JSON.stringify({ protocolVersion: 1, type: "event", event: source }))).toEqual({ protocolVersion: 1, type: "event", event: source });
  expect(() => validateAppServerRequest({ clientRequestId: "reply", kind: "rpc-response", rpc: source.message.rpc })).not.toThrow();
  expect(parseServerFrame(JSON.stringify({ protocolVersion: 1, type: "rejected", clientRequestId: "exact", error: { code: -32600, message, retryable: false } }))).toMatchObject({ error: { message } });
});

it.each(["", "x".repeat(2049), "unsafe\u0000", "unsafe\u0007", "unsafe\u000b", "unsafe\u000c", "unsafe\u001b", "unsafe\u007f"])("rejects empty, oversized or unsafe diagnostic text %j", value => {
  expect(() => parseAppServerEvent(event(value))).toThrow(TransportProtocolError);
  expect(() => parseServerFrame(JSON.stringify({ protocolVersion: 1, type: "rejected", clientRequestId: "exact", error: { code: -32600, message: value, retryable: false } }))).toThrow(TransportProtocolError);
});

it.each(["line\nidentity", "line\ridentity", "tab\tidentity", "unsafe\u001b"])("keeps every identity strict despite multiline diagnostics: %j", identity => {
  expect(() => parseAppServerEvent({ ...event(), eventId: identity })).toThrow(TransportProtocolError);
  expect(() => parseAppServerEvent({ ...event(), message: { kind: "rpc-response", rpc: { ...event().message.rpc, id: identity } } })).toThrow(TransportProtocolError);
  expect(() => parseServerFrame(JSON.stringify({ protocolVersion: 1, type: "accepted", clientRequestId: identity }))).toThrow(TransportProtocolError);
});
