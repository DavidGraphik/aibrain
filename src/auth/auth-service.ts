import { RecoveryCompletionError, type RecoveryPhase, type RecoveryChangeState } from "@/auth/recovery-outcome";
import type {
  AuthIdentityProvider,
  IdentityCredentials,
  RecoveryProof,
  VerifiedIdentity,
} from "@/auth/identity-provider";
import type { FilePasswordRecoveryStore } from "@/auth/password-recovery-store";
import { IdentityProviderError } from "@/auth/identity-provider";
import type { FileLocalAuthChallengeStore } from "@/auth/local-auth-challenge-store";
import type { CreatedLocalSession, FileLocalSessionStore } from "@/auth/local-session-store";
import type { FileLocalUserStore, LocalUser } from "@/auth/local-user-store";

export class LocalAuthError extends Error {
  readonly code:
    | "invalid_input"
    | "invalid_credentials"
    | "profile_unavailable"
    | "profile_disabled"
    | "challenge_invalid"
    | "recovery_invalid";

  constructor(code: LocalAuthError["code"], message: string) {
    super(message);
    this.name = "LocalAuthError";
    this.code = code;
  }
}

export type SuccessfulLocalAuthentication = {
  kind: "authenticated";
  user: LocalUser;
  session: CreatedLocalSession;
};

export type InitialPasswordChallenge = {
  kind: "password_change_required";
  challengeId: string;
  expiresAt: number;
};

function normalizedEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new LocalAuthError("invalid_input", "Email address is invalid.");
  }
  return email;
}

export function validatePassword(value: string) {
  if (
    value.length < 12 ||
    value.length > 128 ||
    !/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(value) ||
    !/[0-9]/.test(value)
  ) {
    throw new LocalAuthError(
      "invalid_input",
      "Password must have 12–128 characters and include a letter and a number.",
    );
  }
  return value;
}

export class LocalAuthService {
  constructor(
    readonly installationId: string,
    private readonly identityProvider: AuthIdentityProvider,
    private readonly users: FileLocalUserStore,
    private readonly sessions: FileLocalSessionStore,
    private readonly challenges: FileLocalAuthChallengeStore,
    private readonly recoveryRequests: FilePasswordRecoveryStore,
    private readonly publicOrigin: string,
  ) {}

  private async authorizedLocalUser(userId: string, identityEmail: string) {
    const user = await this.users.read(userId);
    if (!user || user.email !== identityEmail) {
      throw new LocalAuthError("profile_unavailable", "Local user profile is unavailable.");
    }
    if (!user.enabled) {
      await this.sessions.revokeUser(this.installationId, userId);
      throw new LocalAuthError("profile_disabled", "Local user profile is disabled.");
    }
    return user;
  }

  private async issueSession(user: LocalUser) {
    return this.sessions.create(this.installationId, user.userId);
  }

  async login(emailInput: string, password: string): Promise<
    SuccessfulLocalAuthentication | InitialPasswordChallenge
  > {
    const email = normalizedEmail(emailInput);
    if (password.length < 1 || password.length > 4096) {
      throw new LocalAuthError("invalid_input", "Password is invalid.");
    }
    let identity;
    try {
      identity = await this.identityProvider.verifyPassword(email, password);
    } catch (error) {
      throw error;
    }
    const credentials: IdentityCredentials = identity;
    try {
      const user = await this.authorizedLocalUser(identity.userId, identity.email);
      await this.users.saveAvatarUrl(user.userId, identity.avatarUrl ?? null);
      if (await this.users.hasInitialPasswordMarker(user.userId)) {
        const challenge = await this.challenges.create({
          installationId: this.installationId,
          userId: user.userId,
          accessToken: identity.accessToken,
          refreshToken: identity.refreshToken,
        });
        return {
          kind: "password_change_required",
          challengeId: challenge.challengeId,
          expiresAt: challenge.record.expiresAt,
        };
      }
      const session = await this.issueSession(user);
      await this.identityProvider.signOut(credentials);
      return { kind: "authenticated", user, session };
    } catch (error) {
      await this.identityProvider.signOut(credentials);
      throw error;
    }
  }

  async changeInitialPassword(challengeId: string, newPasswordInput: string) {
    const newPassword = validatePassword(newPasswordInput);
    const result = await this.challenges.consume(
      challengeId,
      this.installationId,
      async (challenge) => {
        const user = await this.users.read(challenge.userId);
        if (!user || !user.enabled) {
          throw new LocalAuthError("profile_unavailable", "Local user profile is unavailable.");
        }
        await this.identityProvider.updatePassword(challenge, newPassword);
        await this.users.clearInitialPasswordMarker(user.userId);
        return {
          kind: "authenticated" as const,
          user,
          session: await this.issueSession(user),
        };
      },
    );
    if (!result) {
      throw new LocalAuthError("challenge_invalid", "Password-change challenge is invalid.");
    }
    return result;
  }

  async requestPasswordRecovery(emailInput: string, redirectTo: string) {
    const email = normalizedEmail(emailInput);
    if (new URL(redirectTo).origin !== this.publicOrigin) throw new LocalAuthError("invalid_input", "Recovery origin mismatch.");
    const request = await this.recoveryRequests.create({ installationId: this.installationId, publicOrigin: this.publicOrigin, email });
    try {
      await this.identityProvider.requestPasswordRecovery(email, redirectTo, request.codeVerifier);
    } catch {
      // Unknown accounts, rejection and outage all receive the same opaque
      // browser cookie and 202 response. Cookie presence must not enumerate users.
    }
    return { recoveryId: request.recoveryId, expiresAt: request.expiresAt };
  }

  async completePasswordRecovery(
    proof: RecoveryProof,
    newPasswordInput: string,
    recoveryId?: string,
  ): Promise<SuccessfulLocalAuthentication> {
    const newPassword = validatePassword(newPasswordInput);
    let phase: RecoveryPhase = "browser_state";
    let changeState: RecoveryChangeState = "not_changed";
    const progress = (next: RecoveryPhase, state?: RecoveryChangeState) => { phase = next; if (state) changeState = state; };
    try {
      if (proof.code) {
        const result = await this.recoveryRequests.consume(recoveryId ?? "", {
          installationId: this.installationId, publicOrigin: this.publicOrigin,
        }, async ({ codeVerifier, email }) => {
          progress("proof_exchange");
          const identity = await this.identityProvider.verifyPasswordRecovery({ code: proof.code!, codeVerifier });
          progress("identity_binding");
          if (identity.email !== email) {
            await this.identityProvider.signOut(identity).catch(() => undefined);
            throw new IdentityProviderError("invalid_recovery", "Recovery identity mismatch.");
          }
          return this.completeVerifiedRecovery(identity, newPassword, progress);
        });
        if (!result) throw new IdentityProviderError("invalid_recovery", "Recovery browser state is invalid or expired.");
        return result;
      }
      progress("proof_exchange");
      // Compatibility with previously issued custom-template token-hash links.
      const identity = await this.identityProvider.verifyPasswordRecovery({ tokenHash: proof.tokenHash! });
      return await this.completeVerifiedRecovery(identity, newPassword, progress);
    } catch (error) {
      throw new RecoveryCompletionError(error, phase, changeState, error instanceof LocalAuthError ? error.code : undefined);
    }
  }

  private async completeVerifiedRecovery(identity: VerifiedIdentity, newPassword: string,
    progress: (phase: RecoveryPhase, state?: RecoveryChangeState) => void) {
    try {
      progress("local_profile");
      const user = await this.authorizedLocalUser(identity.userId, identity.email);
      progress("password_update", "unknown");
      await this.identityProvider.updatePassword(identity, newPassword);
      progress("session_revocation", "changed");
      await this.sessions.revokeUser(this.installationId, user.userId);
      progress("initial_marker");
      await this.users.clearInitialPasswordMarker(user.userId);
      progress("session_create");
      return { kind: "authenticated" as const, user, session: await this.issueSession(user) };
    } finally {
      // Cleanup cannot overwrite an authoritative update/local-store outcome.
      await this.identityProvider.signOut(identity).catch(() => undefined);
    }
  }
}
