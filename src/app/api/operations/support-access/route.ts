import { NextResponse } from "next/server";
import { isOperatorAuthorized } from "@/operations/operator-auth";
import { isSameOriginMutation } from "@/auth/request-security";
import { createSupportAccessStore, supportAccessEnabled } from "@/auth/support-access-context";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
async function handle(request: Request, revoke: boolean) {
  if (!isOperatorAuthorized(request)) return NextResponse.json({ error: "Operator authentication required." }, { status: 401, headers });
  if (!await supportAccessEnabled()) return NextResponse.json({ error: "Support access disabled." }, { status: 404, headers });
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origin not authorized." }, { status: 403, headers });
  try {
    const text = await request.text();
    if (text.length > 4096) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers });
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid request.");
    const item = body as Record<string, unknown>;
    const store = await createSupportAccessStore();
    if (revoke) {
      if (Object.keys(item).join(",") !== "grantId" || typeof item.grantId !== "string") throw new Error("Invalid request.");
      return NextResponse.json(await store.revoke(item.grantId), { headers });
    }
    const keys=Object.keys(item).sort().join(",");
    if ((keys !== "actorEmail,actorUserId,reason,targetEmail,targetUserId" &&
        keys !== "actorEmail,actorUserId,previewAppId,previewThreadId,reason,targetEmail,targetUserId")
      || Object.values(item).some(value => typeof value !== "string")) throw new Error("Invalid request.");
    return NextResponse.json(await store.issue(item as { targetUserId: string; targetEmail: string; actorUserId: string; actorEmail: string; reason: string; previewAppId?:string;previewThreadId?:string }), { headers });
  } catch { return NextResponse.json({ error: "Support operation unavailable." }, { status: 400, headers }); }
}
export async function POST(request: Request) { return handle(request, false); }
export async function DELETE(request: Request) { return handle(request, true); }
