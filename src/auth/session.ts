import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { createLocalSessionContext } from "@/auth/auth-context";
import {
  clearAuthChallengeCookie,
  clearLocalSessionCookie,
  LOCAL_AUTH_CHALLENGE_COOKIE,
  LOCAL_SESSION_COOKIE,
} from "@/auth/session-cookie";
import { isSupportSessionAuthorized } from "@/auth/support-session-validity";
import type { AuthMode, AuthSession } from "@/auth/types";
import { getDemoAccount, getTenantDefinition } from "@/config/tenants";
import { readSupabasePublicConfig } from "@/lib/supabase/config";
import { profileAvatarOverride } from "@/auth/profile-avatar";
import { bindLocalServerSession } from "@/auth/server-session-binding";

const DEMO_SESSION_COOKIE = "aibrain_demo_session";
const DEMO_SESSION_SECONDS = 12 * 60 * 60;
const DEVELOPMENT_SECRET = "aibrain-local-demo-session-key-v1";

type DemoSessionPayload = {
  version: 1;
  userId: string;
  tenantId: string;
  issuedAt: number;
  expiresAt: number;
};

function encode(value: string) {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function isVercelPreviewDemoEnabled() {
  return process.env.VERCEL_ENV === "preview" &&
    process.env.AIBRAIN_AUTH_MODE === "demo" &&
    process.env.AIBRAIN_ENABLE_PREVIEW_DEMO === "1";
}

export function getAuthMode(): AuthMode {
  const configured = process.env.AIBRAIN_AUTH_MODE?.trim();
  if (configured === "supabase") {
    return readSupabasePublicConfig() ? "supabase" : "unavailable";
  }
  if (isVercelPreviewDemoEnabled()) return "demo";
  if ((configured === "demo" || !configured) && process.env.NODE_ENV !== "production") {
    return "demo";
  }
  return "unavailable";
}

export function isDemoAuthEnabled() {
  return getAuthMode() === "demo";
}

export function isSupabaseAuthEnabled() {
  return getAuthMode() === "supabase";
}

export function getSigningSecret() {
  const configured = process.env.AIBRAIN_SESSION_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") return DEVELOPMENT_SECRET;
  throw new Error("AIBRAIN_SESSION_SECRET is required for remote demo auth.");
}

function sign(value: string) {
  return createHmac("sha256", getSigningSecret()).update(value).digest("base64url");
}

function signaturesMatch(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer);
}

function parseDemoPayload(token: string): DemoSessionPayload | null {
  const [encodedPayload, receivedSignature, extra] = token.split(".");
  if (!encodedPayload || !receivedSignature || extra) return null;
  if (!signaturesMatch(receivedSignature, sign(encodedPayload))) return null;
  try {
    const payload: unknown = JSON.parse(decode(encodedPayload));
    if (!payload || typeof payload !== "object") return null;
    if (!("version" in payload) || payload.version !== 1) return null;
    if (!("userId" in payload) || typeof payload.userId !== "string") return null;
    if (!("tenantId" in payload) || typeof payload.tenantId !== "string") return null;
    if (!("issuedAt" in payload) || typeof payload.issuedAt !== "number") return null;
    if (!("expiresAt" in payload) || typeof payload.expiresAt !== "number") return null;
    if (payload.expiresAt <= Date.now()) return null;
    return payload as DemoSessionPayload;
  } catch {
    return null;
  }
}

function demoSession(payload: DemoSessionPayload): AuthSession | null {
  const account = getDemoAccount(payload.userId);
  const tenant = getTenantDefinition(payload.tenantId);
  if (!account || !tenant || account.tenantId !== tenant.id) return null;
  return {
    provider: "demo",
    user: {
      id: account.id,
      name: account.name,
      email: account.email,
      avatarUrl: null,
    },
    tenant: { id: tenant.id, name: tenant.name },
    expiresAt: new Date(payload.expiresAt).toISOString(),
  };
}

async function getLocalSession(sessionId: string): Promise<AuthSession | null> {
  const { installation, sessions, users } = await createLocalSessionContext();
  const resolved = await sessions.read(sessionId, installation.installationId);
  if (!resolved) return null;
  if (resolved.record.support && !await isSupportSessionAuthorized(resolved.record, installation, users)) return null;
  const user = await users.read(resolved.record.userId);
  if (!user || !user.enabled) {
    await sessions.revokeUser(installation.installationId, resolved.record.userId);
    return null;
  }
  return bindLocalServerSession({
    provider: "local",
    user: {
      id: user.userId,
      name: user.displayName,
      email: user.email,
      avatarUrl: profileAvatarOverride(installation.companySlug, user.email, installation.publicUrl)
        ?? await users.readAvatarUrl(user.userId),
    },
    tenant: {
      id: installation.installationId,
      name: installation.companyName,
    },
    expiresAt: new Date(resolved.record.idleExpiresAt).toISOString(),
    ...(resolved.record.support ? { support: { actorEmail: resolved.record.support.actorEmail, expiresAt: new Date(resolved.record.absoluteExpiresAt).toISOString(),
      ...(resolved.record.support.preview ? {preview:resolved.record.support.preview} : {}) } } : {}),
  }, resolved.record.sessionIdHash);
}

export async function getSession(): Promise<AuthSession | null> {
  const cookieStore = await cookies();
  const localSessionId = cookieStore.get(LOCAL_SESSION_COOKIE)?.value;
  if (localSessionId) return getLocalSession(localSessionId);
  if (!isDemoAuthEnabled()) return null;
  const token = cookieStore.get(DEMO_SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = parseDemoPayload(token);
  return payload ? demoSession(payload) : null;
}

export async function createDemoSession(userId: string) {
  if (!isDemoAuthEnabled()) return null;
  const account = getDemoAccount(userId);
  if (!account) return null;
  const now = Date.now();
  const payload: DemoSessionPayload = {
    version: 1,
    userId: account.id,
    tenantId: account.tenantId,
    issuedAt: now,
    expiresAt: now + DEMO_SESSION_SECONDS * 1000,
  };
  const encodedPayload = encode(JSON.stringify(payload));
  const token = `${encodedPayload}.${sign(encodedPayload)}`;
  (await cookies()).set(DEMO_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DEMO_SESSION_SECONDS,
    priority: "high",
  });
  return demoSession(payload);
}

export async function deleteSession() {
  const cookieStore = await cookies();
  const localSessionId = cookieStore.get(LOCAL_SESSION_COOKIE)?.value;
  if (localSessionId) {
    const { sessions } = await createLocalSessionContext();
    await sessions.delete(localSessionId);
  }
  await clearLocalSessionCookie();
  const challengeId = cookieStore.get(LOCAL_AUTH_CHALLENGE_COOKIE)?.value;
  if (challengeId) {
    const { challenges } = await createLocalSessionContext();
    await challenges.delete(challengeId);
    await clearAuthChallengeCookie();
  }
  cookieStore.set(DEMO_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  });
}
