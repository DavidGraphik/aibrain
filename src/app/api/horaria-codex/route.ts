import { FileLocalUserStore } from "@/auth/local-user-store";
import { operationalLogger } from "@/operations/server-logger";
import { loadInstallationConfig } from "@/config/installation";
import { callHoraria, loadHorariaConfig } from "@/horaria/client";
import { verifyCodexRequest } from "@/horaria/codex-auth";
import { runHorariaCodex } from "@/horaria/codex";
import type { AuthSession } from "@/auth/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const active = new Set<string>();
export async function POST(request: Request) {
  let userId: string | undefined;
  let stage = "verification";
  try {
    const installation = await loadInstallationConfig();
    const config = await loadHorariaConfig(installation);
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = request.body?.getReader();
    if (reader) while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > 16 * 1024 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
      chunks.push(chunk.value);
    }
    const bytes = Buffer.concat(chunks);
    const identity = verifyCodexRequest(config, request.headers.get("x-aibrain-authorization"), bytes);
    const input = JSON.parse(bytes.toString());
    if (input.authorizationOnly === true) {
      if (identity.source !== "whatsapp") return new Response(null, { status: 403 });
      const user = await new FileLocalUserStore(installation.paths.usersRoot).read(identity.userId);
      if (!user?.enabled) return new Response(null, { status: 403 });
      await callHoraria(config, { provider: "local", user: { id: identity.userId }, tenant: { id: config.installationId } } as AuthSession, { operation: "status" }, "");
      return Response.json({ authorized: true }, { headers: { "cache-control": "private, no-store" } });
    }
    if (active.has(identity.userId) || active.size >= 4) return new Response(null, { status: 429 });
    userId = identity.userId; active.add(userId);
    // Recheck the current manager mapping in the service, and the current enabled
    // AiBrain user at worker admission. A prompt cannot choose another account.
    stage = "manager-check";
    await callHoraria(config, { provider: "local", user: { id: userId }, tenant: { id: config.installationId } } as AuthSession, { operation: "status" }, "");
    stage = "calculation";
    return Response.json(await runHorariaCodex(userId, input), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    operationalLogger.error("horaria.calculation_failed", { stage, error: error instanceof Error ? error.message.slice(0, 250) : "Calculation failed" });
    return new Response(null, { status: 503 });
  }
  finally { if (userId) active.delete(userId); }
}
