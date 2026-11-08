import { CATALOG_UUID } from "@/catalog/contracts";

/** Native personal connections cannot inherit an operator's ChatGPT identity.
 * This is independent of the company's model billing and provider permissions. */
export function personalNativeConnectionsEnabled(userId: string, environment: Readonly<Record<string, string | undefined>> = process.env) {
  return CATALOG_UUID.test(userId)
    && (environment.AIBRAIN_CODEX_AUTH_SCOPE?.trim() || "per-user") === "per-user"
    && !environment.AIBRAIN_SHARED_CODEX_AUTH_SOURCE?.trim()
    && !environment.AIBRAIN_CODEX_OWNER_AUTH_SOCKET?.trim();
}
