import { randomUUID } from "node:crypto";
import { operationalLogger } from "@/operations/server-logger";
import { recoveryFailureResponse } from "@/auth/recovery-outcome";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readRecoveryProof } from "@/auth/recovery-proof";
import { LocalAuthError } from "@/auth/auth-service";
import { createLocalAuthService } from "@/auth/auth-context";
import { isSameOriginMutation } from "@/auth/request-security";
import { setLocalSessionCookie, PASSWORD_RECOVERY_COOKIE, clearPasswordRecoveryCookie } from "@/auth/session-cookie";
import { authRateLimitSubject } from "@/auth/rate-limit";
import { checkAuthRateLimit } from "@/auth/rate-limit-context";

function logRecovery(level: "info" | "warn" | "error", event: string, attributes: Record<string, unknown>) {
  // A diagnostic sink failure must not change an already-committed auth result.
  try { operationalLogger[level](event, attributes); } catch { /* no credentials or exception fallback */ }
}

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }
  const body: unknown = await request.json().catch(() => null);
  const password = body && typeof body === "object" && "password" in body && typeof body.password === "string"
    ? body.password : "";
  const confirmation = body && typeof body === "object" && "confirmation" in body && typeof body.confirmation === "string"
    ? body.confirmation : "";
  const code = body && typeof body === "object" && "code" in body && typeof body.code === "string"
    ? body.code : undefined;
  const tokenHash = body && typeof body === "object" && "tokenHash" in body && typeof body.tokenHash === "string"
    ? body.tokenHash : undefined;
  let rateLimit;
  try {
    rateLimit = await checkAuthRateLimit(
      request,
      "password-recovery-complete",
      code
        ? authRateLimitSubject("code", code)
        : authRateLimitSubject("token", tokenHash),
    );
  } catch {
    return NextResponse.json(
      { error: "No s’ha pogut verificar temporalment la recuperació.", code: "recovery_unavailable", nextStep: "retry" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Massa intents. Torna-ho a provar més tard." },
      {
        status: 429,
        headers: {
          "Cache-Control": "private, no-store",
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      },
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Petició no vàlida.", code: "recovery_invalid_input", nextStep: "retry" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  const proof = readRecoveryProof({
    code: "code" in body ? body.code : undefined,
    tokenHash: "tokenHash" in body ? body.tokenHash : undefined,
  });
  if (password !== confirmation || !proof) {
    return NextResponse.json({ error: "Petició de recuperació no vàlida.", code: "recovery_invalid_input", nextStep: "retry" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  const requestId = randomUUID();
  const headers = { "Cache-Control": "private, no-store", "X-Recovery-Request-Id": requestId };
  let phase: "prepare" | "completion" | "session_cookie" = "prepare";
  let completed = false;
  const clearBinding = async () => {
    try { await clearPasswordRecoveryCookie(); }
    catch { logRecovery("warn", "auth.recovery_cookie_cleanup_failed", { requestId }); }
  };
  try {
    const service = await createLocalAuthService();
    const recoveryId = (await cookies()).get(PASSWORD_RECOVERY_COOKIE)?.value;
    phase = "completion";
    const result = await service.completePasswordRecovery(proof, password, recoveryId);
    completed = true;
    phase = "session_cookie";
    await setLocalSessionCookie(result.session);
    await clearBinding();
    logRecovery("info", "auth.recovery_completed", { requestId, phase: "complete", changeState: "changed" });
    return NextResponse.json({ authenticated: true }, { headers });
  } catch (error) {
    if (error instanceof LocalAuthError && error.code === "invalid_input") {
      return NextResponse.json({ error: "Revisa los requisitos de la contraseña.", code: "recovery_invalid_input", nextStep: "retry" }, { status: 400, headers });
    }
    const failure = recoveryFailureResponse(error, phase, completed);
    if (failure.nextStep !== "retry") await clearBinding();
    const attributes = { requestId, ...failure.diagnostics, httpStatus: failure.status, nextStep: failure.nextStep };
    if (failure.status >= 500) logRecovery("error", "auth.recovery_failed", attributes);
    else logRecovery("warn", "auth.recovery_failed", attributes);
    return NextResponse.json({ error: "No se ha podido completar la recuperación.", code: failure.code, nextStep: failure.nextStep }, { status: failure.status, headers });
  }
}
