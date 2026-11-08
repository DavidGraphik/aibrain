import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import { USER_ID_PATTERN } from "@/connectors/contracts";
import { isMailRecord, MailConnectorError } from "./mail-contracts";

export function mailEncryptionKey(encoded = process.env.AIBRAIN_MAIL_ENCRYPTION_KEY ?? process.env.AIBRAIN_GOOGLE_OAUTH_ENCRYPTION_KEY) {
  const key = Buffer.from(encoded ?? "", "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !== encoded?.replace(/=+$/u, "")) throw new MailConnectorError("MAIL_ENCRYPTION_NOT_CONFIGURED", 503);
  return key;
}
function inside(root: string, candidate: string) { const rel = path.relative(root, candidate); return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel); }
export class FileMailStore {
  readonly locks: ResourceLockManager;
  constructor(private readonly config: Readonly<InstallationConfig>, private readonly key: Buffer) {
    if (key.length !== 32) throw new MailConnectorError("MAIL_ENCRYPTION_NOT_CONFIGURED", 503);
    this.locks = new ResourceLockManager({ rootDirectory: path.join(config.paths.dataRoot, "connectors", "mail", "locks"), defaultTimeoutMs: 70_000, staleAfterMs: 90_000 });
  }
  private async file(userId: string, name: string) {
    if (!USER_ID_PATTERN.test(userId) || !/^(?:credentials|preview-[a-f0-9]{32})$/.test(name)) throw new MailConnectorError("MAIL_IDENTITY_INVALID", 403);
    const users = path.resolve(this.config.paths.usersRoot), user = path.join(users, userId);
    const [rootMeta, userMeta] = await Promise.all([lstat(users), lstat(user)]);
    if (!rootMeta.isDirectory() || rootMeta.isSymbolicLink() || !userMeta.isDirectory() || userMeta.isSymbolicLink() || (userMeta.mode & 0o077) !== 0 || !inside(await realpath(users), await realpath(user))) throw new MailConnectorError("MAIL_STORAGE_UNSAFE", 503);
    let directory = user;
    for (const segment of ["connectors", "mail"]) {
      directory = path.join(directory, segment); await mkdir(directory, { recursive: true, mode: 0o700 });
      const meta = await lstat(directory);
      if (!meta.isDirectory() || meta.isSymbolicLink() || !inside(await realpath(user), await realpath(directory))) throw new MailConnectorError("MAIL_STORAGE_UNSAFE", 503);
      await chmod(directory, 0o700);
    }
    return path.join(directory, `${name}.json`);
  }
  async put(userId: string, name: string, value: unknown) {
    const file = await this.file(userId, name), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${this.config.installationId}\0${userId}\0${name}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    await atomicWriteFile(file, JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") }), { mode: 0o600 });
  }
  async read<T>(userId: string, name: string): Promise<T | null> {
    const file = await this.file(userId, name);
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (isMailRecord(error) && error.code === "ENOENT") return null; throw new MailConnectorError("MAIL_STORAGE_UNSAFE", 503); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024 || (stat.mode & 0o077) !== 0) throw new Error();
      const record: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!isMailRecord(record) || record.v !== 1 || typeof record.iv !== "string" || typeof record.tag !== "string" || typeof record.ciphertext !== "string") throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64"));
      decipher.setAAD(Buffer.from(`${this.config.installationId}\0${userId}\0${name}`)); decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8")) as T;
    } catch { throw new MailConnectorError("MAIL_STORAGE_INVALID", 503); }
    finally { await handle.close(); }
  }
  async clear(userId: string) { try { await unlink(await this.file(userId, "credentials")); } catch (error) { if (!isMailRecord(error) || error.code !== "ENOENT") throw error; } }
}
