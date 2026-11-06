import { getSession } from "@/auth/session";
import { finishNativeOAuthForSession, nativeConnectionFailure } from "@/connectors/native-connection-server-service";
import { nativeOAuthBrowserFailure, nativeOAuthBrowserResult } from "@/connectors/native-oauth-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Provider navigation is cross-site. The current session, single-use native
 * state digest and exact worker lease authorize it; ordinary mutation-origin
 * checks intentionally remain on initiation/disconnect rather than this return. */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return nativeOAuthBrowserFailure("AUTH_REQUIRED", 401);
  try {
    const result = await finishNativeOAuthForSession(session, request.url);
    return nativeOAuthBrowserResult(result);
  } catch (cause) {
    const failure = nativeConnectionFailure(cause);
    return nativeOAuthBrowserFailure(failure.code, failure.status);
  }
}
