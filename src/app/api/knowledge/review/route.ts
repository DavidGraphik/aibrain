import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { audience, command, UUID } from "@/knowledge/review-contract";
import { KnowledgeReviewError, knowledgeReviewScopes, listKnowledgeReviews, reviewKnowledge } from "@/knowledge/review-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const fail = (code: string, status: number) => NextResponse.json({ error: code === "REVISION_CONFLICT" ? "El registro ha cambiado. Actualiza la lista antes de revisarlo." : code === "CORRECTION_UNCHANGED" ? "La corrección debe cambiar el texto del registro." : code === "INVALID_KNOWLEDGE_TEXT" ? "Revisa el texto y el motivo: no pueden estar vacíos ni contener credenciales." : "La revisión no está disponible o no tienes permiso para este ámbito.", code }, { status, headers });
function failure(error: unknown) { return error instanceof KnowledgeReviewError ? fail(error.code, error.status) : fail("REVIEW_UNAVAILABLE", 503); }

export async function GET(request: Request) {
  const session = await getSession(); if (!session) return fail("AUTH_REQUIRED", 401);
  const query = new URL(request.url).searchParams;
  if (!query.has("scope")) {
    const projectId = query.get("projectId") ?? "";
    if ([...query.keys()].some((k) => k !== "projectId") || !UUID.test(projectId)) return fail("INVALID_REVIEW_QUERY", 400);
    try { return NextResponse.json(await knowledgeReviewScopes(session, projectId), { headers }); }
    catch (error) { return failure(error); }
  }
  const input = { projectId: query.get("projectId") ?? "", scope: query.get("scope") ?? "company", scopeId: query.get("scopeId"),
    status: query.get("status") ?? "proposed", cursor: Number(query.get("cursor") ?? "0"), ...(query.get("connectionId") ? { connectionId: query.get("connectionId")! } : {}) };
  if ([...query.keys()].some((key) => !["projectId", "scope", "scopeId", "status", "cursor", "connectionId"].includes(key)) || !UUID.test(input.projectId) || !audience(input) ||
    !["proposed", "confirmed"].includes(input.status) || !Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.connectionId && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.connectionId)) return fail("INVALID_REVIEW_QUERY", 400);
  try { return NextResponse.json(await listKnowledgeReviews(session, { ...input, status: input.status as "proposed" | "confirmed" }), { headers }); }
  catch (error) { return failure(error); }
}

async function body(request: Request) {
  const reader = request.body?.getReader(); if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const value = await reader.read(); if (value.done) break;
    size += value.value.byteLength;
    if (size > 65536) { await reader.cancel(); return null; }
    chunks.push(value.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) return fail("ORIGIN_NOT_ALLOWED", 403);
  const session = await getSession(); if (!session) return fail("AUTH_REQUIRED", 401);
  const input: unknown = await body(request).catch(() => null);
  if (!command(input)) return fail("INVALID_REVIEW_COMMAND", 400);
  try { return NextResponse.json(await reviewKnowledge(session, input), { headers }); }
  catch (error) { return failure(error); }
}
