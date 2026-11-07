import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { codexManagedAppCapabilities } from "@/connectors/server-service";

export const runtime = "nodejs";

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "CONNECTOR_CAPABILITIES_UNAVAILABLE";
}

/** Read-only capability projection. It never returns credentialRef or secrets. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  try {
    return NextResponse.json(
      { schemaVersion: 1, connectors: await codexManagedAppCapabilities(session) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: "No se ha podido comprobar el conector.", code: errorCode(error), retryable: true },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
