import "server-only";

import { createHash } from "node:crypto";

import {
  createClient,
  isAuthRetryableFetchError,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  IdentityProviderError,
  safeProviderCode,
  type AuthIdentityProvider,
  type IdentityCredentials,
  type RecoveryVerificationProof,
  type VerifiedIdentity,
} from "@/auth/identity-provider";
import {
  readSupabasePublicConfig,
  type SupabasePublicConfig,
} from "@/lib/supabase/config";
import { validatedAvatarUrl } from "@/auth/avatar-url";

function isolatedClient(config: SupabasePublicConfig) {
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function normalizeIdentity(
  data: {
    user: { id?: string; email?: string; user_metadata?: Record<string, unknown> | null } | null;
    session: { access_token?: string; refresh_token?: string } | null;
  },
  errorCode: "invalid_credentials" | "invalid_recovery",
): VerifiedIdentity {
  const userId = data.user?.id;
  const email = data.user?.email?.trim().toLowerCase();
  const accessToken = data.session?.access_token;
  const refreshToken = data.session?.refresh_token;
  if (!userId || !email || !accessToken || !refreshToken) {
    throw new IdentityProviderError(errorCode, "Identity provider did not return a complete session.");
  }
  const metadata = data.user?.user_metadata;
  const avatarUrl = validatedAvatarUrl(metadata?.avatar_url ?? metadata?.picture ?? metadata?.avatar);
  return { userId, email, accessToken, refreshToken, avatarUrl };
}

function providerFailure(
  error: unknown,
  rejectedCode: "invalid_credentials" | "invalid_recovery" | "provider_rejected",
) {
  if (error instanceof IdentityProviderError) return error;
  if (
    isAuthRetryableFetchError(error) ||
    error instanceof TypeError ||
    (error && typeof error === "object" && "cause" in error)
  ) {
    return new IdentityProviderError(
      "provider_unavailable",
      "Identity provider is unavailable.",
      { cause: error },
    );
  }
  const details = error && typeof error === "object" ? error as { code?: unknown; status?: unknown } : {};
  return new IdentityProviderError(rejectedCode, "Identity provider rejected the request.", {
    cause: error, providerCode: safeProviderCode(details.code),
    providerStatus: typeof details.status === "number" ? details.status : undefined,
  });
}

async function setCredentials(client: SupabaseClient, credentials: IdentityCredentials) {
  const { error } = await client.auth.setSession({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });
  if (error) throw error;
}

/** Error bodies are untrusted. Retain a tiny allowlisted code only, never
 * provider prose, submitted values, user objects or credential-bearing URLs. */
async function responseDiagnosticCode(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "other";
  let text = "", bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192) { await reader.cancel(); return "other"; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const body: unknown = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== "object") return "other";
    const value = body as { code?: unknown; error_code?: unknown };
    return safeProviderCode(typeof value.error_code === "string" ? value.error_code : value.code);
  } catch { return "other"; }
  finally { reader.releaseLock(); }
}

async function updatePasswordWithAccessToken(
  config: SupabasePublicConfig,
  accessToken: string,
  newPassword: string,
) {
  let response: Response;
  try {
    response = await fetch(`${config.url}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: config.publishableKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: newPassword }),
      cache: "no-store",
    });
  } catch {
    throw new IdentityProviderError("provider_unavailable", "Password update could not be confirmed.", {
      providerCode: "transport_error", updateOutcome: "unknown",
    });
  }
  if (response.status >= 500 || response.status === 429) {
    throw new IdentityProviderError(
      "provider_unavailable",
      "Identity provider is unavailable.",
      { providerStatus: response.status, providerCode: await responseDiagnosticCode(response), updateOutcome: response.status === 429 ? "rejected" : "unknown" },
    );
  }
  if (!response.ok) {
    throw new IdentityProviderError(
      "provider_rejected",
      "Identity provider rejected the request.",
      { providerStatus: response.status, providerCode: await responseDiagnosticCode(response), updateOutcome: "rejected" },
    );
  }
  const body: unknown = await response.json().catch(() => null);
  // Match the pinned auth-js _userResponse transform: user data may be the
  // object itself or wrapped in { user }. A valid wrapped success must not
  // become a false rejection after the password has already changed.
  const user = body && typeof body === "object" && "user" in body ? body.user ?? body : body;
  if (!user || typeof user !== "object" || !("id" in user) || typeof user.id !== "string" || !user.id) {
    throw new IdentityProviderError(
      "provider_unavailable",
      "Identity provider returned an unconfirmed password-update response.",
      { providerStatus: response.status, providerCode: "invalid_response", updateOutcome: "unknown" },
    );
  }
}

export class SupabaseAuthIdentityProvider implements AuthIdentityProvider {
  private readonly config: SupabasePublicConfig;

  constructor(config: SupabasePublicConfig) {
    this.config = config;
  }

  async verifyPassword(email: string, password: string) {
    try {
      const client = isolatedClient(this.config);
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return normalizeIdentity(data, "invalid_credentials");
    } catch (error) {
      throw providerFailure(error, "invalid_credentials");
    }
  }

  async updatePassword(credentials: IdentityCredentials, newPassword: string) {
    // A password-change challenge is deliberately shorter than the provider's
    // access-token lifetime. Use that token directly instead of calling
    // setSession(), which refreshes and rotates the stored refresh token before
    // the update and can invalidate an otherwise fresh one-time challenge.
    await updatePasswordWithAccessToken(this.config, credentials.accessToken, newPassword);
  }

  async requestPasswordRecovery(email: string, redirectTo: string, codeVerifier: string) {
    try {
      if (!/^[A-Za-z0-9_-]{64}$/.test(codeVerifier)) throw new IdentityProviderError("provider_rejected", "Invalid recovery verifier.");
      // Same PKCE /recover contract as the pinned auth-js SDK, with verifier
      // storage owned by our installation-scoped encrypted server store.
      await this.authPost(`/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
        email,
        code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
        code_challenge_method: "s256",
      }, "provider_rejected");
    } catch (error) {
      throw providerFailure(error, "provider_rejected");
    }
  }

  async verifyPasswordRecovery(proof: RecoveryVerificationProof) {
    try {
      const client = isolatedClient(this.config);
      if (proof.tokenHash !== undefined) {
        const { data, error } = await client.auth.verifyOtp({
          token_hash: proof.tokenHash,
          type: "recovery",
        });
        if (error) throw error;
        return normalizeIdentity(data, "invalid_recovery");
      }
      if (!/^[A-Za-z0-9_-]{64}$/.test(proof.codeVerifier ?? "")) throw new IdentityProviderError("invalid_recovery", "Invalid recovery verifier.");
      const data = await this.authPost("/token?grant_type=pkce", {
        auth_code: proof.code,
        code_verifier: proof.codeVerifier,
      }, "invalid_recovery");
      return normalizeIdentity({ user: data.user ?? null, session: data }, "invalid_recovery");
    } catch (error) {
      throw providerFailure(error, "invalid_recovery");
    }
  }

  private async authPost(path: string, body: object, rejected: "invalid_recovery" | "provider_rejected") {
    let response: Response;
    try {
      response = await fetch(`${this.config.url}/auth/v1${path}`, {
        method: "POST", cache: "no-store",
        headers: { apikey: this.config.publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) { throw providerFailure(error, rejected); }
    if (!response.ok) {
      const diagnostics = { providerStatus: response.status, providerCode: await responseDiagnosticCode(response) };
      if (response.status >= 500 || response.status === 429) throw new IdentityProviderError("provider_unavailable", "Identity provider is unavailable.", diagnostics);
      throw new IdentityProviderError(rejected, "Identity provider rejected the request.", diagnostics);
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") throw new IdentityProviderError(rejected, "Identity provider returned an invalid response.");
    return data as { user?: { id?: string; email?: string; user_metadata?: Record<string, unknown> | null }; access_token?: string; refresh_token?: string };
  }

  async signOut(credentials: IdentityCredentials) {
    try {
      const client = isolatedClient(this.config);
      await setCredentials(client, credentials);
      await client.auth.signOut({ scope: "local" });
    } catch {
      // Tokens never leave the server. Failing to revoke a provider refresh
      // token must not make the already-created local workbench session depend
      // on provider availability.
    }
  }
}

export function createSupabaseAuthIdentityProvider() {
  const config = readSupabasePublicConfig();
  if (!config) throw new IdentityProviderError(
    "provider_unavailable",
    "Supabase Auth configuration is incomplete.",
  );
  return new SupabaseAuthIdentityProvider(config);
}
