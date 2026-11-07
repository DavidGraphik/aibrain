import "server-only";
import type { AuthSession } from "./types";

// Non-serializable server metadata: never added to session DTOs or model input.
const bindings = new WeakMap<AuthSession, string>();
export function bindLocalServerSession(session: AuthSession, sessionIdHash: string): AuthSession {
  if (session.provider !== "local" || !/^[a-f0-9]{64}$/.test(sessionIdHash)) throw new Error("Invalid server session binding.");
  bindings.set(session, sessionIdHash);
  return session;
}
export function localServerSessionHash(session: AuthSession): string | undefined {
  return bindings.get(session);
}
