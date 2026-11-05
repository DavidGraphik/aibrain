export type FreezePublicationRequest = {
  operationId: string;
  clientRequestId: string;
  turnId: string;
  uploadId: string;
  targetRelativePath: string;
};

export type DecidePublicationRequest = {
  action: "confirm" | "decline";
  clientRequestId: string;
  turnId: string;
  confirmationToken: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isSafeRelativePath(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 500 ||
      value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isFreezePublicationRequest(value: unknown): value is FreezePublicationRequest {
  return isRecord(value) && exactKeys(value, [
    "operationId", "clientRequestId", "turnId", "uploadId", "targetRelativePath",
  ]) && UUID.test(String(value.operationId)) && REQUEST_ID.test(String(value.clientRequestId)) &&
    UUID.test(String(value.turnId)) && UUID.test(String(value.uploadId)) &&
    isSafeRelativePath(value.targetRelativePath);
}

export function isDecidePublicationRequest(value: unknown): value is DecidePublicationRequest {
  return isRecord(value) && exactKeys(value, [
    "action", "clientRequestId", "turnId", "confirmationToken",
  ]) && (value.action === "confirm" || value.action === "decline") &&
    REQUEST_ID.test(String(value.clientRequestId)) && UUID.test(String(value.turnId)) &&
    typeof value.confirmationToken === "string" && value.confirmationToken.length >= 1 &&
    value.confirmationToken.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value.confirmationToken);
}
