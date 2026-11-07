import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import { readRegularFileWithin } from "@/security/safe-file";
import { CompanyMailError, parseCompanyMailCredential, type CompanyMailCredential } from "./company-mail-contracts";

export const MAIL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const MAIL_HASH = /^[0-9a-f]{64}$/u;
export function companyMailEncryptionKey(value = process.env.AIBRAIN_COMPANY_MAIL_ENCRYPTION_KEY) {
  const key = Buffer.from(value ?? "", "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new CompanyMailError("MAIL_KEY_NOT_CONFIGURED", "El administrador debe configurar el cifrado del correo.", 503);
  return key;
}

/** Check every ancestor we create; credentials and receipts never enter a worker mount. */
export async function privateMailDirectory(root: string, segments: readonly string[]) {
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9._-]+$/u.test(segment) || segment === "." || segment === "..") throw new CompanyMailError("MAIL_PATH_UNSAFE", "Ruta de almacenamiento no válida.");
    current = path.join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    const meta = await lstat(current);
    if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(current) !== current) throw new CompanyMailError("MAIL_PATH_UNSAFE", "Ruta de almacenamiento no segura.");
    await chmod(current, 0o700);
  }
  return current;
}

export class FileCompanyMailStore {
  constructor(readonly config: Readonly<InstallationConfig>, private readonly key: Buffer) {
    if (key.length !== 32) throw new CompanyMailError("MAIL_KEY_INVALID", "Clave de cifrado no válida.");
  }
  async root(userId: string) {
    if (!MAIL_UUID.test(userId)) throw new CompanyMailError("MAIL_USER_INVALID", "Usuario no válido.");
    return privateMailDirectory(this.config.paths.dataRoot, ["server", "company-mail", this.config.installationId, userId]);
  }
  async withUserLock<T>(userId: string, action: () => Promise<T>) {
    const root = await this.root(userId);
    return new ResourceLockManager({ rootDirectory: path.join(root, "locks"), defaultTimeoutMs: 5_000 }).withLock("mail-account", action);
  }
  private reference(ref: string) {
    const id = ref.slice("company-mail:".length);
    if (!ref.startsWith("company-mail:") || !MAIL_UUID.test(id)) throw new CompanyMailError("MAIL_REFERENCE_INVALID", "Referencia de credencial no válida.");
    return `${id}.json`;
  }
  async put(userId: string, credential: CompanyMailCredential) {
    const credentialRef = `company-mail:${randomUUID()}`;
    const root = await privateMailDirectory(await this.root(userId), ["credentials"]);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${this.config.installationId}\0${userId}\0${credentialRef}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
    await atomicWriteFile(path.join(root, this.reference(credentialRef)), JSON.stringify({ schemaVersion: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
    return credentialRef;
  }
  async read(userId: string, credentialRef: string): Promise<CompanyMailCredential> {
    const root = await privateMailDirectory(await this.root(userId), ["credentials"]);
    try {
      const stored = JSON.parse((await readRegularFileWithin(root, this.reference(credentialRef), 16 * 1024)).toString("utf8"));
      if (stored.schemaVersion !== 1 || typeof stored.iv !== "string" || typeof stored.tag !== "string" || typeof stored.ciphertext !== "string") throw new Error("invalid");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(stored.iv, "base64"));
      decipher.setAAD(Buffer.from(`${this.config.installationId}\0${userId}\0${credentialRef}`));
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      const raw = Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, "base64")), decipher.final()]);
      return parseCompanyMailCredential(JSON.parse(raw.toString("utf8")), this.config.connectors?.companyMail?.emailDomain ?? "");
    } catch { throw new CompanyMailError("MAIL_CREDENTIAL_UNAVAILABLE", "Reconecta el buzón desde Ajustes.", 401); }
  }
  async clear(userId: string, credentialRef: string) {
    await unlink(path.join(await privateMailDirectory(await this.root(userId), ["credentials"]), this.reference(credentialRef))).catch((error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}
