import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { isWorkspaceAdmin } from "@/admin/server-service";
import { loadInstallationConfig } from "@/config/installation";
import { FileInstallationLanguageStore } from "@/i18n/installation-language-store";
import { isUiLocale } from "@/i18n/locale";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function PATCH(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ code: "ORIGIN_NOT_ALLOWED", error: "Origin not allowed." }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ code: "AUTH_REQUIRED", error: "Sign in required." }, { status: 401, headers });
  const installation = await loadInstallationConfig();
  if (session.tenant.id !== installation.installationId || !await isWorkspaceAdmin(session)) return NextResponse.json({ code: "ADMIN_ROLE_REQUIRED", error: "Workspace administrator required." }, { status: 403, headers });
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("locale" in body) || !isUiLocale(body.locale)) return NextResponse.json({ code: "LOCALE_INVALID", error: "Choose English or Spanish." }, { status: 400, headers });
  try {
    const locale = await new FileInstallationLanguageStore(installation.installationId, installation.paths.dataRoot).write(body.locale, session.user.id);
    return NextResponse.json({ locale }, { headers });
  } catch {
    return NextResponse.json({ code: "LOCALE_SAVE_FAILED", error: "Could not save the interface language." }, { status: 503, headers });
  }
}
