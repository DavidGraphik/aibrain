import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/auth/request-security";
import { createSupportAccessStore, supportAccessEnabled } from "@/auth/support-access-context";
import { setLocalSessionCookie } from "@/auth/session-cookie";
import { checkAuthRateLimit } from "@/auth/rate-limit-context";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request) {
  if (!await supportAccessEnabled()) return NextResponse.json({ error: "Support access disabled." }, { status: 404, headers });
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403, headers });
  try {
    const limit = await checkAuthRateLimit(request, "login", "support-login");
    if (!limit.allowed) return NextResponse.json({ error: "Massa intents. Torna-ho a provar més tard." }, { status: 429, headers: { ...headers, "Retry-After": String(limit.retryAfterSeconds) } });
    const text = await request.text();
    if (text.length > 256) throw new Error("Invalid support code.");
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "code" || !("code" in body) || typeof body.code !== "string") throw new Error("Invalid support code.");
    const store = await createSupportAccessStore();
    const session = await store.redeem(body.code);
    try { await setLocalSessionCookie(session); }
    catch (error) {
      // Revoke a created session if the browser cookie cannot be installed.
      const { createLocalSessionContext } = await import("@/auth/auth-context");
      await (await createLocalSessionContext()).sessions.delete(session.sessionId);
      throw error;
    }
    return NextResponse.json({ authenticated: true, support: true, expiresAt: session.record.absoluteExpiresAt }, { headers });
  } catch { return NextResponse.json({ error: "El codi de suport no és vàlid o ha caducat." }, { status: 400, headers }); }
}
