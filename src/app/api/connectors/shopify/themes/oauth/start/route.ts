import { shopifyErrorCode } from "@/connectors/shopify-server-service";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/auth/session";
import { LOCAL_SESSION_COOKIE } from "@/auth/session-cookie";
import { isSameOriginMutation } from "@/auth/request-security";
import { startThemeOAuth } from "@/connectors/shopify-themes-service";
import { shopifyPublicRequestUrl } from "@/connectors/shopify-request-url";
import { THEMES_START } from "@/connectors/shopify-themes-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: "AUTH_REQUIRED" }, { status: 401, headers });
  if (!await isSameOriginMutation(request)) return NextResponse.json({ code: "ORIGIN_DENIED" }, { status: 403, headers });
  try {
    const sessionId = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value ?? "";
    const url = await startThemeOAuth(session, sessionId, await shopifyPublicRequestUrl(request, THEMES_START));
    return new NextResponse(null, { status: 302, headers: { ...headers, Location: url } });
  } catch (error) { return NextResponse.json({ code: shopifyErrorCode(error) }, { status: 403, headers }); }
}
