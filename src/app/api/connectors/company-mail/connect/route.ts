import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { companyMailContext, connectCompanyMail } from "@/connectors/company-mail-server-service";
import { CompanyMailError } from "@/connectors/company-mail-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie" };
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  try {
    const { config } = await companyMailContext(session);
    return NextResponse.redirect(new URL("/?settings=connectors&connect=company-mail", config.publicUrl), { headers });
  } catch { return NextResponse.json({ error: "Conector no disponible." }, { status: 403, headers }); }
}
export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  try {
    // Do not use request.json(): enforce a real body bound before parsing secrets.
    if (!request.body) throw new CompanyMailError("MAIL_INPUT_INVALID", "Completa los datos del buzón.");
    const reader = request.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 8192) throw new CompanyMailError("MAIL_INPUT_TOO_LARGE", "Datos de conexión demasiado grandes.", 413);
        chunks.push(result.value);
      }
    } finally { await reader.cancel(); }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return NextResponse.json(await connectCompanyMail(session, input), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof CompanyMailError ? error.message : "No se ha podido conectar el buzón.",
      code: error instanceof CompanyMailError ? error.code : "MAIL_CONNECT_FAILED" }, { status: error instanceof CompanyMailError ? error.status : 400, headers });
  }
}
