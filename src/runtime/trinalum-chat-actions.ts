import { deploymentIdentity } from "@/deployment/identities";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, realpath, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { ResourceLockManager } from "@/storage/resource-lock";
import { readRegularFileWithin } from "@/security/safe-file";
import type { ApprovalLocator } from "@/runtime/approval-store";
import { atomicWriteJson, fsyncDirectory } from "@/storage/atomic-file";
import { connectorFingerprint } from "@/connectors/canonical";

export type ChatAction = {
  version: 1; id: string; installationId: string; userId: string;
  threadId: string; sourceTurnId: string; sourceMessageId: string;
  operation: string; input: Record<string, unknown>; locator: ApprovalLocator;
  fingerprint: string; bindingHash: string; permissionFingerprint: string;
  prepared: unknown; preview: string; displayedAt: string | null;
  createdAt: string; expiresAt: string;
};
export type ChatActionCorrection = {
  version: 1; parentId: string; childId: string; parentSha256: string; childFingerprint: string;
  parentNativeRecordSha256: string; childRequestHash: string; childEffectHash: string;
  sourceMessageId: string; sourceTurnId: string; createdAt: string;
};
const correctionSchema = {
  name: "ChatActionCorrection",
  parse(value: unknown): ChatActionCorrection {
    const r = value as ChatActionCorrection;
    const keys = ["version", "parentId", "childId", "parentSha256", "childFingerprint", "parentNativeRecordSha256", "childRequestHash", "childEffectHash", "sourceMessageId", "sourceTurnId", "createdAt"];
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).sort().join() !== keys.sort().join() || r.version !== 1 ||
        !ID.test(r.parentId) || !ID.test(r.childId) || r.parentId === r.childId || r.childId !== `web-${r.childFingerprint}` ||
        [r.parentSha256, r.childFingerprint, r.parentNativeRecordSha256, r.childRequestHash, r.childEffectHash].some(v => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) ||
        [r.sourceMessageId, r.sourceTurnId].some(v => typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v)) ||
        typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt))) throw Error("CHAT_CORRECTION_INVALID");
    return r;
  },
};
const ID = /^web-[a-f0-9]{64}$/;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Server-owned proposal storage. Model arguments never choose a root or actor. */
export class TrinalumChatActions {
  private readonly root: string;
  private readonly userRoot: string;
  private readonly locks: ResourceLockManager;
  constructor(userRoot: string, readonly identity: { installationId: string; userId: string; threadId: string }) {
    if (!path.isAbsolute(userRoot) || identity.installationId !== "trinalum-production" ||
        !/^[0-9a-f-]{36}$/i.test(identity.userId) || !identity.threadId) throw Error("CHAT_ACTION_IDENTITY_INVALID");
    this.userRoot=userRoot;
    this.root = path.join(userRoot, "trinalum-chat-actions", sha(identity.threadId));
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks") });
  }
  private async directory() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const meta = await lstat(this.root);
    const expected=path.join(await realpath(this.userRoot),"trinalum-chat-actions",sha(this.identity.threadId));
    if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(this.root) !== expected) throw Error("CHAT_ACTION_PATH_UNSAFE");
  }
  private check(record: ChatAction) {
    if (record.version !== 1 || !ID.test(record.id) || record.installationId !== this.identity.installationId ||
        record.userId !== this.identity.userId || record.threadId !== this.identity.threadId ||
        !/^[a-f0-9]{64}$/.test(record.fingerprint) || !Number.isFinite(Date.parse(record.expiresAt)) ||
        record.locator.installationId!==record.installationId||record.locator.userId!==record.userId||record.locator.threadId!==record.threadId||
        record.locator.approvalId!==record.id||record.locator.itemId!==record.id||
        connectorFingerprint({installationId:record.installationId,userId:record.userId,threadId:record.threadId,
          turnId:record.locator.turnId,sourceMessageId:record.sourceMessageId,tool:record.operation,input:record.input,
          permissionFingerprint:record.permissionFingerprint,bindingHash:record.bindingHash})!==record.fingerprint) throw Error("CHAT_ACTION_RECORD_INVALID");
    return record;
  }
  private async write(record: ChatAction) {
    this.check(record); await this.directory();
    const file = path.join(this.root, `${record.id}.json`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, file);
  }
  async read(id: string): Promise<ChatAction | null> {
    if (!ID.test(id)) throw Error("CHAT_ACTION_ID_INVALID");
    try { return this.check(JSON.parse((await readRegularFileWithin(this.root, `${id}.json`, 64 * 1024 * 1024)).toString("utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async prepare(record: ChatAction) {
    this.check(record); await this.directory();
    return this.locks.withLock(record.id, async () => {
      const existing = await this.read(record.id);
      if (existing) {
        if (existing.fingerprint !== record.fingerprint || JSON.stringify(existing.input) !== JSON.stringify(record.input)) throw Error("CHAT_ACTION_CHANGED");
        return existing;
      }
      await this.write(record); return record;
    });
  }
  /** Serialize ordinary and corrective preparation before either becomes executable. */
  async withPreparation<T>(apply: () => Promise<T>): Promise<T> {
    await this.directory(); return this.locks.withLock("corrections-v1", apply);
  }
  async correctionForChild(id: string): Promise<ChatActionCorrection | null> {
    if (!ID.test(id)) throw Error("CHAT_ACTION_ID_INVALID");
    try {
      const r = correctionSchema.parse(JSON.parse((await readRegularFileWithin(this.root, `correction-${id}.json`, 8192)).toString("utf8")));
      if (r.childId !== id) throw Error("CHAT_CORRECTION_INVALID"); return r;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async correctionForParent(id: string): Promise<ChatActionCorrection | null> {
    if (!ID.test(id)) throw Error("CHAT_ACTION_ID_INVALID");
    await this.directory(); let found: ChatActionCorrection | null = null;
    for (const file of await readdir(this.root)) {
      if (!/^correction-web-[a-f0-9]{64}\.json$/.test(file)) continue;
      const link = await this.correctionForChild(file.slice(11, -5));
      if (link?.parentId === id) { if (found) throw Error("CHAT_CORRECTION_CONFLICT"); found = link; }
    }
    return found;
  }
  /** Called only inside withPreparation, while both native status locks remain held. */
  async linkCorrection(input: ChatActionCorrection) {
    const link = correctionSchema.parse(input);
    const existing = await this.correctionForParent(link.parentId);
    if (existing) {
      if (existing.childId !== link.childId || existing.childFingerprint !== link.childFingerprint || existing.parentSha256 !== link.parentSha256 || existing.childRequestHash !== link.childRequestHash || existing.childEffectHash !== link.childEffectHash) throw Error("CHAT_CORRECTION_ALREADY_PROPOSED");
      return existing;
    }
    if (await this.correctionForChild(link.childId)) throw Error("CHAT_CORRECTION_CONFLICT");
    await fsyncDirectory(path.dirname(this.root)); await fsyncDirectory(this.userRoot);
    await atomicWriteJson(path.join(this.root, `correction-${link.childId}.json`), link, correctionSchema, { mode: 0o600 });
    return link;
  }
  async displayed(id: string) {
    return this.locks.withLock(id, async () => {
      const record = await this.read(id); if (!record) throw Error("CHAT_ACTION_NOT_FOUND");
      const next = { ...record, displayedAt: new Date().toISOString() }; await this.write(next); return next;
    });
  }
  async forSourceMessage(sourceMessageId: string) {
    await this.directory(); const records: ChatAction[] = [];
    for (const file of await readdir(this.root)) {
      if (!/^web-[a-f0-9]{64}\.json$/.test(file)) continue;
      const record = await this.read(file.slice(0, -5));
      if (record?.sourceMessageId === sourceMessageId) records.push(record);
    }
    return records;
  }
  async previewsForTurn(sourceTurnId: string) {
    await this.directory();
    const result: ChatAction[] = [];
    for (const file of await readdir(this.root)) {
      if (!/^web-[a-f0-9]{64}\.json$/.test(file)) continue;
      const record = await this.read(file.slice(0, -5));
      if (record?.sourceTurnId === sourceTurnId && record.displayedAt) result.push(record);
    }
    return result;
  }
  async displayedRecords() {
    await this.directory();const result:ChatAction[]=[];
    for(const file of await readdir(this.root)){
      if(!/^web-[a-f0-9]{64}\.json$/.test(file))continue;
      const record=await this.read(file.slice(0,-5));
      if(record?.displayedAt&&Date.parse(record.expiresAt)>Date.now())result.push(record);
    }
    return result;
  }
}

// This is an account/identity boundary, never a parser of human consent.
const EMPLOYEE_MAILBOXES = new Set([
  deploymentIdentity("manager"), deploymentIdentity("sales"), deploymentIdentity("administration"),
]);
const OUTGOING_MAIL = new Set(["send_mail", "reply", "reply_all", "forward", "send_draft"]);

/** Only verified employee sends from their own native mailbox avoid David's review boundary. */
export function requiresExactEmailReview(action: Pick<ChatAction, "operation" | "input" | "prepared">, authenticatedEmail?: string) {
  if (!["mail_action", "mail_draft"].includes(action.operation) || !OUTGOING_MAIL.has(String(action.input.type))) return false;
  const actor = authenticatedEmail?.trim().toLowerCase();
  const data = action.prepared && typeof action.prepared === "object" ? (action.prepared as {data?: unknown}).data : null;
  const preview = data && typeof data === "object" ? (data as {preview?: unknown}).preview : null;
  const sender = preview && typeof preview === "object" ? preview as {from?: unknown; mailbox?: unknown} : null;
  return !actor || !EMPLOYEE_MAILBOXES.has(actor) ||
    typeof sender?.from !== "string" || sender.from.trim().toLowerCase() !== actor ||
    typeof sender.mailbox !== "string" || sender.mailbox.trim().toLowerCase() !== actor;
}
