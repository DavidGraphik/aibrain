import "server-only";

import type { AuthSession } from "@/auth/types";
import { catalogConnectionTransportForUser, nativeConnectionResourcesForSession } from "@/catalog/native-connection-transport";
import { stopWorkerRuntimeForUser } from "@/runtime/worker-runtime-service";
import { loadInstallationConfig } from "@/config/installation";
import { deriveWorkerRoots } from "@/runtime/workers/provisioner";
import { currentWorkerExecutionOrigin } from "@/runtime/workers/kernel-ownership";
import { NativeOAuthCallbackStore, forwardNativeOAuthCallback, sameNativeOAuthGeneration } from "@/connectors/native-oauth-callback";
import {
  NativeConnectionError,
  nativeConnectionSnapshot,
  setNativeConnectionEnabled,
  startNativeConnectionOAuth,
} from "@/connectors/native-connection-lifecycle";

/** The factory derives identity, current grants and personal-worker transport
 * from the authenticated session. Request bodies never supply server/app IDs. */
export async function nativeConnectionForSession(session: AuthSession, resourceId: string) {
  if (!/^[a-z][a-z0-9]*(?:[-.:][a-z0-9]+)*$/.test(resourceId) || resourceId.length > 128) {
    throw new NativeConnectionError("NATIVE_RESOURCE_INVALID", 400);
  }
  return catalogConnectionTransportForUser(session, resourceId);
}

export async function nativeConnectionStatus(session: AuthSession, resourceId: string) {
  return nativeConnectionSnapshot(await nativeConnectionForSession(session, resourceId));
}

export async function startNativeOAuthForSession(session: AuthSession, resourceId: string) {
  const context = await nativeConnectionForSession(session, resourceId);
  if ((await nativeConnectionSnapshot(context)).status === "disabled") await setNativeConnectionEnabled(context, true);
  // Standalone contexts retain their explicitly provisioned native callback.
  // The production server factory always supplies the managed callback lane.
  if (!context.callback || !context.resource.mcp) return startNativeConnectionOAuth(context);
  const store = new NativeOAuthCallbackStore(context.installationId, context.callback.dataRoot, context.callback.publicUrl);
  const lease = await store.begin({ userId: context.userId, resourceId, server: context.resource.mcp.server,
    generation: await context.callback.generation() });
  let loginStarted = false;
  try {
    const configured = await context.callback.configure(lease.callbackUrl, lease.attempt.port);
    loginStarted = true;
    // Only the remote DCR path has been verified against the pinned SDK.
    // There is no automatic CIMD/static fallback or credential exchange here.
    const login = await startNativeConnectionOAuth({ ...context, oauthClientRegistration: "dcr" });
    await store.bind(lease.attempt.id, login.authorizationUrl, login.loginId, configured.staticClientConfigured);
    return login;
  } catch (cause) {
    await store.finish(lease.attempt.id, loginStarted ? "uncertain" : "failed");
    throw cause;
  }
}

export async function finishNativeOAuthForSession(session: AuthSession, requestUrl: string) {
  const installation = await loadInstallationConfig();
  if (session.tenant.id !== installation.installationId) throw new NativeConnectionError("NATIVE_OAUTH_SCOPE_DENIED", 403);
  // Next standalone may construct request.url with its internal bind host.
  // Take only the incoming path/query; the protected installation owns origin.
  // Never derive the public callback origin from Host or forwarded headers.
  const incoming = new URL(requestUrl), publicCallback = new URL(installation.publicUrl);
  publicCallback.pathname = incoming.pathname; publicCallback.search = incoming.search; publicCallback.hash = "";
  const callbackUrl = publicCallback.toString();
  const store = new NativeOAuthCallbackStore(installation.installationId, installation.paths.dataRoot, installation.publicUrl);
  const attempt = await store.consume(session.user.id, callbackUrl, async row => {
    const resources = await nativeConnectionResourcesForSession(session);
    if (!resources.some(resource => resource.id === row.resourceId && resource.mcp?.server === row.server)) throw new NativeConnectionError("NATIVE_OAUTH_SCOPE_DENIED", 403);
    // Reading this proof does not create a replacement worker for a stale or
    // revoked callback. A new generation cannot receive an old login code.
    return currentWorkerExecutionOrigin(deriveWorkerRoots(installation, session.user.id).transportAudit);
  });
  try {
    const status = await forwardNativeOAuthCallback(attempt, callbackUrl);
    if (status < 200 || status >= 300) { await store.finish(attempt.id, "failed"); return "failed" as const; }
    const context = await nativeConnectionForSession(session, attempt.resourceId);
    const origin = await context.callback?.generation();
    if (!origin || !sameNativeOAuthGeneration(origin, attempt.generation)) throw new NativeConnectionError("NATIVE_OAUTH_RUNTIME_CHANGED");
    const connection = await nativeConnectionSnapshot(context);
    if (connection.login?.state === "failed") { await store.finish(attempt.id, "failed"); return "failed" as const; }
    const verified = connection.status === "connected" && connection.login?.state === "completed";
    await store.finish(attempt.id, verified ? "completed" : "uncertain");
    return verified ? "verified" as const : "pending" as const;
  } catch (cause) { await store.finish(attempt.id, "uncertain"); throw cause; }
}

export async function changeNativeConnection(session: AuthSession, resourceId: string, operation: "enable" | "disconnect") {
  const context = await nativeConnectionForSession(session, resourceId);
  if (operation === "disconnect" && context.callback) {
    await new NativeOAuthCallbackStore(context.installationId, context.callback.dataRoot, context.callback.publicUrl).revoke(context.userId, resourceId);
  }
  let result;
  try { result = await setNativeConnectionEnabled(context, operation === "enable"); }
  catch (error) {
    if (operation !== "disconnect" || !(error instanceof NativeConnectionError) || error.code !== "NATIVE_CONNECTION_DISABLE_PENDING") throw error;
  }
  if (operation === "enable") return result!;
  // Loaded thread overrides can otherwise outlive a global config reload.
  // Retire only this employee's runtime; durable turns/effects remain fenced.
  await stopWorkerRuntimeForUser(session.user.id);
  const connection = await nativeConnectionSnapshot(await nativeConnectionForSession(session, resourceId));
  if (connection.status !== "disabled") throw new NativeConnectionError("NATIVE_CONNECTION_DISABLE_PENDING");
  return { connection, enabled: false, providerCredentialsRevoked: false as const, effect: "local-connection-disabled" as const };
}

export function nativeConnectionFailure(error: unknown) {
  if (error instanceof NativeConnectionError) return { code: error.code, status: error.status };
  // Catalogue/identity denial codes are controlled application errors, never
  // raw provider messages or credential-bearing OAuth errors.
  const candidate = error as { code?: unknown; status?: unknown } | null;
  const code = typeof candidate?.code === "string" && /^(CATALOG_|NATIVE_|RUNTIME_IDENTITY_)[A-Z0-9_]+$/.test(candidate.code)
    ? candidate.code : "NATIVE_CONNECTION_UNAVAILABLE";
  const status = typeof candidate?.status === "number" && [400, 401, 403, 404, 409, 503].includes(candidate.status) ? candidate.status : 503;
  return { code, status };
}
