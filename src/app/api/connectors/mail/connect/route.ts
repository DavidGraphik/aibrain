import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { checkAuthRateLimit } from "@/auth/rate-limit-context";
import { connectMail } from "@/connectors/mail-server-service";
import { isMailRecord, MailConnectorError, mailErrorCode } from "@/connectors/mail-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ code: "ORIGIN_REQUIRED" }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ code: "AUTH_REQUIRED" }, { status: 401, headers });
  try {
    const rate = await checkAuthRateLimit(request, "login", `mail:${session.user.id}`);
    if (!rate.allowed) return NextResponse.json({ code: "MAIL_RATE_LIMITED" }, { status: 429, headers: { ...headers, "Retry-After": String(rate.retryAfterSeconds) } });
    if (Number(request.headers.get("content-length")) > 4096) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID", 413);
    const reader = request.body?.getReader(); if (!reader) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 4096) { await reader.cancel(); throw new MailConnectorError("MAIL_ARGUMENTS_INVALID", 413); } chunks.push(chunk.value); }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown; try { body = JSON.parse(text); } catch { throw new MailConnectorError("MAIL_ARGUMENTS_INVALID"); }
    if (!isMailRecord(body) || Object.keys(body).some(key => key !== "password")) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
    return NextResponse.json(await connectMail(session, body.password), { headers });
  } catch (error) { const code = mailErrorCode(error); return NextResponse.json({ error: "No se ha podido conectar el correo.", code }, { status: code === "MAIL_AUTH_FAILED" ? 422 : error instanceof MailConnectorError ? error.status : 503, headers }); }
}
