import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/auth/request-security";
import { deleteSession } from "@/auth/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  await deleteSession();
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
