import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { workbenchErrorResponse } from "@/workbench/http";
import { listThreads } from "@/workbench/store";
import { parseWorkbenchListQuery } from "@/workbench/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const query = parseWorkbenchListQuery(new URL(request.url).searchParams);
  if (!query) {
    return NextResponse.json({ error: "La consulta de fils no és vàlida." }, { status: 400 });
  }
  try {
    const page = await listThreads(session, null, query);
    return NextResponse.json(
      { threads: page.items, nextCursor: page.nextCursor },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return workbenchErrorResponse(error, "No s’han pogut carregar els fils.");
  }
}
