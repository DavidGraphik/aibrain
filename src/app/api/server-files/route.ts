import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { browseServerForSession } from "@/documents/server-browser-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  if (session.tenant.id === "trinalum-production") return NextResponse.json({ available: false, warning: "Esta instalación no utiliza archivos de servidor." }, { status: 403, headers });
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const query = url.searchParams.get("query") ?? "server:/";
  if (!/^[0-9a-f-]{36}$/.test(projectId) || (query !== "home" && !query.startsWith("server:/")) || query.length > 200) {
    return NextResponse.json({ error: "Ubicación no válida." }, { status: 400, headers });
  }
  try {
    return NextResponse.json(await browseServerForSession(session, projectId, query, request.signal), { headers });
  } catch {
    return NextResponse.json({ available: false, warning: "No se ha podido consultar esta ubicación con tus permisos." }, { status: 403, headers });
  }
}
