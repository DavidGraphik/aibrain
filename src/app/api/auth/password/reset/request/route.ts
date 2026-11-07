import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createLocalAuthService } from "@/auth/auth-context";
import { setPasswordRecoveryCookie } from "@/auth/session-cookie";
import { getPublicOrigin } from "@/auth/public-url";
import { isSameOriginMutation } from "@/auth/request-security";
import { authRateLimitSubject } from "@/auth/rate-limit";
import { checkAuthRateLimit } from "@/auth/rate-limit-context";

export const runtime = "nodejs";

async function accepted(recovery?: { recoveryId: string; expiresAt: number }) {
  // Always emit the same cookie shape, including rejected/malformed/limited
  // requests. A dummy opaque handle has no server record or authentication rights
  // and must not turn the cookie header into an account/limiter side channel.
  await setPasswordRecoveryCookie(recovery?.recoveryId ?? randomBytes(32).toString("base64url"));
  return NextResponse.json(
    { accepted: true },
    { status: 202, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const body: unknown = await request.json().catch(() => null);
  const email = body && typeof body === "object" && "email" in body &&
    typeof body.email === "string" ? body.email : "";
  try {
    const rateLimit = await checkAuthRateLimit(
      request,
      "password-reset-request",
      authRateLimitSubject("email", email),
    );
    if (!rateLimit.allowed) return accepted();
  } catch {
    // Fail closed without exposing whether the subject, limiter or provider exists.
    return accepted();
  }
  let recovery: { recoveryId: string; expiresAt: number } | undefined;
  try {
    recovery = await (await createLocalAuthService()).requestPasswordRecovery(
      email,
      `${await getPublicOrigin()}/auth/recovery`,
    );
  } catch {
    // Deliberately indistinguishable for unknown, disabled, malformed and unavailable accounts.
  }
  return accepted(recovery);
}
