import { NextResponse } from "next/server";
import { IdentityProviderError } from "@/auth/identity-provider";
import { LocalAuthError } from "@/auth/auth-service";
import { createLocalAuthService } from "@/auth/auth-context";
import { isSameOriginMutation } from "@/auth/request-security";
import { createDemoSession, getAuthMode } from "@/auth/session";
import {
  clearAuthChallengeCookie,
  setAuthChallengeCookie,
  setLocalSessionCookie,
} from "@/auth/session-cookie";
import { authRateLimitSubject } from "@/auth/rate-limit";
import { checkAuthRateLimit } from "@/auth/rate-limit-context";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const mode = getAuthMode();
  if (mode === "unavailable") {
    return NextResponse.json(
      { error: "El proveïdor d’identitat no està configurat." },
      { status: 503 },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  if (mode === "demo") {
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Petició no vàlida." }, { status: 400 });
    }
    if (!("userId" in body) || typeof body.userId !== "string") {
      return NextResponse.json({ error: "Usuari demo no vàlid." }, { status: 400 });
    }
    const session = await createDemoSession(body.userId);
    if (!session) {
      return NextResponse.json({ error: "Usuari demo no autoritzat." }, { status: 403 });
    }
    return NextResponse.json({ session });
  }

  const email = body && typeof body === "object" && "email" in body && typeof body.email === "string"
    ? body.email.trim().toLowerCase()
    : "";
  const password = body && typeof body === "object" && "password" in body && typeof body.password === "string"
    ? body.password
    : "";
  let rateLimit;
  try {
    rateLimit = await checkAuthRateLimit(request, "login", authRateLimitSubject("email", email));
  } catch {
    return NextResponse.json(
      { error: "No s’ha pogut verificar temporalment l’accés." },
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
    return NextResponse.json({ error: "Petició no vàlida." }, { status: 400 });
  }
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 320) {
    return NextResponse.json({ error: "Introdueix un correu vàlid." }, { status: 400 });
  }
  if (!password || password.length > 4096) {
    return NextResponse.json({ error: "Introdueix la contrasenya." }, { status: 400 });
  }

  try {
    const result = await (await createLocalAuthService()).login(email, password);
    if (result.kind === "password_change_required") {
      await setAuthChallengeCookie(result.challengeId, result.expiresAt);
      return NextResponse.json(
        { passwordChangeRequired: true, expiresAt: new Date(result.expiresAt).toISOString() },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
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
    if (
      error instanceof IdentityProviderError && error.code === "provider_unavailable"
    ) {
      return NextResponse.json(
        { error: "El servei d’identitat no està disponible temporalment." },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Correu o contrasenya incorrectes." },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
