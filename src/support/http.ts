import { NextResponse } from "next/server";
export const SUPPORT_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function readSupportJson(request: Request, limit = 9 * 1024 * 1024): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > limit) throw Object.assign(new Error("La solicitud es demasiado grande."), { code: "SUPPORT_BODY_TOO_LARGE" });
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw Object.assign(new Error("La solicitud es demasiado grande."), { code: "SUPPORT_BODY_TOO_LARGE" }); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    return null;
  } finally { reader.releaseLock(); }
}
export function supportError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "SUPPORT_UNAVAILABLE";
  const status = code === "SUPPORT_NOT_FOUND" ? 404 : code === "SUPPORT_RATE_LIMITED" ? 429 : code === "SUPPORT_BODY_TOO_LARGE" ? 413 : code === "SUPPORT_IDENTITY_REQUIRED" ? 403 : code === "SUPPORT_IDEMPOTENCY_CONFLICT" ? 409 : ["SUPPORT_INPUT_INVALID", "SUPPORT_SCREENSHOT_INVALID"].includes(code) ? 400 : 503;
  // Storage/implementation errors must not reveal host paths or filesystem contents.
  const message = status === 503 ? "No se ha podido acceder al soporte. Inténtalo de nuevo." : error instanceof Error ? error.message : "No se ha podido guardar la solicitud.";
  return NextResponse.json({ error: message, code }, { status, headers: SUPPORT_HEADERS });
}
