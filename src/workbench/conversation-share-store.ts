import "server-only";

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AuthSession } from "@/auth/types";
import type { ChatMessage } from "@/lib/chat-contract";
import { isChatMessage } from "@/lib/chat-contract";
import { atomicWriteJson, type StorageSchema } from "@/storage";
import { WorkbenchNotFoundError, WorkbenchPersistenceError } from "@/workbench/errors";
import type { WorkbenchProject, WorkbenchThread } from "@/workbench/types";
import { isUuid } from "@/workbench/types";

export type ConversationShare = {
  schemaVersion: 1;
  id: string;
  tenantId: string;
  threadId: string;
  projectName: string;
  title: string;
  createdAt: string;
  createdBy: { id: string; name: string };
  messages: ChatMessage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isConversationShare(value: unknown): value is ConversationShare {
  if (!isRecord(value) || Object.keys(value).length !== 9 || value.schemaVersion !== 1 ||
    !isUuid(value.id) || !isUuid(value.threadId) ||
    typeof value.tenantId !== "string" || !/^[a-z][a-z0-9-]{1,62}$/u.test(value.tenantId) ||
    typeof value.projectName !== "string" || !value.projectName.trim() || value.projectName.length > 100 ||
    typeof value.title !== "string" || !value.title.trim() || value.title.length > 120 ||
    typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    !isRecord(value.createdBy) || Object.keys(value.createdBy).length !== 2 ||
    typeof value.createdBy.id !== "string" || !value.createdBy.id ||
    typeof value.createdBy.name !== "string" || !value.createdBy.name.trim() || value.createdBy.name.length > 100 ||
    !Array.isArray(value.messages) || value.messages.length > 10_000 ||
    !value.messages.every(isChatMessage)) return false;
  return true;
}

const shareSchema: StorageSchema<ConversationShare> = {
  name: "ConversationShare",
  parse(value, source = "ConversationShare") {
    if (!isConversationShare(value)) {
      throw new WorkbenchPersistenceError(`La còpia compartida no és vàlida (${source}).`);
    }
    return value;
  },
};

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class ConversationShareStore {
  private readonly root: string;

  constructor(dataRoot: string) {
    if (!path.isAbsolute(dataRoot)) throw new WorkbenchPersistenceError("Ruta de dades no vàlida.");
    this.root = path.join(path.resolve(dataRoot), "conversation-shares");
  }

  private async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new WorkbenchPersistenceError("El magatzem de còpies compartides no és segur.");
    }
    await chmod(this.root, 0o700);
    return realpath(this.root);
  }

  private file(root: string, shareId: string) {
    if (!isUuid(shareId)) throw new WorkbenchNotFoundError("Còpia compartida no trobada.");
    const candidate = path.join(root, `${shareId}.json`);
    if (!inside(root, candidate)) throw new WorkbenchNotFoundError("Còpia compartida no trobada.");
    return candidate;
  }

  async create(
    session: AuthSession,
    project: WorkbenchProject,
    thread: WorkbenchThread,
  ): Promise<ConversationShare> {
    const root = await this.prepare();
    const share: ConversationShare = {
      schemaVersion: 1,
      id: randomUUID(),
      tenantId: session.tenant.id,
      threadId: thread.id,
      projectName: project.name,
      title: thread.title,
      createdAt: new Date().toISOString(),
      createdBy: { id: session.user.id, name: session.user.name },
      messages: structuredClone(thread.messages),
    };
    await atomicWriteJson(this.file(root, share.id), share, shareSchema, { mode: 0o600 });
    return share;
  }

  async read(session: AuthSession, shareId: string): Promise<ConversationShare> {
    const root = await this.prepare();
    const target = this.file(root, shareId);
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || metadata.size > 64 * 1024 * 1024) {
        throw new WorkbenchNotFoundError("Còpia compartida no trobada.");
      }
      const share = shareSchema.parse(JSON.parse(await readFile(target, "utf8")) as unknown, target);
      if (share.tenantId !== session.tenant.id) throw new WorkbenchNotFoundError("Còpia compartida no trobada.");
      return share;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new WorkbenchNotFoundError("Còpia compartida no trobada.");
      }
      throw error;
    }
  }
}
