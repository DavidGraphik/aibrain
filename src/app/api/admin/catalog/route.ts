import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/auth/request-security";
import { getSession } from "@/auth/session";
import { isCatalogCommand } from "@/catalog/contracts";
import { CatalogAdminError, catalogSnapshot, executeCatalogCommand } from "@/catalog/server-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

function failure(error: unknown) {
  if (error instanceof CatalogAdminError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
  return NextResponse.json({ error: "No se ha podido completar el catálogo.", code: "CATALOG_UNAVAILABLE" }, { status: 503, headers });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado.", code: "AUTH_REQUIRED" }, { status: 401, headers });
  try { return NextResponse.json(await catalogSnapshot(session), { headers }); } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado.", code: "ORIGIN_NOT_ALLOWED" }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado.", code: "AUTH_REQUIRED" }, { status: 401, headers });
  const command: unknown = await request.json().catch(() => null);
  if (!isCatalogCommand(command)) return NextResponse.json({ error: "La operación de catálogo no es válida.", code: "CATALOG_COMMAND_INVALID" }, { status: 400, headers });
  try { return NextResponse.json(await executeCatalogCommand(session, command), { headers }); } catch (error) { return failure(error); }
}
