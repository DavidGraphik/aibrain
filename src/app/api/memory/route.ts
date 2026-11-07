import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import {
  isCreateExplicitMemoryRequest,
  parseMemoryListQuery,
} from "@/memory/http-contract";
import { MemoryServiceError } from "@/memory/local-file-memory-service";
import { memoryServiceForSession } from "@/memory/server-service";
import { StorageError } from "@/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function memoryError(error: unknown) {
  const code = error instanceof MemoryServiceError || error instanceof StorageError
    ? error.code
    : "MEMORY_UNAVAILABLE";
  if (code === "MEMORY_IDEMPOTENCY_CONFLICT") {
    return NextResponse.json({ error: "Aquesta petició ja identifica una altra memòria." }, { status: 409 });
  }
  if (code.endsWith("_INVALID") || code === "STORAGE_SCHEMA_INVALID") {
    return NextResponse.json({ error: "La petició de memòria no és vàlida." }, { status: 400 });
  }
  return NextResponse.json({ error: "La memòria persistent no està disponible." }, { status: 503 });
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const query = parseMemoryListQuery(new URL(request.url).searchParams);
  if (!query) return NextResponse.json({ error: "Consulta no vàlida." }, { status: 400 });
  try {
    const { service, context } = await memoryServiceForSession(session);
    return NextResponse.json(
      { memories: await service.list(context, query) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return memoryError(error);
  }
}

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!isCreateExplicitMemoryRequest(body)) {
    return NextResponse.json({ error: "La memòria explícita no és vàlida." }, { status: 400 });
  }
  try {
    const { service, context } = await memoryServiceForSession(session);
    const result = await service.remember(context, {
      explicit: true,
      kind: body.kind,
      content: body.content,
      idempotencyKey: `manual:${body.clientRequestId}`,
      provenance: {
        sourceType: "manual",
        sourceId: body.clientRequestId,
        sourceExcerpt: body.sourceExcerpt,
        capturedAt: new Date().toISOString(),
      },
    });
    return NextResponse.json(result, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return memoryError(error);
  }
}
