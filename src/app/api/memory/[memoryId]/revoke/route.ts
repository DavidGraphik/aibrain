import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { isRevokeExplicitMemoryRequest } from "@/memory/http-contract";
import { MemoryServiceError } from "@/memory/local-file-memory-service";
import { memoryServiceForSession } from "@/memory/server-service";
import { StorageError } from "@/storage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ memoryId: string }> };

function memoryError(error: unknown) {
  const code = error instanceof MemoryServiceError || error instanceof StorageError
    ? error.code
    : "MEMORY_UNAVAILABLE";
  if (code === "MEMORY_NOT_FOUND") {
    return NextResponse.json({ error: "Memòria no trobada." }, { status: 404 });
  }
  if (code === "MEMORY_IDEMPOTENCY_CONFLICT") {
    return NextResponse.json({ error: "Aquesta petició ja identifica una altra operació." }, { status: 409 });
  }
  if (code.endsWith("_INVALID") || code === "STORAGE_SCHEMA_INVALID") {
    return NextResponse.json({ error: "La revocació no és vàlida." }, { status: 400 });
  }
  return NextResponse.json({ error: "La memòria persistent no està disponible." }, { status: 503 });
}

export async function POST(request: Request, route: RouteContext) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!isRevokeExplicitMemoryRequest(body)) {
    return NextResponse.json({ error: "La revocació explícita no és vàlida." }, { status: 400 });
  }
  const { memoryId } = await route.params;
  try {
    const { service, context } = await memoryServiceForSession(session);
    const result = await service.revoke(context, {
      explicit: true,
      memoryId,
      reason: body.reason,
      idempotencyKey: `revoke:${body.clientRequestId}`,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return memoryError(error);
  }
}
