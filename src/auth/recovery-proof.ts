import type { RecoveryProof } from "@/auth/identity-provider";

// Recovery credentials are opaque, bounded provider values. Never interpret
// an access/refresh token or a client-supplied identity as a recovery proof.
function credential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048
    && !/\s/.test(value);
}

export function readRecoveryProof(input: {
  code?: unknown;
  tokenHash?: unknown;
}): RecoveryProof | null {
  if (input.code !== undefined && input.tokenHash !== undefined) return null;
  if (credential(input.tokenHash)) return { tokenHash: input.tokenHash };
  if (credential(input.code)) return { code: input.code };
  return null;
}

export function recoveryProofFromQuery(params: Record<string, string | string[] | undefined>) {
  if (params.error !== undefined || params.error_code !== undefined) return null;
  if (params.type !== undefined && params.type !== "recovery") return null;
  return readRecoveryProof({ code: params.code, tokenHash: params.token_hash });
}
