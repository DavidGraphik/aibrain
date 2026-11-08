import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { originalServerForSession } from "@/documents/server-browser-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401, headers });
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const path = url.searchParams.get("path") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(projectId) || !/^server-[a-z0-9-]+\/[A-Z]\//i.test(path) || path.length > 1024 || path.includes("?")) {
    return NextResponse.json({ error: "INVALID_REFERENCE" }, { status: 400, headers });
  }
  try {
    const filename = decodeURIComponent(path.split("/").at(-1)!);
    const { bytes, sha256 } = await originalServerForSession(session, projectId, path, request.signal);
    const pdf = /\.pdf$/i.test(filename) && bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"));
    return new Response(new Uint8Array(bytes), { headers: { ...headers,
      "Content-Type": pdf ? "application/pdf" : "application/octet-stream",
      "Content-Length": String(bytes.length), "X-Source-SHA256": sha256,
      "Content-Disposition": `${pdf ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, "%27")}`,
    } });
  } catch {
    return NextResponse.json({ error: "READ_UNAVAILABLE" }, { status: 403, headers });
  }
}
