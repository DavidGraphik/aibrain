import { NextResponse } from "next/server";
import { isWorkspaceAdmin } from "@/admin/server-service";
import { getSession } from "@/auth/session";
import { activeTeamMembers } from "@/settings/team-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autenticat.", code: "AUTH_REQUIRED" }, {
      status: 401,
      headers: HEADERS,
    });
  }
  if (!await isWorkspaceAdmin(session)) {
    return NextResponse.json({ error: "No tienes permisos para consultar el equipo.", code: "SETTINGS_ADMIN_REQUIRED" }, {
      status: 403,
      headers: HEADERS,
    });
  }
  try {
    return NextResponse.json({ schemaVersion: 1, members: await activeTeamMembers() }, {
      headers: HEADERS,
    });
  } catch {
    return NextResponse.json({ error: "No s’ha pogut consultar l’equip.", code: "TEAM_UNAVAILABLE" }, {
      status: 503,
      headers: HEADERS,
    });
  }
}
