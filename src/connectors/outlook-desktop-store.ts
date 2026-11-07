import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import { USER_ID_PATTERN } from "@/connectors/contracts";
import { mailEncryptionKey } from "./mail-store";
import { OutlookDesktopError, type OutlookDesktopArgs, type OutlookDesktopOperation } from "./outlook-desktop-contracts";
export type DesktopMachine = { sid: string; computer: string; email: string; storeIds: string[] };
export type DesktopJob = { operationId: string; operation: OutlookDesktopOperation; args: OutlookDesktopArgs; fingerprint: string; deviceId: string; policyHash: string; email: string; status: "pending" | "leased" | "succeeded" | "failed" | "unknown"; createdAt: number; deadline: number; leaseId?: string; terminalAt?: number; resultExpired?: boolean; reportHash?: string; lateObserved?: { outcome: string; result?: Record<string, unknown>; error?: string; receivedAt: number }; result?: Record<string, unknown>; error?: string };
export type DesktopState = { schema: 1; installationId: string; userId: string; pairing?: DesktopMachine & { hash: string; expiresAt: number }; device?: DesktopMachine & { id: string; tokenHash: string; enrolledAt: number; lastSeenAt?: number; outlookOpen?: boolean; availableStoreIds?: string[]; version?: string; revoked?: boolean }; jobs: DesktopJob[] };
const missing = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
export class FileOutlookDesktopStore {
  readonly locks: ResourceLockManager;
  constructor(private readonly config: Readonly<InstallationConfig>, private readonly key = mailEncryptionKey()) {
    this.locks = new ResourceLockManager({ rootDirectory: path.join(config.paths.dataRoot, "connectors", "outlook-desktop", "locks"), defaultTimeoutMs: 15_000, staleAfterMs: 60_000 });
  }
  private async file(userId: string) {
    if (!USER_ID_PATTERN.test(userId)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_IDENTITY_INVALID", 403);
    const users = path.resolve(this.config.paths.usersRoot); let folder = users;
    for (const segment of ["", userId, "connectors", "outlook-desktop"]) {
      if (segment) folder = path.join(folder, segment);
      if (["connectors", "outlook-desktop"].includes(segment)) await mkdir(folder, { mode: 0o700 }).catch(error => { if (!error || error.code !== "EEXIST") throw error; });
      const meta = await lstat(folder);
      const relative = path.relative(await realpath(users), await realpath(folder));
      if (!meta.isDirectory() || meta.isSymbolicLink() || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || segment !== "" && (meta.mode & 0o077) !== 0) throw new OutlookDesktopError("OUTLOOK_DESKTOP_STORAGE_UNSAFE", 503);
      if (["connectors", "outlook-desktop"].includes(segment)) await chmod(folder, 0o700);
    }
    return path.join(folder, "broker.json");
  }
  async read(userId: string): Promise<DesktopState> {
    const file = await this.file(userId);
    let handle; try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if (missing(error)) return { schema: 1, installationId: this.config.installationId, userId, jobs: [] }; throw new OutlookDesktopError("OUTLOOK_DESKTOP_STORAGE_UNSAFE", 503); }
    try {
      const meta = await handle.stat(); if (!meta.isFile() || meta.size > 100 * 1024 * 1024 || (meta.mode & 0o077) !== 0) throw new Error();
      const record = JSON.parse(await handle.readFile("utf8")); if (record.v !== 1) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64")); decipher.setAAD(Buffer.from(`${this.config.installationId}\0${userId}\0outlook-desktop`)); decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8")) as DesktopState;
      if (state.schema !== 1 || state.userId !== userId || state.installationId !== this.config.installationId || !Array.isArray(state.jobs)) throw new Error(); return state;
    } catch { throw new OutlookDesktopError("OUTLOOK_DESKTOP_STORAGE_INVALID", 503); } finally { await handle.close(); }
  }
  async put(userId: string, state: DesktopState) {
    const file = await this.file(userId); const text = JSON.stringify(state); if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new OutlookDesktopError("OUTLOOK_DESKTOP_STORAGE_FULL", 503);
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv); cipher.setAAD(Buffer.from(`${this.config.installationId}\0${userId}\0outlook-desktop`));
    const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    await atomicWriteFile(file, JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
  }
  async transaction<T>(userId: string, action: (state: DesktopState) => Promise<T>) { return this.locks.withLock(`outlook-desktop:${this.config.installationId}:${userId}`, async () => { const state = await this.read(userId); const result = await action(state); await this.put(userId, state); return result; }); }
}
