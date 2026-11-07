import "server-only";
import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { mkdir, lstat, chmod, realpath } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import { readRegularFileWithin } from "@/security/safe-file";
import { SHOPIFY_SHOP, parseShopifyProfileToken, SHOPIFY_ORDERS_PROFILE, type ShopifyCredentialProfile, shopifyFail, type ShopifyToken } from "./shopify-contracts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function actor(userId: string, sessionId: string) { if (!UUID.test(userId) || !/^[A-Za-z0-9_-]{40,128}$/.test(sessionId)) shopifyFail("SESSION_INVALID"); }
type State = { userId: string; sessionHash: string; nonceHash: string; redirectUri: string; expiresAt: number; consumed: boolean };
type Stored = { version: number; ownerId: string; token: ShopifyToken };

/** Control-plane data only. Never place below a user workspace or mount into Codex workers. */
export class ShopifyStore {
  private root: string;
  private locks: ResourceLockManager;
  constructor(private config: Readonly<InstallationConfig>, private key: Buffer, private now = Date.now, private profile: ShopifyCredentialProfile = SHOPIFY_ORDERS_PROFILE) {
    if (config.installationId !== "modtime" || key.length !== 32) shopifyFail("STORE_CONFIGURATION_INVALID");
    this.root = path.join(path.resolve(config.paths.dataRoot), "connectors", this.profile.directory);
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks"), defaultTimeoutMs: 65_000 });
  }
  private async ready() {
    // Validate every descendant before use; reject symlinks rather than following them.
    for (const dir of [path.resolve(this.config.paths.dataRoot), path.dirname(this.root), this.root, path.join(this.root, "locks")]) {
      await mkdir(dir, { recursive: true, mode: 0o700 }); const meta = await lstat(dir);
      if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(dir) !== dir) shopifyFail("STORAGE_UNSAFE");
      if (dir === this.root || dir === path.join(this.root, "locks")) await chmod(dir, 0o700);
    }
  }
  private async read(name: string): Promise<unknown> {
    try { return JSON.parse((await readRegularFileWithin(this.root, name, 32_768)).toString("utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; shopifyFail("STORAGE_INVALID"); }
  }
  async createState(userId: string, sessionId: string, redirectUri: string) {
    actor(userId, sessionId); await this.ready();
    // One state per actor keeps storage bounded; a new explicit start invalidates the previous attempt.
    return this.locks.withLock(`oauth:${userId}`, async () => {
      const state = randomBytes(32).toString("hex");
      const record: State = { userId, sessionHash: hash(sessionId), nonceHash: hash(state), redirectUri, expiresAt: this.now() + 300_000, consumed: false };
      await atomicWriteFile(path.join(this.root, `state-${userId}.json`), JSON.stringify(record), { mode: 0o600 }); return state;
    });
  }
  async consumeState(userId: string, sessionId: string, state: string, redirectUri: string) {
    actor(userId, sessionId); if (!/^[a-f0-9]{64}$/.test(state)) shopifyFail("STATE_INVALID"); await this.ready();
    await this.locks.withLock(`oauth:${userId}`, async () => {
      const record = await this.read(`state-${userId}.json`) as State | null;
      if (!record || record.userId !== userId || typeof record.sessionHash !== "string" || typeof record.nonceHash !== "string" ||
        !equal(record.sessionHash, hash(sessionId)) || !equal(record.nonceHash, hash(state)) || record.redirectUri !== redirectUri ||
        !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= this.now() || record.consumed !== false) shopifyFail("STATE_INVALID");
      await atomicWriteFile(path.join(this.root, `state-${userId}.json`), JSON.stringify({ ...record, consumed: true }), { mode: 0o600 });
    });
  }
  private async readToken(): Promise<Stored | null> {
    const envelope = await this.read("token.json") as { iv: string; tag: string; ciphertext: string } | null;
    if (!envelope) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from(`modtime\0${SHOPIFY_SHOP}\0${this.profile.clientId}`)); decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const p = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
      if (!Number.isSafeInteger(p.version) || p.version < 1 || !UUID.test(p.ownerId)) shopifyFail("STORAGE_INVALID");
      return { version: p.version, ownerId: p.ownerId, token: parseShopifyProfileToken(p.token, this.profile) };
    } catch { shopifyFail("STORAGE_INVALID"); }
  }
  private async writeToken(record: Stored) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`modtime\0${SHOPIFY_SHOP}\0${this.profile.clientId}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
    await atomicWriteFile(path.join(this.root, "token.json"), JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
  }
  /** Serialize install exchange AND refresh + persistence across server processes. Never expose a token to callers. */
  async install(ownerId: string, mintAndVerify: () => Promise<ShopifyToken>) {
    if (!UUID.test(ownerId)) shopifyFail("ACTOR_DENIED"); await this.ready();
    return this.locks.withLock("credentials", async () => {
      const previous = await this.readToken(), token = parseShopifyProfileToken(await mintAndVerify(), this.profile);
      const version = (previous?.version ?? 0) + 1; await this.writeToken({ ownerId, version, token }); return version;
    });
  }
  async withAccess<T>(refresh: (token: ShopifyToken) => Promise<ShopifyToken>, read: (access: string, version: number) => Promise<T>): Promise<T> {
    await this.ready();
    return this.locks.withLock("credentials", async () => {
      let stored = await this.readToken(); if (!stored) shopifyFail("LOGIN_REQUIRED");
      if (stored.token.expiresAt <= this.now() + 60_000) {
        if (stored.token.refreshExpiresAt <= this.now() + 60_000) shopifyFail("REAUTH_REQUIRED");
        const token = parseShopifyProfileToken(await refresh(stored.token), this.profile);
        if (token.expiresAt <= this.now() + 60_000 || token.refreshExpiresAt <= this.now() + 60_000) shopifyFail("TOKEN_INVALID");
        stored = { ...stored, token, version: stored.version + 1 }; await this.writeToken(stored);
      }
      return read(stored.token.accessToken, stored.version);
    });
  }
}
