import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteJson, fsyncDirectory } from "@/storage/atomic-file";
import { ResourceLockManager } from "@/storage/resource-lock";
import { defineVersionedSchema, expectInteger, expectString, parseJson } from "@/storage/schema";

export const PASSWORD_RECOVERY_MS = 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9_-]+$/;

type Record = {
  schemaVersion: 1;
  idHash: string;
  installationId: string;
  publicOrigin: string;
  issuedAt: number;
  expiresAt: number;
  encrypted: string;
  nonce: string;
  tag: string;
};

const schema = defineVersionedSchema<Record>({
  name: "PasswordRecoveryRequest", schemaVersion: 1,
  keys: ["idHash", "installationId", "publicOrigin", "issuedAt", "expiresAt", "encrypted", "nonce", "tag"],
  parse(record, context) {
    const issuedAt = expectInteger(record.issuedAt, context.at("issuedAt"), { minimum: 0 });
    const publicOrigin = expectString(record.publicOrigin, context.at("publicOrigin"), { minLength: 8, maxLength: 2048 });
    const url = new URL(publicOrigin);
    if (url.origin !== publicOrigin || !["https:", "http:"].includes(url.protocol)) context.fail("Invalid recovery origin.");
    return {
      schemaVersion: 1,
      idHash: expectString(record.idHash, context.at("idHash"), { minLength: 64, maxLength: 64, pattern: HASH }),
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2, maxLength: 63, pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
      }),
      publicOrigin, issuedAt,
      expiresAt: expectInteger(record.expiresAt, context.at("expiresAt"), { minimum: issuedAt + 1, maximum: issuedAt + PASSWORD_RECOVERY_MS }),
      encrypted: expectString(record.encrypted, context.at("encrypted"), { minLength: 16, maxLength: 2048, pattern: BASE64 }),
      nonce: expectString(record.nonce, context.at("nonce"), { minLength: 16, maxLength: 16, pattern: BASE64 }),
      tag: expectString(record.tag, context.at("tag"), { minLength: 22, maxLength: 22, pattern: BASE64 }),
    };
  },
});

function missing(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function requestHash(id: string) {
  if (!ID.test(id)) return null;
  return createHash("sha256").update(id).digest("hex");
}

function encryptionKey() {
  const secret = process.env.AIBRAIN_AUTH_CHALLENGE_SECRET?.trim() || process.env.AIBRAIN_SESSION_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "production") throw new Error("Recovery encryption secret is required.");
  return createHash("sha256").update("aibrain:password-recovery:v1\0")
    .update(secret || "aibrain-development-recovery-secret").digest();
}

export class FilePasswordRecoveryStore {
  private readonly locks: ResourceLockManager;
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly root: string;

  constructor(options: { rootDirectory: string; encryptionKey?: Uint8Array; now?: () => number }) {
    if (!path.isAbsolute(options.rootDirectory)) throw new Error("Recovery root must be absolute.");
    this.root = options.rootDirectory;
    this.now = options.now ?? Date.now;
    this.key = Buffer.from(options.encryptionKey ?? encryptionKey());
    if (this.key.length !== 32) throw new Error("Recovery encryption key must contain 32 bytes.");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks") });
  }

  private file(hash: string) { return path.join(this.root, "records", `${hash}.json`); }
  private aad(record: Pick<Record, "idHash" | "installationId" | "publicOrigin" | "issuedAt" | "expiresAt">) {
    return Buffer.from(JSON.stringify(["password-recovery-v1", record.idHash, record.installationId,
      record.publicOrigin, record.issuedAt, record.expiresAt]));
  }
  private async read(hash: string) {
    try {
      const bytes = await readRegularFileWithin(path.join(this.root, "records"), `${hash}.json`, 8192);
      const record = parseJson(schema, bytes.toString("utf8"));
      if (record.idHash !== hash) throw new Error("Recovery record identity mismatch.");
      return record;
    } catch (error) { if (missing(error)) return null; throw error; }
  }

  async create(input: { installationId: string; publicOrigin: string; email: string }) {
    await this.pruneExpired();
    const recoveryId = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const issuedAt = this.now();
    const metadata = {
      schemaVersion: 1 as const, idHash: requestHash(recoveryId)!, installationId: input.installationId,
      publicOrigin: input.publicOrigin, issuedAt, expiresAt: issuedAt + PASSWORD_RECOVERY_MS,
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.aad(metadata));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ codeVerifier, email: input.email }), "utf8"), cipher.final()]);
    await this.locks.withLock(`password-recovery:${metadata.idHash}`, async () => {
      if (await this.read(metadata.idHash)) throw new Error("Recovery request collision.");
      await atomicWriteJson(this.file(metadata.idHash), {
        ...metadata, encrypted: encrypted.toString("base64url"), nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"),
      }, schema);
    });
    return { recoveryId, codeVerifier, expiresAt: metadata.expiresAt };
  }

  async consume<Result>(id: string, expected: { installationId: string; publicOrigin: string },
    operation: (secrets: { codeVerifier: string; email: string }) => Promise<Result>): Promise<Result | null> {
    const hash = requestHash(id);
    if (!hash) return null;
    return this.locks.withLock(`password-recovery:${hash}`, async () => {
      const record = await this.read(hash);
      if (!record || record.installationId !== expected.installationId || record.publicOrigin !== expected.publicOrigin) return null;
      if (record.expiresAt <= this.now()) { await unlink(this.file(hash)); return null; }
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.nonce, "base64url"));
      decipher.setAAD(this.aad(record));
      decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
      const decoded: unknown = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(record.encrypted, "base64url")), decipher.final(),
      ]).toString("utf8"));
      if (!decoded || typeof decoded !== "object" || !("codeVerifier" in decoded)
        || typeof decoded.codeVerifier !== "string" || !/^[A-Za-z0-9_-]{64}$/.test(decoded.codeVerifier)
        || !("email" in decoded) || typeof decoded.email !== "string" || decoded.email.length > 320) {
        throw new Error("Recovery secrets are invalid.");
      }
      // Claim durably BEFORE contacting the provider. A crash, failed exchange,
      // or repeated/concurrent POST cannot reuse browser state. Request a new link.
      await unlink(this.file(hash));
      await fsyncDirectory(path.join(this.root, "records"));
      return operation({ codeVerifier: decoded.codeVerifier, email: decoded.email });
    });
  }

  private async pruneExpired() {
    let entries;
    try { entries = await readdir(path.join(this.root, "records"), { withFileTypes: true }); }
    catch (error) { if (missing(error)) return; throw error; }
    for (const entry of entries.filter((item) => item.isFile() && /^[a-f0-9]{64}\.json$/.test(item.name)).slice(0, 200)) {
      const hash = entry.name.slice(0, -5);
      await this.locks.withLock(`password-recovery:${hash}`, async () => {
        const record = await this.read(hash);
        if (record && record.expiresAt <= this.now()) await unlink(this.file(hash));
      });
    }
  }
}
