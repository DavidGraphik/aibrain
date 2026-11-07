import { cookies } from "next/headers";
import { PASSWORD_RECOVERY_MS } from "@/auth/password-recovery-store";
import type { CreatedLocalSession } from "@/auth/local-session-store";

import { LOCAL_SESSION_COOKIE } from "@/auth/session-cookie-name";
export { LOCAL_SESSION_COOKIE } from "@/auth/session-cookie-name";
export const LOCAL_AUTH_CHALLENGE_COOKIE = "__Host-aibrain-auth-challenge";

const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  priority: "high" as const,
};

export async function setLocalSessionCookie(session: CreatedLocalSession) {
  const now = Date.now();
  (await cookies()).set(LOCAL_SESSION_COOKIE, session.sessionId, {
    ...BASE_COOKIE_OPTIONS,
    expires: new Date(session.record.absoluteExpiresAt),
    maxAge: Math.max(0, Math.floor((session.record.absoluteExpiresAt - now) / 1000)),
  });
}

export async function clearLocalSessionCookie() {
  (await cookies()).set(LOCAL_SESSION_COOKIE, "", {
    ...BASE_COOKIE_OPTIONS,
    expires: new Date(0),
    maxAge: 0,
  });
}

export async function setAuthChallengeCookie(challengeId: string, expiresAt: number) {
  const now = Date.now();
  (await cookies()).set(LOCAL_AUTH_CHALLENGE_COOKIE, challengeId, {
    ...BASE_COOKIE_OPTIONS,
    expires: new Date(expiresAt),
    maxAge: Math.max(0, Math.floor((expiresAt - now) / 1000)),
  });
}

export async function clearAuthChallengeCookie() {
  (await cookies()).set(LOCAL_AUTH_CHALLENGE_COOKIE, "", {
    ...BASE_COOKIE_OPTIONS,
    expires: new Date(0),
    maxAge: 0,
  });
}


export const PASSWORD_RECOVERY_COOKIE = "__Host-aibrain-password-recovery";

export async function setPasswordRecoveryCookie(recoveryId: string) {
  (await cookies()).set(PASSWORD_RECOVERY_COOKIE, recoveryId, {
    // Constant public lifetime; the private record enforces its own deadline.
    // Provider latency/error must not change observable cookie attributes.
    ...BASE_COOKIE_OPTIONS, maxAge: PASSWORD_RECOVERY_MS / 1000,
  });
}

export async function clearPasswordRecoveryCookie() {
  (await cookies()).set(PASSWORD_RECOVERY_COOKIE, "", {
    ...BASE_COOKIE_OPTIONS, expires: new Date(0), maxAge: 0,
  });
}
