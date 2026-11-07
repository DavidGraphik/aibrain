import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { updateMessageActivity } from "@/workbench/store";
import { workbenchErrorResponse } from "@/workbench/http";

export const runtime = "nodejs";

const actions = new Set(["approved", "pending", "undo_waiting", "undo_complete"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string; messageId: string }> },
) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  const action = body && typeof body === "object" && "action" in body ? body.action : null;
  if (typeof action !== "string" || !actions.has(action)) {
    return NextResponse.json({ error: "Acció de resultat no vàlida." }, { status: 400 });
  }
  const { threadId, messageId } = await context.params;
  const now = new Date().toISOString();
  const item = action === "approved"
    ? { id: "result-review", kind: "system" as const, label: "Resultat aprovat", detail: `Aprovat per ${session.user.name} · ${now}`, status: "complete" as const }
    : action === "pending"
      ? { id: "result-review", kind: "system" as const, label: "Resultat pendent de revisió", detail: `Actualitzat per ${session.user.name} · ${now}`, status: "waiting" as const }
      : action === "undo_waiting"
        ? { id: "result-undo", kind: "system" as const, label: "Revertint els canvis", detail: "L'aplicació conservarà el resultat original i verificarà la reversió.", status: "waiting" as const }
        : { id: "result-undo", kind: "system" as const, label: "Canvis revertits i verificats", detail: `Reversió completada · ${now}`, status: "complete" as const };
  try {
    const message = await updateMessageActivity(session, threadId, messageId, item);
    return NextResponse.json({ message }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return workbenchErrorResponse(error, "No s’ha pogut actualitzar el resultat.");
  }
}
