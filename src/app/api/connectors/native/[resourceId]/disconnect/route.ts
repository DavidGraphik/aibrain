import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { changeNativeConnection, nativeConnectionFailure } from "@/connectors/native-connection-server-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

/** The existing settings button posts an empty body to disconnectUrl. */
export async function POST(request: Request, context: { params: Promise<{ resourceId: string }> }) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ code: "ORIGIN_DENIED" }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ code: "AUTH_REQUIRED" }, { status: 401, headers });
  const body = await request.text();
  if (body.trim() && body.trim() !== "{}") return NextResponse.json({ code: "NATIVE_CONNECTION_REQUEST_INVALID" }, { status: 400, headers });
  try {
    const { resourceId } = await context.params;
    return NextResponse.json({ schemaVersion: 1, ...await changeNativeConnection(session, resourceId, "disconnect") }, { headers });
  } catch (cause) {
    const failure = nativeConnectionFailure(cause);
    return NextResponse.json({ code: failure.code }, { status: failure.status, headers });
  }
}
