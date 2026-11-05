import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { readRegularFileWithin } from "@/security/safe-file";
import { validateReference } from "@/documents/knowledge-files";
import type { EnterpriseDocumentNetwork, EnterpriseDocumentRoot } from "@/documents/enterprise-document-network";
import { audience, object, reviewRecord, UUID, type KnowledgeAudience, type KnowledgeReviewRecord } from "./review-contract";

export type ReviewResult = { available: boolean; connectionId?: string; error?: string; records?: KnowledgeReviewRecord[]; record?: KnowledgeReviewRecord; nextCursor?: number | null };
const unavailable = (): ReviewResult => ({ available: false, error: "KNOWLEDGE_UNAVAILABLE" });
export class KnowledgeReviewTransport {
  constructor(private readonly network: EnterpriseDocumentNetwork, private readonly options: { ownerUid?: number; timeoutMs?: number } = {}) {}
  async call(roots: readonly EnterpriseDocumentRoot[], actorId: string, scope: KnowledgeAudience, operation: "list" | "review" | "correct", input: object, connectionId?: string): Promise<ReviewResult> {
    await this.network.validateSyncRoots(roots);
    if (!UUID.test(actorId) || !audience(scope) || !roots.some((r) => r.scope === scope.scope && r.scopeId === scope.scopeId)) throw new Error("REVIEW_SCOPE_DENIED");
    const directory = path.join(this.network.config.paths.dataRoot, "locks", "knowledge-review");
    try {
      const owner = this.options.ownerUid ?? 0;
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== owner || metadata.mode & 0o022 || await realpath(directory) !== path.resolve(directory)) return unavailable();
      const descriptors = (await readdir(directory)).filter((name) => /^[a-z0-9][a-z0-9-]{0,62}\.json$/.test(name)).sort();
      if (descriptors.length > 8) return unavailable();
      for (const name of descriptors) {
        const connection = name.slice(0, -5);
        if (connectionId && connection !== connectionId) continue;
        const info = await lstat(path.join(directory, name));
        if (info.uid !== owner || info.mode & 0o022) return unavailable();
        const descriptor: unknown = JSON.parse((await readRegularFileWithin(directory, name, 8192)).toString("utf8"));
        if (!object(descriptor) || descriptor.schemaVersion !== 1 || descriptor.mode !== "human-review" || descriptor.installationId !== this.network.config.installationId ||
          descriptor.connectionId !== connection || !Array.isArray(descriptor.publications) || !descriptor.publications.every(audience)) return unavailable();
        if (!descriptor.publications.some((a) => a.scope === scope.scope && a.scopeId === scope.scopeId)) continue;
        const socketPath = path.join(directory, `${connection}.sock`), socket = await lstat(socketPath);
        if (!socket.isSocket() || socket.uid !== owner || socket.mode & 0o007) return unavailable();
        return await this.request(socketPath, connection, actorId, scope, operation, input);
      }
      return unavailable();
    } catch { return unavailable(); }
  }
  private request(socketPath: string, connectionId: string, actorId: string, scope: KnowledgeAudience, operation: string, input: object): Promise<ReviewResult> {
    return new Promise((resolve) => {
      const requestId = randomUUID(), socket = createConnection({ path: socketPath });
      let data = Buffer.alloc(0), finished = false;
      const finish = (value: ReviewResult) => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); resolve(value); };
      const timer = setTimeout(() => finish(unavailable()), this.options.timeoutMs ?? 10_000);
      socket.on("error", () => finish(unavailable()));
      socket.on("end", () => finish(unavailable()));
      socket.on("connect", () => socket.write(JSON.stringify({ schemaVersion: 1, installationId: this.network.config.installationId, connectionId, requestId, actorId, audience: scope, operation, input }) + "\n"));
      socket.on("data", (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (data.length > 256 * 1024) return finish(unavailable());
        const newline = data.indexOf(10); if (newline < 0) return;
        try {
          const value: unknown = JSON.parse(data.subarray(0, newline).toString("utf8"));
          if (!object(value) || value.requestId !== requestId || value.installationId !== this.network.config.installationId || value.connectionId !== connectionId ||
            !audience(value.audience) || value.audience.scope !== scope.scope || value.audience.scopeId !== scope.scopeId || typeof value.available !== "boolean") return finish(unavailable());
          if (!value.available) return finish({ available: false, error: typeof value.error === "string" ? value.error : "KNOWLEDGE_UNAVAILABLE" });
          if (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) || Math.abs(Date.now() - Date.parse(value.checkedAt)) > 300_000) return finish(unavailable());
          const records = operation === "list" ? value.records : [value.record];
          if (!Array.isArray(records) || records.length > 20 || !records.every(reviewRecord)) return finish(unavailable());
          for (const record of records) for (const citation of record.citations) validateReference(citation.path, connectionId, [scope]);
          if (operation === "list" && !(value.nextCursor === null || Number.isSafeInteger(value.nextCursor) && Number(value.nextCursor) >= 0)) return finish(unavailable());
          if (operation === "review" && records[0]?.id !== (input as { recordId: string }).recordId) return finish(unavailable());
          if (operation === "correct") {
            const correction = input as { recordId: string; revision: number; content: string; reason: string };
            if (records[0]?.id === correction.recordId || records[0]?.correction?.previousRecordId !== correction.recordId ||
              records[0]?.correction?.previousRevision !== correction.revision || records[0]?.status !== "confirmed" ||
              typeof correction.content !== "string" || typeof correction.reason !== "string" ||
              records[0]?.content !== correction.content.trim() || records[0]?.correction?.reason !== correction.reason.trim()) return finish(unavailable());
          }
          finish({ available: true, connectionId, ...(operation === "list" ? { records, nextCursor: value.nextCursor as number | null } : { record: records[0] }) });
        } catch { finish(unavailable()); }
      });
    });
  }
}
