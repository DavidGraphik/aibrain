import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { previewServerForSession } from "@/documents/server-browser-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401, headers });
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const path = url.searchParams.get("path") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(projectId) || !/^server-[a-z0-9-]+\/[A-Z]\//i.test(path) || path.length > 1024) {
    return NextResponse.json({ error: "INVALID_REFERENCE" }, { status: 400, headers });
  }
  try {
    return NextResponse.json(await previewServerForSession(session, projectId, path, request.signal), { headers });
  } catch {
    return NextResponse.json({ available: false, error: "READ_UNAVAILABLE" }, { status: 403, headers });
  }
}
