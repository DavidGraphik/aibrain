import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  return session
    ? NextResponse.json({ session }, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json(
      { error: "No autenticat." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
}
