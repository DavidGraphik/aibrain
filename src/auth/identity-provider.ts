export type IdentityCredentials = {
  accessToken: string;
  refreshToken: string;
};

export type VerifiedIdentity = IdentityCredentials & {
  userId: string;
  email: string;
  avatarUrl?: string | null;
};

export type RecoveryProof =
  | { code: string; tokenHash?: never }
  | { tokenHash: string; code?: never };

export type RecoveryVerificationProof =
  | { code: string; codeVerifier: string; tokenHash?: never }
  | { tokenHash: string; code?: never; codeVerifier?: never };

export interface AuthIdentityProvider {
  verifyPassword(email: string, password: string): Promise<VerifiedIdentity>;
  updatePassword(credentials: IdentityCredentials, newPassword: string): Promise<void>;
  requestPasswordRecovery(email: string, redirectTo: string, codeVerifier: string): Promise<void>;
  verifyPasswordRecovery(proof: RecoveryVerificationProof): Promise<VerifiedIdentity>;
  signOut(credentials: IdentityCredentials): Promise<void>;
}

const PROVIDER_DIAGNOSTIC_CODES = new Set([
  "same_password", "weak_password", "reauthentication_needed", "reauthentication_not_valid",
  "reauth_nonce_missing", "bad_jwt", "session_not_found", "session_expired", "user_banned",
  "bad_code_verifier", "flow_state_expired", "flow_state_not_found", "otp_expired",
  "over_request_rate_limit", "validation_failed", "transport_error", "invalid_response", "other",
]);
export function safeProviderCode(value: unknown) {
  return typeof value === "string" && PROVIDER_DIAGNOSTIC_CODES.has(value) ? value : "other";
}

export class IdentityProviderError extends Error {
  readonly code: "invalid_credentials" | "invalid_recovery" | "provider_unavailable" | "provider_rejected";

  readonly providerCode?: string;
  readonly providerStatus?: number;
  readonly updateOutcome?: "rejected" | "unknown";

  constructor(
    code: IdentityProviderError["code"],
    message: string,
    options: { cause?: unknown; providerCode?: string; providerStatus?: number; updateOutcome?: "rejected" | "unknown" } = {},
  ) {
    super(message, options);
    this.name = "IdentityProviderError";
    this.code = code;
    if (options.providerCode !== undefined) this.providerCode = safeProviderCode(options.providerCode);
    if (Number.isInteger(options.providerStatus) && options.providerStatus! >= 100 && options.providerStatus! <= 599) this.providerStatus = options.providerStatus;
    this.updateOutcome = options.updateOutcome;
  }
}
