import { privateHorariaRequest } from "@/horaria/private-transport";
import { loadInstallationConfig } from "@/config/installation";
import { bridgeToken, loadHorariaConfig } from "@/horaria/client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const segments = (await context.params).path;
  const webhook = segments.length === 1 && segments[0] === "webhook";
  const media = segments.length === 2 && segments[0] === "media" && /^[a-zA-Z0-9_-]{20,120}$/.test(segments[1]) && ["GET", "HEAD"].includes(request.method);
  if (!webhook && !media) return new Response(null, { status: 404 });
  try {
    const config = await loadHorariaConfig(await loadInstallationConfig());
    if (!config.eventsEnabled) return new Response(null, { status: 404 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1024 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(chunk.value);
      }
    }
    const body = Buffer.concat(chunks);
    const contentType = request.headers.get("content-type") || "";
    const target = webhook ? `/api/whatsapp/webhook${new URL(request.url).search}` : `/api/schedules/published-pdf/${segments[1]}`;
    const actorId = webhook && request.method === "POST" ? config.eventActorId : undefined;
    if (webhook && request.method === "POST" && !actorId) return new Response(null, { status: 503 });
    const token = bridgeToken(config, { ...(actorId ? { actorId, employeeId: config.users[actorId].employeeId } : {}), method: request.method, target, contentType, body, kind: "event" });
    const headers = new Headers({ "x-aibrain-authorization": token });
    for (const name of ["content-type", "x-hub-signature-256", "x-twilio-signature", "x-horaria-webhook-secret"]) {
      const value = request.headers.get(name); if (value) headers.set(name, value);
    }
    const result = await privateHorariaRequest(config.baseUrl, target, { method: request.method, headers, body: body.length ? body : undefined, signal: AbortSignal.timeout(60_000) });
    return new Response(result.body, { status: result.status, headers: { "content-type": result.headers.get("content-type") || "text/plain", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch { return new Response(null, { status: 503 }); }
}
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) { return forward(request, context); }
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) { return forward(request, context); }

export const HEAD = forward;
