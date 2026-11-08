import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { readRegularFileWithin } from "@/security/safe-file";
import type { EnterpriseDocumentNetwork, EnterpriseDocumentRoot } from "./enterprise-document-network";

type Audience = { scope: string; scopeId: string | null };
type Result = { available: boolean; results?: unknown[]; [key: string]: unknown };
export type KnowledgeCalculation = {
  scope: string; scopeId?: string | null; path: string; tableIndex: number;
  selection: { cells: string[] } | { rows: number[]; column: number };
  operation: "sum" | "count" | "min" | "max" | "mean";
  locale: "canonical" | "es" | "en";
};
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function audience(value: unknown): value is Audience & Record<string, unknown> {
  return object(value) && ["company", "department", "project", "private"].includes(String(value.scope)) &&
    (value.scope === "company" ? value.scopeId === null : typeof value.scopeId === "string" && UUID.test(value.scopeId));
}
function same(a: Audience, b: Audience) { return a.scope === b.scope && a.scopeId === b.scopeId; }
function partition(a: Audience) {
  return createHash("sha256").update(a.scope === "company" ? "company" : `${a.scope}:${a.scopeId}`).digest("hex").slice(0, 32);
}
export function isKnowledgeFilePath(value: string) { return value.startsWith("knowledge-"); }
export function validateReference(value: string, connection: string, allowed: Audience[]) {
  if (value.length > 1024 || /\p{C}/u.test(value)) throw new Error("Invalid knowledge reference");
  const match = /^knowledge-([a-z0-9-]+)\/([a-f0-9]{32})\/([A-Z])\/(.+)\?sha256=([a-f0-9]{64})&part=([1-9][0-9]{0,3})(?:&table=([0-9]{1,4})&offset=([0-9]{1,7}))?$/.exec(value);
  if (!match || match[1] !== connection || !allowed.some((a) => partition(a) === match[2])) throw new Error("Foreign knowledge reference");
  for (const encoded of match[4].split("/")) {
    const part = decodeURIComponent(encoded);
    if (!part || part.startsWith(".") || /[\\/:*?<>|"\p{C}]/u.test(part) || /[. ]$/.test(part)) throw new Error("Invalid source segment");
  }
}
function unavailable(): Result {
  return { available: false, warning: "El índice no está disponible. Esto no demuestra que un documento no exista en el servidor." };
}

/** Only the app server opens the socket; no catalogue is mounted into a worker. */
export class KnowledgeDocumentFiles {
  constructor(private readonly network: EnterpriseDocumentNetwork,
    private readonly options: { ownerUid?: number; timeoutMs?: number; signal?: AbortSignal } = {}) {}

  async search(roots: readonly EnterpriseDocumentRoot[], query: string, limit = 20) {
    if (!query.trim() || query.length > 200 || /\p{C}/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid knowledge query");
    return this.call(roots, "search", { query, limit });
  }

  async read(roots: readonly EnterpriseDocumentRoot[], target: { scope: string; scopeId?: string | null; path: string }) {
    await this.network.validateSyncRoots(roots);
    const allowed = roots.filter((root) => root.scope === target.scope &&
      (target.scopeId === undefined ? target.scope !== "department" : root.scopeId === target.scopeId));
    if (!allowed.length) throw new Error("Knowledge scope denied");
    return this.call(allowed, "read", { path: target.path });
  }

  async calculate(roots: readonly EnterpriseDocumentRoot[], target: KnowledgeCalculation) {
    await this.network.validateSyncRoots(roots);
    const allowed = roots.filter((root) => root.scope === target.scope &&
      (target.scopeId === undefined ? target.scope !== "department" : root.scopeId === target.scopeId));
    if (!allowed.length) throw new Error("Knowledge scope denied");
    const { scope: _scope, scopeId: _scopeId, ...input } = target;
    return this.call(allowed, "calculate", input);
  }

  private async call(roots: readonly EnterpriseDocumentRoot[], operation: "search" | "read" | "calculate", input: { query: string; limit: number } | { path: string }): Promise<Result | null> {
    await this.network.validateSyncRoots(roots);
    if (!roots.length) return null;
    if (this.options.signal?.aborted) return unavailable();
    const directory = path.join(this.network.config.paths.dataRoot, "locks", "knowledge");
    try {
      const owner = this.options.ownerUid ?? 0;
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== owner || metadata.mode & 0o022 ||
          await realpath(directory) !== path.resolve(directory)) return unavailable();
      const entries = (await readdir(directory)).filter((entry) => /^[a-z0-9][a-z0-9-]{0,62}\.json$/.test(entry)).sort();
      if (entries.length > 8) return unavailable();
      for (const entry of entries) {
        const connection = entry.slice(0, -5);
        if ("path" in input && !input.path.startsWith(`knowledge-${connection}/`)) continue;
        const file = await lstat(path.join(directory, entry));
        if (file.uid !== owner || file.mode & 0o022) return unavailable();
        const descriptor: unknown = JSON.parse((await readRegularFileWithin(directory, entry, 8192)).toString("utf8"));
        if (!object(descriptor) || descriptor.schemaVersion !== 1 || descriptor.installationId !== this.network.config.installationId ||
            descriptor.connectionId !== connection || !ID.test(connection) || descriptor.mode !== "read-only" ||
            !Array.isArray(descriptor.publications) || descriptor.publications.length > 32 || !descriptor.publications.every(audience)) return unavailable();
        const audiences = descriptor.publications.filter((a) => roots.some((root) => same(a, root)) &&
          (!("path" in input) || input.path.startsWith(`knowledge-${connection}/${partition(a)}/`)));
        if (!audiences.length) continue;
        if ("path" in input) validateReference(input.path, connection, audiences);
        const socketPath = path.join(directory, `${connection}.sock`);
        const socket = await lstat(socketPath);
        if (!socket.isSocket() || socket.uid !== owner || socket.mode & 0o007) return unavailable();
        return this.request(socketPath, connection, audiences, operation, input);
      }
      return null;
    } catch (error) {
      return object(error) && error.code === "ENOENT" ? null : unavailable();
    }
  }

  private request(socketPath: string, connectionId: string, audiences: Audience[], operation: string, input: object): Promise<Result> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const socket = createConnection({ path: socketPath });
      let received = Buffer.alloc(0), finished = false;
      const finish = (result: Result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", abort);
        socket.destroy();
        resolve(result);
      };
      const abort = () => finish(unavailable());
      const timer = setTimeout(abort, this.options.timeoutMs ?? 10_000);
      this.options.signal?.addEventListener("abort", abort, { once: true });
      socket.on("error", abort);
      socket.on("end", () => { if (!finished) abort(); });
      socket.on("connect", () => {
        if (this.options.signal?.aborted) return abort();
        socket.write(JSON.stringify({ schemaVersion: 1, installationId: this.network.config.installationId,
          connectionId, requestId, operation, audiences, input }) + "\n");
      });
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 256 * 1024) return abort();
        const newline = received.indexOf(10);
        if (newline < 0) return;
        try {
          const value: unknown = JSON.parse(received.subarray(0, newline).toString("utf8"));
          if (!object(value) || value.requestId !== requestId || value.connectionId !== connectionId ||
              value.installationId !== this.network.config.installationId || typeof value.available !== "boolean") return abort();
          if (value.available) {
            if (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) || Math.abs(Date.now() - Date.parse(value.checkedAt)) > 300_000) return abort();
            const items = operation === "search" ? value.results : [value];
            if (!Array.isArray(items) || items.length > 50) return abort();
            for (const item of items) {
              if (!object(item) || !audience(item) || !audiences.some((a) => same(a, item))) return abort();
              const itemPath = (item as Record<string, unknown>).path;
              if (typeof itemPath !== "string") return abort();
              validateReference(itemPath, connectionId, [item]);
            }
            if (value.knowledgeRecords !== undefined) {
              if (operation !== "search" || !Array.isArray(value.knowledgeRecords) || value.knowledgeRecords.length > 10) return abort();
              for (const record of value.knowledgeRecords) {
                if (!object(record) || !audience(record) || !audiences.some((a) => same(a, record)) ||
                  !["proposed", "confirmed"].includes(String(record.status)) || !Array.isArray(record.citations) ||
                  record.citations.length < 1 || record.citations.length > 20) return abort();
                for (const citation of record.citations) {
                  if (!object(citation) || typeof citation.path !== "string") return abort();
                  validateReference(citation.path, connectionId, [record]);
                }
              }
            }
            if (operation === "read" && (value.path !== (input as { path: string }).path || typeof value.content !== "string" || Buffer.byteLength(value.content) > 120 * 1024)) return abort();
            if (operation === "calculate" && (value.path !== (input as { path: string }).path || typeof value.result !== "string" ||
              !/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(value.result) || value.operation !== (input as { operation?: string }).operation)) return abort();
          }
          const { requestId: _request, connectionId: _connection, installationId: _installation, ...result } = value;
          finish(result as Result);
        } catch { abort(); }
      });
      if (this.options.signal?.aborted) abort();
    });
  }
}
