import "server-only";

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { AuthIdentityProvider, IdentityCredentials, RecoveryVerificationProof, VerifiedIdentity } from "./identity-provider";
import { IdentityProviderError } from "./identity-provider";
import type { FileLocalUserStore } from "./local-user-store";
import { assertPersonalModelTest, configuredModelAuth } from "@/runtime/server-model-auth";

export const PRIVATE_OWNER_LOGIN_PATH = "/etc/aibrain/private-owner-login.json";
const SCRYPT = Object.freeze({ N: 65_536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
const unavailable = () => new IdentityProviderError("provider_unavailable", "Private owner authentication is unavailable.");
const invalid = () => new IdentityProviderError("invalid_credentials", "Email or password is incorrect.");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const installationId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
const userId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const emailAddress = (value: unknown): value is string => typeof value === "string" && value.length <= 320
  && value === value.trim().toLowerCase() && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);

export function isPrivateOwnerAuthRequested() {
  return process.env.AIBRAIN_AUTH_MODE?.trim() === "private-owner";
}

/** UI mode selection only. Protected identity and profile are re-read on login
 * and session access; selecting this mode never authorizes a browser request. */
export function isPrivateOwnerAuthConfigured() {
  try {
    return isPrivateOwnerAuthRequested() && process.env.AIBRAIN_MODEL_AUTH?.trim() === "personal-test"
      && process.env.AIBRAIN_CODEX_AUTH_SCOPE?.trim() === "per-user" && configuredModelAuth() === "personal-test";
  } catch { return false; }
}

type OwnerCredential = {
  installationId: string; userId: string; email: string; salt: Buffer; passwordHash: Buffer; fingerprint: string;
};
function wipe(value?: OwnerCredential) { value?.salt.fill(0); value?.passwordHash.fill(0); }

/** Fixed, backend-readable root file only. No caller may supply a path or
 * hashing parameters. Replacing or changing it during a read fails closed. */
async function credential(expectedInstallation: string): Promise<OwnerCredential> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer | undefined;
  let salt: Buffer | undefined, passwordHash: Buffer | undefined;
  try {
    if (!isPrivateOwnerAuthConfigured() || !installationId(expectedInstallation)
      || await realpath(PRIVATE_OWNER_LOGIN_PATH) !== PRIVATE_OWNER_LOGIN_PATH) throw unavailable();
    const initial = await lstat(PRIVATE_OWNER_LOGIN_PATH);
    if (!initial.isFile() || initial.isSymbolicLink()) throw unavailable();
    handle = await open(PRIVATE_OWNER_LOGIN_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.gid !== BigInt(process.getegid?.() ?? -1) || before.nlink !== 1n
      || (before.mode & 0o7777n) !== 0o640n || before.size < 2n || before.size > 4096n) throw unavailable();
    bytes = Buffer.alloc(4097); let length = 0;
    while (length < bytes.length) {
      const next = await handle.read(bytes, length, bytes.length - length, length);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(PRIVATE_OWNER_LOGIN_PATH, { bigint: true });
    const fields = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
    const same = (value: typeof before) => fields.every(key => value[key] === before[key]);
    if (length !== Number(before.size) || !same(after) || !same(current)
      || await realpath(PRIVATE_OWNER_LOGIN_PATH) !== PRIVATE_OWNER_LOGIN_PATH) throw unavailable();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    const value: unknown = JSON.parse(text);
    if (!record(value) || Object.keys(value).sort().join(",") !== "canonicalUserId,email,installationId,passwordHash,salt,schemaVersion"
      || value.schemaVersion !== 1 || value.installationId !== expectedInstallation || !userId(value.canonicalUserId)
      || !emailAddress(value.email) || typeof value.salt !== "string" || typeof value.passwordHash !== "string") throw unavailable();
    salt = Buffer.from(value.salt, "base64"); passwordHash = Buffer.from(value.passwordHash, "base64");
    if (salt.length !== 32 || salt.toString("base64") !== value.salt || passwordHash.length !== 64
      || passwordHash.toString("base64") !== value.passwordHash) throw unavailable();
    const fingerprint = createHash("sha256").update(bytes.subarray(0, length))
      .update(JSON.stringify(fields.map(key => String(before[key])))).digest("hex");
    const result = { installationId: expectedInstallation, userId: value.canonicalUserId, email: value.email, salt, passwordHash, fingerprint };
    salt = passwordHash = undefined;
    return result;
  } catch { throw unavailable(); }
  finally { bytes?.fill(0); salt?.fill(0); passwordHash?.fill(0); await handle?.close().catch(() => undefined); }
}

/** Ordinary stored sessions retain their existing TTL/store, but cannot cross
 * the protected private owner's identity or survive removal of its profile. */
export async function assertPrivateOwnerSession(identity: { installationId: string; userId: string; email: string }) {
  let value: OwnerCredential | undefined;
  try {
    value = await credential(identity.installationId);
    if (value.userId !== identity.userId || value.email !== identity.email) throw unavailable();
    await assertPersonalModelTest(identity);
  } catch { throw unavailable(); }
  finally { wipe(value); }
}

export class PrivateOwnerIdentityProvider implements AuthIdentityProvider {
  readonly initialPasswordChangeSupported = false;
  constructor(private readonly installation: string, private readonly users: Pick<FileLocalUserStore, "hasInitialPasswordMarker">) {}

  async verifyPassword(email: string, password: string): Promise<VerifiedIdentity> {
    if (typeof email !== "string" || typeof password !== "string" || email.length > 320 || !password.length
      || Buffer.byteLength(password, "utf8") > 4096) throw invalid();
    let value: OwnerCredential | undefined, fresh: OwnerCredential | undefined, derived: Buffer | undefined;
    try {
      value = await credential(this.installation);
      await assertPersonalModelTest(value);
      // This provider has no IdP tokens or password-update flow. Never let the
      // generic initial-password challenge persist its ephemeral placeholders.
      if (await this.users.hasInitialPasswordMarker(value.userId)) throw unavailable();
      const current = value;
      derived = await new Promise<Buffer>((resolve, reject) => scrypt(password, current.salt, 64, SCRYPT,
        (error, result) => error ? reject(error) : resolve(result)));
      const matched = timingSafeEqual(derived, value.passwordHash) && email.trim().toLowerCase() === value.email;
      fresh = await credential(this.installation);
      if (fresh.fingerprint !== value.fingerprint) throw unavailable();
      await assertPersonalModelTest(fresh);
      if (await this.users.hasInitialPasswordMarker(value.userId)) throw unavailable();
      if (!matched) throw invalid();
      // Interface-only random values, discarded by LocalAuthService.signOut.
      // They are neither provider tokens nor a separate session mechanism.
      return { userId: value.userId, email: value.email,
        accessToken: randomBytes(32).toString("base64url"), refreshToken: randomBytes(32).toString("base64url") };
    } catch (error) {
      if (error instanceof IdentityProviderError && error.code === "invalid_credentials") throw invalid();
      throw unavailable();
    } finally { wipe(value); wipe(fresh); derived?.fill(0); }
  }

  async signOut(_credentials: IdentityCredentials): Promise<void> { /* No external token exists. */ }
  async updatePassword(_credentials: IdentityCredentials, _password: string): Promise<void> { throw unavailable(); }
  async requestPasswordRecovery(_email: string, _redirectTo: string, _codeVerifier: string): Promise<void> { throw unavailable(); }
  async verifyPasswordRecovery(_proof: RecoveryVerificationProof): Promise<VerifiedIdentity> { throw unavailable(); }
}
