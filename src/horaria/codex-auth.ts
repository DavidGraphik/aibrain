import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { HorariaConfig } from "./client";
const seen = new Map<string, number>();
export function verifyCodexRequest(config: HorariaConfig, token: string | null, body: Uint8Array, now = Date.now()) {
  if (!token || token.length > 4096) throw new Error("Unauthorized");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("Unauthorized");
  const expected = createHmac("sha256", config.secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("Unauthorized");
  const c = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (c.v !== 1 || c.kind !== "user" || c.installationId !== config.installationId || c.method !== "POST" || c.target !== "/api/horaria-codex" || c.contentType !== "application/json" ||
    !Number.isSafeInteger(c.timestamp) || Math.abs(now - c.timestamp) > 60_000 || !/^[a-f0-9-]{36}$/.test(c.nonce) ||
    c.bodyHash !== createHash("sha256").update(body).digest("hex") || typeof c.actorId !== "string" || !Object.hasOwn(config.users, c.actorId) || config.users[c.actorId].employeeId !== c.employeeId) throw new Error("Unauthorized");
  if (c.source !== undefined && (c.source !== "whatsapp" || !config.eventsEnabled || config.eventActorId !== c.actorId)) throw new Error("Unauthorized WhatsApp identity");
  for (const [nonce, expiry] of seen) if (expiry < now) seen.delete(nonce);
  if (seen.has(c.nonce) || seen.size >= 10_000) throw new Error("Unauthorized");
  seen.set(c.nonce, now + 120_000);
  return { userId: c.actorId as string, employeeId: c.employeeId as number, ...(c.source === "whatsapp" ? { source: "whatsapp" as const } : {}) };
}
