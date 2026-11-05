import "server-only";

import type { AuthSession } from "@/auth/types";
import { catalogConnectionTransportForUser } from "@/catalog/native-connection-transport";
import { stopWorkerRuntimeForUser } from "@/runtime/worker-runtime-service";
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
  return startNativeConnectionOAuth(context);
}

export async function changeNativeConnection(session: AuthSession, resourceId: string, operation: "enable" | "disconnect") {
  const context = await nativeConnectionForSession(session, resourceId);
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
