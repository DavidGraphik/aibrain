import type { AppServerEvent, JsonValue } from "../transport/contracts";
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function asJsonValue(value: unknown) { return value as JsonValue; }
export function parseAppServerOutput(value: unknown): AppServerEvent["message"] {
  if (!isRecord(value)) throw new Error("Codex App Server emitted a non-object message.");
  if ((typeof value.id === "string" || typeof value.id === "number") && typeof value.method === "string") {
    return { kind: "rpc-request", rpc: value as never };
  }
  if (typeof value.method === "string" && value.id === undefined) {
    return { kind: "rpc-notification", rpc: value as never };
  }
  if (typeof value.id === "string" || typeof value.id === "number") {
    if ("result" in value) return { kind: "rpc-response", rpc: { id: value.id, result: asJsonValue(value.result) } };
    if (isRecord(value.error) && Number.isSafeInteger(value.error.code) && typeof value.error.message === "string") {
      return {
        kind: "rpc-response",
        rpc: {
          id: value.id,
          error: {
            code: value.error.code as number,
            message: value.error.message,
            ...(value.error.data === undefined ? {} : { data: asJsonValue(value.error.data) }),
          },
        },
      };
    }
  }
  throw new Error("Codex App Server emitted an unsupported JSON-RPC message.");
}
