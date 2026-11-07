import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { loadInstallationConfig } from "@/config/installation";
import { FileUserLanguageStore } from "@/i18n/user-language-store";
import { isUiLocale } from "@/i18n/locale";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function PATCH(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ code: "ORIGIN_NOT_ALLOWED", error: "Origin not allowed." }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ code: "AUTH_REQUIRED", error: "Sign in required." }, { status: 401, headers });
  const installation = await loadInstallationConfig();
  if (session.tenant.id !== installation.installationId) return NextResponse.json({ code: "TENANT_NOT_ALLOWED", error: "Workspace mismatch." }, { status: 403, headers });
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("locale" in body) || !isUiLocale(body.locale)) return NextResponse.json({ code: "LOCALE_INVALID", error: "Choose Català, English or Español." }, { status: 400, headers });
  try {
    const locale = await new FileUserLanguageStore(installation.installationId, installation.paths.dataRoot).write(session.user.id, body.locale);
    return NextResponse.json({ locale }, { headers });
  } catch {
    return NextResponse.json({ code: "LOCALE_SAVE_FAILED", error: "Could not save the interface language." }, { status: 503, headers });
  }
}
