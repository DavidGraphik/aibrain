import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteJson } from "@/storage/atomic-file";
import { FileJournal } from "@/storage/journal";
import { ResourceLockManager } from "@/storage/resource-lock";
import { defineVersionedSchema, expectInteger, expectOneOf, expectString, parseJson } from "@/storage/schema";
import type { FileLocalUserStore } from "@/auth/local-user-store";
import type { FileLocalSessionStore } from "@/auth/local-session-store";

export const SUPPORT_CODE_MS = 3 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Grant = { schemaVersion: 1; grantId: string; installationId: string; targetUserId: string; targetEmail: string;
  actorUserId: string; actorEmail: string; reason: string; issuedAt: number; expiresAt: number;
  status: "issued" | "consumed" | "revoked"; sessionIdHash: string; previewThreadId?:string; previewAppId?:string };
const grantSchemaFor = (preview:boolean) => defineVersionedSchema<Grant>({ name: "SupportAccessGrant", schemaVersion: 1,
  keys: ["grantId", "installationId", "targetUserId", "targetEmail", "actorUserId", "actorEmail", "reason", "issuedAt", "expiresAt", "status", "sessionIdHash", ...(preview ? ["previewThreadId", "previewAppId"] as const : [])],
  parse(r, c) {
    const issuedAt = expectInteger(r.issuedAt, c.at("issuedAt"), { minimum: 0 });
    const expiresAt = expectInteger(r.expiresAt, c.at("expiresAt"), { minimum: issuedAt + 1, maximum: issuedAt + SUPPORT_CODE_MS });
    const reason = expectString(r.reason, c.at("reason"), { minLength: 10, maxLength: 500 });
    if (/[\x00-\x1f\x7f]/.test(reason) || reason.trim().length < 10) c.at("reason").fail("Invalid support reason.");
    const hasPreview=r.previewThreadId!==undefined||r.previewAppId!==undefined;
    if(hasPreview && r.installationId!=="g03-production" && r.installationId!=="g03-qa") c.at("previewThreadId").fail("Preview is unavailable for this installation.");
    return { schemaVersion: 1,
      grantId: expectString(r.grantId, c.at("grantId"), { pattern: HASH }),
      installationId: expectString(r.installationId, c.at("installationId"), { pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/ }),
      targetUserId: expectString(r.targetUserId, c.at("targetUserId"), { pattern: UUID }),
      targetEmail: expectString(r.targetEmail, c.at("targetEmail"), { pattern: EMAIL, maxLength: 320 }),
      actorUserId: expectString(r.actorUserId, c.at("actorUserId"), { pattern: UUID }),
      actorEmail: expectString(r.actorEmail, c.at("actorEmail"), { pattern: EMAIL, maxLength: 320 }),
      reason, issuedAt, expiresAt,
      status: expectOneOf(r.status, ["issued", "consumed", "revoked"] as const, c.at("status")),
      sessionIdHash: expectString(r.sessionIdHash, c.at("sessionIdHash"), { pattern: /^(?:[a-f0-9]{64})?$/ }),
      ...(hasPreview?{previewThreadId:expectString(r.previewThreadId,c.at("previewThreadId"),{pattern:UUID}),previewAppId:expectString(r.previewAppId,c.at("previewAppId"),{pattern:UUID})}:{}),
    };
  },
});
const ordinaryGrantSchema=grantSchemaFor(false), previewGrantSchema=grantSchemaFor(true);
const grantSchema={name:"SupportAccessGrant",schemaVersion:1 as const,parse(value:unknown,source?:string):Grant {
  const preview=!!value && typeof value==="object" && !Array.isArray(value) &&
    (Object.hasOwn(value,"previewThreadId")||Object.hasOwn(value,"previewAppId"));
  return (preview?previewGrantSchema:ordinaryGrantSchema).parse(value,source);
}};
export class SupportAccessError extends Error {}
export class FileSupportAccessStore {
  private readonly root: string;
  private readonly locks: ResourceLockManager;
  private readonly audit: FileJournal<Grant>;
  constructor(private readonly options: { root: string; installationId: string; users: FileLocalUserStore; operatorUserId: string; sessions: FileLocalSessionStore; now?: () => number }) {
    if (!path.isAbsolute(options.root)) throw new Error("Support root must be absolute.");
    this.root = options.root;
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks") });
    this.audit = new FileJournal({ filePath: path.join(this.root, "audit.jsonl"), lockManager: new ResourceLockManager({ rootDirectory: path.join(this.root, "audit-locks") }), payloadSchema: grantSchema });
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private file(id: string) { if (!HASH.test(id)) throw new SupportAccessError("Invalid support grant."); return path.join(this.root, "grants", `${id}.json`); }
  private async read(id: string) {
    this.file(id);
    try { return parseJson(grantSchema, (await readRegularFileWithin(path.join(this.root, "grants"), `${id}.json`, 8192)).toString("utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  private async profiles(grant: Pick<Grant, "targetUserId" | "targetEmail" | "actorUserId" | "actorEmail">) {
    if (grant.actorUserId !== this.options.operatorUserId) throw new SupportAccessError("Configured operator identity required.");
    const target = await this.options.users.read(grant.targetUserId);
    const actor = await this.options.users.read(grant.actorUserId);
    if (await this.options.users.hasInitialPasswordMarker(grant.targetUserId)) throw new SupportAccessError("Personal initial login required before support access.");
    if (!target?.enabled || target.email !== grant.targetEmail || !actor?.enabled || actor.email !== grant.actorEmail) throw new SupportAccessError("Active canonical profiles required.");
  }
  async issue(input: { targetUserId: string; targetEmail: string; actorUserId: string; actorEmail: string; reason: string; previewThreadId?:string; previewAppId?:string }) {
    const code = randomBytes(32).toString("base64url");
    const grantId = createHash("sha256").update(code).digest("hex");
    const now = this.now();
    const grant = grantSchema.parse({ ...input, reason: input.reason.trim(), schemaVersion: 1, grantId, installationId: this.options.installationId, issuedAt: now, expiresAt: now + SUPPORT_CODE_MS, status: "issued", sessionIdHash: "" });
    await this.profiles(grant);
    // Audit must persist before any credential becomes usable.
    await this.audit.append(grant);
    await atomicWriteJson(this.file(grantId), grant, grantSchema);
    return { code, grantId, expiresAt: grant.expiresAt };
  }
  async redeem(code: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new SupportAccessError("Support code unavailable.");
    const id = createHash("sha256").update(code).digest("hex");
    return this.locks.withLock(id, async () => {
      const grant = await this.read(id);
      if (!grant || grant.installationId !== this.options.installationId || grant.status !== "issued" || grant.expiresAt <= this.now()) throw new SupportAccessError("Support code unavailable.");
      await this.profiles(grant);
      const consumed: Grant = { ...grant, status: "consumed" };
      // One-use is persisted before session creation, including crash/error paths.
      await atomicWriteJson(this.file(id), consumed, grantSchema);
      const session = await this.options.sessions.create(this.options.installationId, grant.targetUserId,
        { actorUserId: grant.actorUserId, actorEmail: grant.actorEmail, reason: grant.reason,
          ...(grant.previewThreadId&&grant.previewAppId?{preview:{threadId:grant.previewThreadId,appId:grant.previewAppId}}:{}) });
      try {
        consumed.sessionIdHash = session.record.sessionIdHash;
        await atomicWriteJson(this.file(id), consumed, grantSchema);
        await this.audit.append(consumed);
      } catch (error) {
        await this.options.sessions.delete(session.sessionId);
        throw error;
      }
      return session;
    });
  }
  async revoke(grantId: string) {
    return this.locks.withLock(grantId, async () => {
      const grant = await this.read(grantId);
      if (!grant || grant.installationId !== this.options.installationId) throw new SupportAccessError("Support grant unavailable.");
      if (grant.sessionIdHash) await this.options.sessions.revokeSupportHash(this.options.installationId, grant.sessionIdHash);
      const revoked: Grant = { ...grant, status: "revoked" };
      await atomicWriteJson(this.file(grantId), revoked, grantSchema);
      await this.audit.append(revoked);
      return { revoked: true };
    });
  }
}
