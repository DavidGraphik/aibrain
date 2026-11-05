import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { LocalAuthError } from "@/auth/auth-service";
import { createLocalAuthService } from "@/auth/auth-context";
import { IdentityProviderError } from "@/auth/identity-provider";
import { isSameOriginMutation } from "@/auth/request-security";
import {
  clearAuthChallengeCookie,
  LOCAL_AUTH_CHALLENGE_COOKIE,
  setLocalSessionCookie,
} from "@/auth/session-cookie";
import { authRateLimitSubject } from "@/auth/rate-limit";
import { checkAuthRateLimit } from "@/auth/rate-limit-context";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const body: unknown = await request.json().catch(() => null);
  const password = body && typeof body === "object" && "password" in body &&
    typeof body.password === "string" ? body.password : "";
  const confirmation = body && typeof body === "object" && "confirmation" in body &&
    typeof body.confirmation === "string" ? body.confirmation : "";
  const challengeId = (await cookies()).get(LOCAL_AUTH_CHALLENGE_COOKIE)?.value;
  let rateLimit;
  try {
    rateLimit = await checkAuthRateLimit(
      request,
      "initial-password-change",
      authRateLimitSubject("challenge", challengeId),
    );
  } catch {
    return NextResponse.json(
      { error: "No s’ha pogut verificar temporalment el canvi de contrasenya." },
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
  if (password !== confirmation) {
    return NextResponse.json({ error: "Les contrasenyes no coincideixen." }, { status: 400 });
  }
  if (!challengeId) {
    return NextResponse.json({ error: "El canvi de contrasenya ha caducat." }, { status: 401 });
  }
  try {
    const result = await (await createLocalAuthService()).changeInitialPassword(
      challengeId,
      password,
    );
    await setLocalSessionCookie(result.session);
    await clearAuthChallengeCookie();
    return NextResponse.json(
      { authenticated: true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof LocalAuthError && error.code === "invalid_input") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof IdentityProviderError && error.code === "provider_unavailable") {
      return NextResponse.json({ error: "El servei d’identitat no està disponible." }, { status: 503 });
    }
    if (error instanceof IdentityProviderError && error.code === "provider_rejected") {
      return NextResponse.json(
        { error: "El proveïdor ha rebutjat la contrasenya. Tria una contrasenya diferent i torna-ho a provar." },
        { status: 400, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    await clearAuthChallengeCookie();
    return NextResponse.json({ error: "El canvi de contrasenya ha caducat." }, { status: 401 });
  }
}
