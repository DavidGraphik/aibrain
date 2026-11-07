import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { changeNativeConnection, nativeConnectionFailure, nativeConnectionStatus } from "@/connectors/native-connection-server-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
type RouteContext = { params: Promise<{ resourceId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: "AUTH_REQUIRED" }, { status: 401, headers });
  try {
    const { resourceId } = await context.params;
    return NextResponse.json({ schemaVersion: 1, connection: await nativeConnectionStatus(session, resourceId) }, { headers });
  } catch (error) {
    const failure = nativeConnectionFailure(error);
    return NextResponse.json({ code: failure.code }, { status: failure.status, headers });
  }
}

export async function POST(request: Request, context: RouteContext) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ code: "ORIGIN_DENIED" }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ code: "AUTH_REQUIRED" }, { status: 401, headers });
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !("operation" in body) || !["enable", "disconnect"].includes(String(body.operation))) {
    return NextResponse.json({ code: "NATIVE_CONNECTION_REQUEST_INVALID" }, { status: 400, headers });
  }
  try {
    const { resourceId } = await context.params;
    return NextResponse.json({ schemaVersion: 1, ...await changeNativeConnection(session, resourceId, body.operation as "enable" | "disconnect") }, { headers });
  } catch (error) {
    const failure = nativeConnectionFailure(error);
    return NextResponse.json({ code: failure.code }, { status: failure.status, headers });
  }
}
