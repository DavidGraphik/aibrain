import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteJson } from "@/storage/atomic-file";
import { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectInteger,
  expectLiteral,
  expectString,
  parseJson,
} from "@/storage/schema";

export const INITIAL_PASSWORD_CHALLENGE_MS = 15 * 60 * 1000;

export type LocalAuthChallengeRecord = {
  schemaVersion: 1;
  challengeIdHash: string;
  kind: "initial-password-change";
  installationId: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  encryptedCredentials: string;
  nonce: string;
  authTag: string;
};

export type LocalAuthChallenge = Omit<
  LocalAuthChallengeRecord,
  "encryptedCredentials" | "nonce" | "authTag"
> & {
  accessToken: string;
  refreshToken: string;
};

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const INSTALLATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHALLENGE_FILE_MAX_BYTES = 96 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const localAuthChallengeSchema = defineVersionedSchema<LocalAuthChallengeRecord>({
  name: "LocalAuthChallenge",
  schemaVersion: 1,
  keys: [
    "challengeIdHash",
    "kind",
    "installationId",
    "userId",
    "issuedAt",
    "expiresAt",
    "encryptedCredentials",
    "nonce",
    "authTag",
  ],
  parse(record, context) {
    const issuedAt = expectInteger(record.issuedAt, context.at("issuedAt"), { minimum: 0 });
    return {
      schemaVersion: 1,
      challengeIdHash: expectString(record.challengeIdHash, context.at("challengeIdHash"), {
        minLength: 64,
        maxLength: 64,
        pattern: HASH_PATTERN,
      }),
      kind: expectLiteral(record.kind, "initial-password-change", context.at("kind")),
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      userId: expectString(record.userId, context.at("userId"), {
        minLength: 36,
        maxLength: 36,
        pattern: USER_ID_PATTERN,
      }),
      issuedAt,
      expiresAt: expectInteger(record.expiresAt, context.at("expiresAt"), {
        minimum: issuedAt + 1,
      }),
      encryptedCredentials: expectString(
        record.encryptedCredentials,
        context.at("encryptedCredentials"),
        { minLength: 16, maxLength: 65_536, pattern: BASE64URL_PATTERN },
      ),
      nonce: expectString(record.nonce, context.at("nonce"), {
        minLength: 16,
        maxLength: 16,
        pattern: BASE64URL_PATTERN,
      }),
      authTag: expectString(record.authTag, context.at("authTag"), {
        minLength: 22,
        maxLength: 22,
        pattern: BASE64URL_PATTERN,
      }),
    };
  },
});

function challengeHash(challengeId: string) {
  if (!OPAQUE_ID_PATTERN.test(challengeId)) throw new Error("Auth challenge id is invalid.");
  return createHash("sha256").update(challengeId).digest("hex");
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export class FileLocalAuthChallengeStore {
  readonly rootDirectory: string;
  private readonly lockManager: ResourceLockManager;
  private readonly now: () => number;
  private readonly createChallengeId: () => string;
  private readonly encryptionKey: Buffer;

  constructor(options: {
    rootDirectory: string;
    now?: () => number;
    createChallengeId?: () => string;
    encryptionKey?: Uint8Array;
  }) {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw new Error("Auth challenge root must be absolute.");
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.lockManager = new ResourceLockManager({
      rootDirectory: path.join(this.rootDirectory, "locks"),
    });
    this.now = options.now ?? Date.now;
    this.createChallengeId = options.createChallengeId ?? (() => randomBytes(32).toString("base64url"));
    this.encryptionKey = Buffer.from(options.encryptionKey ?? challengeEncryptionKey());
    if (this.encryptionKey.byteLength !== 32) {
      throw new Error("Auth challenge encryption key must contain exactly 32 bytes.");
    }
  }

  private authenticatedData(record: Pick<
    LocalAuthChallengeRecord,
    "challengeIdHash" | "installationId" | "userId" | "issuedAt" | "expiresAt"
  >) {
    return Buffer.from([
      "aibrain-auth-challenge-v1",
      record.challengeIdHash,
      record.installationId,
      record.userId,
      String(record.issuedAt),
      String(record.expiresAt),
    ].join("\0"));
  }

  private encryptCredentials(
    metadata: Pick<
      LocalAuthChallengeRecord,
      "challengeIdHash" | "installationId" | "userId" | "issuedAt" | "expiresAt"
    >,
    credentials: { accessToken: string; refreshToken: string },
  ) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
    cipher.setAAD(this.authenticatedData(metadata));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(credentials), "utf8"),
      cipher.final(),
    ]);
    return {
      encryptedCredentials: encrypted.toString("base64url"),
      nonce: nonce.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
  }

  private decryptCredentials(record: LocalAuthChallengeRecord) {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.encryptionKey,
        Buffer.from(record.nonce, "base64url"),
      );
      decipher.setAAD(this.authenticatedData(record));
      decipher.setAuthTag(Buffer.from(record.authTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.encryptedCredentials, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      const credentials: unknown = JSON.parse(plaintext);
      if (
        !credentials || typeof credentials !== "object"
        || !("accessToken" in credentials) || typeof credentials.accessToken !== "string"
        || !("refreshToken" in credentials) || typeof credentials.refreshToken !== "string"
        || credentials.accessToken.length < 16 || credentials.accessToken.length > 16_384
        // Refresh tokens are opaque provider values; self-hosted GoTrue issues 12-character tokens.
        || credentials.refreshToken.length < 1 || credentials.refreshToken.length > 16_384
      ) {
        throw new Error("Auth challenge credentials are invalid.");
      }
      return { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken };
    } catch (error) {
      throw new Error("Auth challenge credentials could not be authenticated.", { cause: error });
    }
  }

  private recordPath(hash: string) {
    if (!HASH_PATTERN.test(hash)) throw new Error("Auth challenge hash is invalid.");
    return path.join(this.rootDirectory, "records", `${hash}.json`);
  }

  private async readByHash(hash: string) {
    const recordsRoot = path.join(this.rootDirectory, "records");
    const relativePath = `${hash}.json`;
    try {
      const contents = await readRegularFileWithin(
        recordsRoot,
        relativePath,
        CHALLENGE_FILE_MAX_BYTES,
      );
      const record = parseJson(localAuthChallengeSchema, contents.toString("utf8"), relativePath);
      if (record.challengeIdHash !== hash) {
        throw new Error("Auth challenge file does not match its filename.");
      }
      return record;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async create(input: {
    installationId: string;
    userId: string;
    accessToken: string;
    refreshToken: string;
  }) {
    const challengeId = this.createChallengeId();
    const hash = challengeHash(challengeId);
    const now = this.now();
    const metadata = {
      schemaVersion: 1,
      challengeIdHash: hash,
      kind: "initial-password-change",
      installationId: input.installationId,
      userId: input.userId,
      issuedAt: now,
      expiresAt: now + INITIAL_PASSWORD_CHALLENGE_MS,
    } as const;
    const record: LocalAuthChallengeRecord = {
      ...metadata,
      ...this.encryptCredentials(metadata, input),
    };
    await this.lockManager.withLock(`auth-challenge:${hash}`, async () => {
      if (await this.readByHash(hash)) throw new Error("Auth challenge id collision.");
      await atomicWriteJson(this.recordPath(hash), record, localAuthChallengeSchema);
    });
    return { challengeId, record };
  }

  async consume<Result>(
    challengeId: string,
    expectedInstallationId: string,
    operation: (record: LocalAuthChallenge) => Promise<Result>,
  ): Promise<Result | null> {
    let hash: string;
    try {
      hash = challengeHash(challengeId);
    } catch {
      return null;
    }
    return this.lockManager.withLock(`auth-challenge:${hash}`, async () => {
      const record = await this.readByHash(hash);
      if (!record || record.installationId !== expectedInstallationId) return null;
      if (record.expiresAt <= this.now()) {
        await unlink(this.recordPath(hash)).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
        return null;
      }
      const result = await operation({
        schemaVersion: record.schemaVersion,
        challengeIdHash: record.challengeIdHash,
        kind: record.kind,
        installationId: record.installationId,
        userId: record.userId,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        ...this.decryptCredentials(record),
      });
      await unlink(this.recordPath(hash));
      return result;
    });
  }

  async delete(challengeId: string) {
    let hash: string;
    try {
      hash = challengeHash(challengeId);
    } catch {
      return false;
    }
    return this.lockManager.withLock(`auth-challenge:${hash}`, async () => {
      try {
        await unlink(this.recordPath(hash));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    });
  }
}

function challengeEncryptionKey() {
  const secret = process.env.AIBRAIN_AUTH_CHALLENGE_SECRET?.trim()
    || process.env.AIBRAIN_SESSION_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error(
      "AIBRAIN_AUTH_CHALLENGE_SECRET or AIBRAIN_SESSION_SECRET is required in production.",
    );
  }
  return createHash("sha256")
    .update("aibrain:auth-challenge-encryption:v1\0")
    .update(secret || "aibrain-development-challenge-secret")
    .digest();
}
