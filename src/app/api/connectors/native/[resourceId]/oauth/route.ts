import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { nativeConnectionFailure, startNativeOAuthForSession } from "@/connectors/native-connection-server-service";
import { nativeOAuthBrowserFailure } from "@/connectors/native-oauth-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

/** Existing connection buttons navigate here. Reject foreign-site navigation
 * before starting OAuth; the provider flow owns state/PKCE and its callback. */
export async function GET(request: Request, context: { params: Promise<{ resourceId: string }> }) {
  if (!await isSameOriginMutation(request)) return nativeOAuthBrowserFailure("ORIGIN_DENIED", 403);
  const session = await getSession();
  if (!session) return nativeOAuthBrowserFailure("AUTH_REQUIRED", 401);
  try {
    const { resourceId } = await context.params;
    const login = await startNativeOAuthForSession(session, resourceId);
    return NextResponse.redirect(login.authorizationUrl, { status: 302, headers });
  } catch (error) {
    const failure = nativeConnectionFailure(error);
    return nativeOAuthBrowserFailure(failure.code, failure.status);
  }
}

/** Provider consent is completed by Codex's own configured OAuth flow. This
 * endpoint returns its URL; it never collects provider codes or credentials. */
export async function POST(request: Request, context: { params: Promise<{ resourceId: string }> }) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ code: "ORIGIN_DENIED" }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ code: "AUTH_REQUIRED" }, { status: 401, headers });
  // The resource is resolved by the server. A caller cannot override server,
  // thread, scopes, client registration or the provider's callback URL.
  const body = await request.text();
  if (body.trim() && body.trim() !== "{}") return NextResponse.json({ code: "NATIVE_CONNECTION_REQUEST_INVALID" }, { status: 400, headers });
  try {
    const { resourceId } = await context.params;
    return NextResponse.json({ schemaVersion: 1, ...await startNativeOAuthForSession(session, resourceId) }, { headers });
  } catch (error) {
    const failure = nativeConnectionFailure(error);
    return NextResponse.json({ code: failure.code }, { status: failure.status, headers });
  }
}
