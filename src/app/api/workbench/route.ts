import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { loadWorkbench } from "@/workbench/store";
import { workbenchErrorResponse } from "@/workbench/http";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  try {
    const workbench = await loadWorkbench(session);
    return NextResponse.json(
      { workbench },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return workbenchErrorResponse(error, "No s’ha pogut carregar el workbench.");
  }
}
