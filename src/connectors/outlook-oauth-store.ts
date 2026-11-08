import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import type { OutlookTokenSet } from "@/connectors/outlook-contracts";
import { atomicWriteFile, ResourceLockManager } from "@/storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const CREDENTIAL_REF = /^outlook:[0-9a-f-]{36}$/u;

type OAuthStateRecord = {
  schemaVersion: 1;
  stateHash: string;
  installationId: string;
  userId: string;
  codeVerifier: string | null;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

type EncryptedTokenRecord = {
  schemaVersion: 1;
  installationId: string;
  userId: string;
  credentialRef: string;
  iv: string;
  tag: string;
  ciphertext: string;
  version: number;
  updatedAt: string;
};

export class OutlookOAuthStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "OutlookOAuthStoreError"; }
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function parseJson(filePath: string, raw: string) { try { return JSON.parse(raw) as unknown; } catch { throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_STATE_CORRUPT", `Invalid Outlook OAuth state at ${filePath}.`); } }

function parseState(value: unknown): OAuthStateRecord {
  const keys = ["schemaVersion", "stateHash", "installationId", "userId", "codeVerifier", "redirectUri", "createdAt", "expiresAt", "consumedAt"] as const;
  if (!record(value) || !exactKeys(value, keys) || value.schemaVersion !== 1 || typeof value.stateHash !== "string" || !HASH.test(value.stateHash) ||
      typeof value.installationId !== "string" || typeof value.userId !== "string" || !UUID.test(value.userId) ||
      !(value.codeVerifier === null || typeof value.codeVerifier === "string" && /^[A-Za-z0-9._~-]{43,128}$/u.test(value.codeVerifier)) ||
      typeof value.redirectUri !== "string" || typeof value.createdAt !== "string" || typeof value.expiresAt !== "string" ||
      !(value.consumedAt === null || typeof value.consumedAt === "string")) {
    throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_STATE_CORRUPT", "Outlook OAuth state is invalid.");
  }
  return value as OAuthStateRecord;
}

function parseTokenRecord(value: unknown): EncryptedTokenRecord {
  const keys = ["schemaVersion", "installationId", "userId", "credentialRef", "iv", "tag", "ciphertext", "version", "updatedAt"] as const;
  if (!record(value) || !exactKeys(value, keys) || value.schemaVersion !== 1 || typeof value.installationId !== "string" ||
      typeof value.userId !== "string" || !UUID.test(value.userId) || typeof value.credentialRef !== "string" || !CREDENTIAL_REF.test(value.credentialRef) ||
      typeof value.iv !== "string" || !BASE64.test(value.iv) || typeof value.tag !== "string" || !BASE64.test(value.tag) ||
      typeof value.ciphertext !== "string" || !BASE64.test(value.ciphertext) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
      typeof value.updatedAt !== "string") throw new OutlookOAuthStoreError("OUTLOOK_TOKEN_CORRUPT", "Encrypted Outlook token record is invalid.");
  return value as EncryptedTokenRecord;
}

function parseTokenSet(value: unknown): OutlookTokenSet {
  if (!record(value) || !exactKeys(value, ["accessToken", "refreshToken", "expiresAt", "scopes", "tokenType"]) ||
      typeof value.accessToken !== "string" || value.accessToken.length < 10 || typeof value.refreshToken !== "string" || value.refreshToken.length < 10 ||
      typeof value.expiresAt !== "string" || !Array.isArray(value.scopes) || value.scopes.length === 0 ||
      !value.scopes.every((scope) => typeof scope === "string" && scope.length > 0) || value.tokenType !== "Bearer") {
    throw new OutlookOAuthStoreError("OUTLOOK_TOKEN_CORRUPT", "Decrypted Outlook token payload is invalid.");
  }
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt, scopes: [...new Set(value.scopes as string[])].sort(), tokenType: "Bearer" };
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_PATH_UNSAFE", "Outlook OAuth storage must be a real directory.");
  await chmod(directory, 0o700);
}

export function outlookOAuthEncryptionKey(encoded: string | undefined) {
  if (!encoded) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_ENCRYPTION_KEY_MISSING", "Outlook OAuth encryption key is not configured.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) {
    throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_ENCRYPTION_KEY_INVALID", "Outlook OAuth encryption key must be 32 random base64 bytes.");
  }
  return key;
}

export class FileOutlookOAuthStateStore {
  private readonly root: string;
  private readonly locks: ResourceLockManager;
  constructor(private readonly config: Readonly<InstallationConfig>, private readonly now: () => number = Date.now) {
    this.root = path.join(path.resolve(config.paths.dataRoot), "connectors", "outlook", "oauth-states");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(path.resolve(config.paths.dataRoot), "connectors", "outlook", "locks") });
  }
  private statePath(stateHash: string) { if (!HASH.test(stateHash)) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_STATE_INVALID", "OAuth state is invalid."); return path.join(this.root, `${stateHash}.json`); }
  async create(userId: string, redirectUri: string) {
    if (!UUID.test(userId)) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_USER_INVALID", "OAuth user is invalid.");
    await privateDirectory(this.root);
    const rawState = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const stateHash = createHash("sha256").update(rawState).digest("hex");
    const createdAt = new Date(this.now()).toISOString();
    const value: OAuthStateRecord = { schemaVersion: 1, stateHash, installationId: this.config.installationId, userId, codeVerifier, redirectUri, createdAt, expiresAt: new Date(this.now() + 10 * 60_000).toISOString(), consumedAt: null };
    await atomicWriteFile(this.statePath(stateHash), `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return { state: rawState, codeVerifier, expiresAt: value.expiresAt };
  }
  async consume(userId: string, rawState: string) {
    if (!UUID.test(userId) || !/^[A-Za-z0-9_-]{40,100}$/u.test(rawState)) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_STATE_INVALID", "OAuth state is invalid.");
    const stateHash = createHash("sha256").update(rawState).digest("hex");
    return this.locks.withLock(`outlook-oauth-state:${stateHash}`, async () => {
      const filePath = this.statePath(stateHash);
      const value = parseState(parseJson(filePath, await readFile(filePath, "utf8")));
      if (value.installationId !== this.config.installationId || value.userId !== userId) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_STATE_IDENTITY_MISMATCH", "OAuth state belongs to another authenticated user.");
      if (value.consumedAt || !value.codeVerifier) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_STATE_REPLAYED", "OAuth state has already been consumed.");
      if (Date.parse(value.expiresAt) <= this.now()) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_STATE_EXPIRED", "OAuth state has expired.");
      const codeVerifier = value.codeVerifier;
      value.codeVerifier = null;
      value.consumedAt = new Date(this.now()).toISOString();
      await atomicWriteFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      return { codeVerifier, redirectUri: value.redirectUri };
    });
  }
}

export class FileOutlookTokenStore {
  private readonly locks: ResourceLockManager;
  constructor(private readonly config: Readonly<InstallationConfig>, private readonly key: Buffer, private readonly now: () => number = Date.now) {
    if (key.length !== 32) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_ENCRYPTION_KEY_INVALID", "Outlook OAuth encryption key must be 32 bytes.");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(path.resolve(config.paths.dataRoot), "connectors", "outlook", "token-locks") });
  }
  private async tokenPath(userId: string) {
    if (!UUID.test(userId)) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_USER_INVALID", "OAuth user is invalid.");
    const usersRoot = path.resolve(this.config.paths.usersRoot);
    const userRoot = path.join(usersRoot, userId);
    const [rootMeta, userMeta] = await Promise.all([lstat(usersRoot), lstat(userRoot)]);
    if (!rootMeta.isDirectory() || rootMeta.isSymbolicLink() || !userMeta.isDirectory() || userMeta.isSymbolicLink() || (userMeta.mode & 0o077) !== 0 || !inside(await realpath(usersRoot), await realpath(userRoot))) {
      throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_PATH_UNSAFE", "Outlook token user root is unsafe.");
    }
    const root = path.join(userRoot, "connectors", "outlook");
    await privateDirectory(root);
    if (!inside(await realpath(userRoot), await realpath(root))) throw new OutlookOAuthStoreError("OUTLOOK_OAUTH_PATH_UNSAFE", "Outlook token storage escapes the user root.");
    return path.join(root, "oauth-token.json");
  }
  private encrypt(userId: string, credentialRef: string, token: OutlookTokenSet) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${this.config.installationId}\0${userId}\0${credentialRef}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }
  private decrypt(record: EncryptedTokenRecord) {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64"));
    decipher.setAAD(Buffer.from(`${record.installationId}\0${record.userId}\0${record.credentialRef}`));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    return parseTokenSet(JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8")) as unknown);
  }
  async put(userId: string, token: OutlookTokenSet, credentialRef?: string) {
    const filePath = await this.tokenPath(userId);
    return this.locks.withLock(`outlook-token:${this.config.installationId}:${userId}`, async () => {
      let current: EncryptedTokenRecord | null = null;
      try { current = parseTokenRecord(parseJson(filePath, await readFile(filePath, "utf8"))); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
      if (current && current.userId !== userId) throw new OutlookOAuthStoreError("OUTLOOK_TOKEN_IDENTITY_MISMATCH", "Outlook token belongs to another user.");
      const reference = credentialRef ?? current?.credentialRef ?? `outlook:${randomUUID()}`;
      const encrypted = this.encrypt(userId, reference, parseTokenSet(token));
      const value: EncryptedTokenRecord = { schemaVersion: 1, installationId: this.config.installationId, userId, credentialRef: reference, ...encrypted, version: (current?.version ?? 0) + 1, updatedAt: new Date(this.now()).toISOString() };
      await atomicWriteFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      return { credentialRef: reference, tokenVersion: value.version };
    });
  }
  async read(userId: string, credentialRef: string) {
    const filePath = await this.tokenPath(userId);
    const stored = parseTokenRecord(parseJson(filePath, await readFile(filePath, "utf8")));
    if (stored.installationId !== this.config.installationId || stored.userId !== userId || stored.credentialRef !== credentialRef) throw new OutlookOAuthStoreError("OUTLOOK_TOKEN_IDENTITY_MISMATCH", "Outlook token belongs to another identity.");
    try { return { token: this.decrypt(stored), tokenVersion: stored.version }; } catch { throw new OutlookOAuthStoreError("OUTLOOK_TOKEN_DECRYPT_FAILED", "Outlook token could not be decrypted."); }
  }
  async clear(userId: string, credentialRef: string) {
    const filePath = await this.tokenPath(userId);
    return this.locks.withLock(`outlook-token:${this.config.installationId}:${userId}`, async () => {
      const stored = parseTokenRecord(parseJson(filePath, await readFile(filePath, "utf8")));
      if (stored.installationId !== this.config.installationId || stored.userId !== userId || stored.credentialRef !== credentialRef) throw new OutlookOAuthStoreError("OUTLOOK_TOKEN_IDENTITY_MISMATCH", "Outlook token belongs to another identity.");
      await unlink(filePath);
    });
  }
}
