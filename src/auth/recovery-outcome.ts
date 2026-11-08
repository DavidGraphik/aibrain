import { IdentityProviderError } from "./identity-provider";

export type RecoveryPhase = "browser_state" | "proof_exchange" | "identity_binding" | "local_profile" | "password_update" | "session_revocation" | "initial_marker" | "session_create";
export type RecoveryChangeState = "not_changed" | "changed" | "unknown";
export type RecoveryNextStep = "retry" | "new_link" | "sign_in";
const LOCAL_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EROFS", "EIO", "ENOENT", "EMFILE", "EBUSY"]);

function safeLocalCode(error: unknown) {
  const value = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof value === "string" && LOCAL_CODES.has(value) ? value : undefined;
}

/** Safe diagnostic envelope, deliberately without the original exception,
 * message, stack cause, identity, proof or provider credential. */
export class RecoveryCompletionError extends Error {
  readonly code: string;
  readonly providerCode?: string;
  readonly providerStatus?: number;
  readonly localCode?: string;
  readonly changeState: RecoveryChangeState;
  constructor(error: unknown, readonly phase: RecoveryPhase, state: RecoveryChangeState, knownCode?: string) {
    super("Password recovery did not complete.");
    this.name = "RecoveryCompletionError";
    this.code = knownCode ?? (error instanceof IdentityProviderError ? error.code : "recovery_failed");
    this.changeState = phase === "password_update" && error instanceof IdentityProviderError && error.updateOutcome === "rejected" ? "not_changed" : state;
    if (error instanceof IdentityProviderError) {
      this.providerCode = error.providerCode; this.providerStatus = error.providerStatus;
    }
    this.localCode = safeLocalCode(error);
  }
}

export function recoveryFailureResponse(error: unknown, phase: "prepare" | "completion" | "session_cookie", completed: boolean) {
  const failure = error instanceof RecoveryCompletionError ? error : null;
  const code = failure?.code ?? (error instanceof IdentityProviderError ? error.code : "recovery_failed");
  const changeState = completed ? "changed" : failure?.changeState ?? (phase === "prepare" || error instanceof IdentityProviderError ? "not_changed" : "unknown");
  const diagnostics = {
    phase: failure?.phase ?? phase, reason: code, changeState,
    providerCode: failure?.providerCode ?? (error instanceof IdentityProviderError ? error.providerCode : undefined),
    providerStatus: failure?.providerStatus ?? (error instanceof IdentityProviderError ? error.providerStatus : undefined),
    localCode: failure?.localCode ?? safeLocalCode(error) ?? null,
  };
  const result = (status: number, code: string, nextStep: RecoveryNextStep) => ({ status, code, nextStep, diagnostics });
  if (phase === "prepare") return result(503, "recovery_unavailable", "retry");
  if (changeState === "changed") return result(503, "recovery_session_unavailable", "sign_in");
  if (changeState === "unknown") return result(503, "recovery_change_unconfirmed", "sign_in");
  if (code === "invalid_recovery") return result(410, "recovery_proof_unusable", "new_link");
  if (code === "profile_disabled" || code === "profile_unavailable") return result(403, "recovery_account_unavailable", "sign_in");
  if (code === "provider_rejected") {
    if (["reauthentication_needed", "reauthentication_not_valid", "reauth_nonce_missing"].includes(diagnostics.providerCode ?? "")) return result(403, "recovery_verification_required", "sign_in");
    if (["same_password", "weak_password"].includes(diagnostics.providerCode ?? "")) return result(422, "recovery_password_rejected", "new_link");
    return result(422, "recovery_provider_rejected", "new_link");
  }
  return result(503, "recovery_unavailable", "new_link");
}
