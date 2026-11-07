import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { isSettingsPatch } from "@/settings/contracts";
import { settingsSnapshot, updateSettings } from "@/settings/server-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado.", code: "AUTH_REQUIRED" }, { status: 401, headers: HEADERS });
  try {
    return NextResponse.json(await settingsSnapshot(session), { headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "No se ha podido cargar la configuración.", code: "SETTINGS_UNAVAILABLE" }, { status: 503, headers: HEADERS });
  }
}

export async function PATCH(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autorizado.", code: "ORIGIN_REQUIRED" }, { status: 403, headers: HEADERS });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado.", code: "AUTH_REQUIRED" }, { status: 401, headers: HEADERS });
  const body: unknown = await request.json().catch(() => null);
  if (!isSettingsPatch(body)) {
    return NextResponse.json({ error: "La configuración no es válida.", code: "SETTINGS_PATCH_INVALID" }, { status: 400, headers: HEADERS });
  }
  try {
    return NextResponse.json(await updateSettings(session, body), { headers: HEADERS });
  } catch (error) {
    const adminRequired = error && typeof error === "object" && "code" in error && error.code === "SETTINGS_ADMIN_REQUIRED";
    return NextResponse.json({
      error: adminRequired ? "Solo un administrador puede cambiar esta disponibilidad." : "No se ha podido guardar la configuración.",
      code: adminRequired ? "SETTINGS_ADMIN_REQUIRED" : "SETTINGS_UPDATE_FAILED",
    }, { status: adminRequired ? 403 : 503, headers: HEADERS });
  }
}
