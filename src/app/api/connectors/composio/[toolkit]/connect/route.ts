import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { startComposio } from "@/connectors/composio-service";
import { loadInstallationConfig } from "@/config/installation";
import { ComposioError } from "@/connectors/composio-api";
import { operationalLogger } from "@/operations/server-logger";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request, context: { params: Promise<{ toolkit: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Inicia sesión para conectar tu cuenta." }, { status: 401, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  try { return NextResponse.redirect(await startComposio(session, (await context.params).toolkit), 303); }
  catch (error) {
    // Record only our bounded diagnostic code, never provider payloads or OAuth URLs.
    operationalLogger.warn("connectors.composio_connect_failed", { code: error instanceof ComposioError ? error.code : "COMPOSIO_UNAVAILABLE" });
    const { publicUrl } = await loadInstallationConfig();
    return NextResponse.redirect(new URL("/?settings=connectors&connection=failed", publicUrl), { status: 303, headers });
  }
}
