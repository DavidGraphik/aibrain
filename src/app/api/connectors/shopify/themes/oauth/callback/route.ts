import { shopifyErrorCode } from "@/connectors/shopify-server-service";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/auth/session";
import { LOCAL_SESSION_COOKIE } from "@/auth/session-cookie";
import { completeThemeOAuth } from "@/connectors/shopify-themes-service";
import { shopifyPublicRequestUrl } from "@/connectors/shopify-request-url";
import { THEMES_CALLBACK } from "@/connectors/shopify-themes-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new NextResponse(null, { status: 303, headers: { ...headers, Location: "/login?settings=connectors" } });
  try {
    const sessionId = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value ?? "";
    await completeThemeOAuth(session, sessionId, await shopifyPublicRequestUrl(request, THEMES_CALLBACK));
    // Fixed relative destination: no request-controlled redirect target and no code/token in the browser response.
    return new NextResponse(null, { status: 303, headers: { ...headers, Location: "/?settings=connectors&shopify_themes=connected" } });
  } catch (error) {
    // Never leave a customer on callback JSON or retain OAuth query secrets.
    const code = shopifyErrorCode(error);
    return new NextResponse(null, { status: 303, headers: { ...headers, Location: "/?settings=connectors&shopify_themes=failed&reason=" + code } });
  }
}
