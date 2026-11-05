import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { readSupportScreenshot } from "@/support/server-service";
import { supportError, SUPPORT_HEADERS as headers } from "@/support/http";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string; screenshotId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  try {
    const { id, screenshotId } = await context.params;
    const screenshot = await readSupportScreenshot(session, id, screenshotId);
    if (!screenshot) return NextResponse.json({ error: "Captura no encontrada." }, { status: 404, headers });
    return new Response(new Uint8Array(screenshot.data), { headers: { ...headers, "Content-Type": screenshot.mimeType, "Content-Length": String(screenshot.data.length), "Content-Security-Policy": "default-src 'none'; sandbox" } });
  } catch (error) { return supportError(error); }
}
