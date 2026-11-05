import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { readRegularFileWithin } from "@/security/safe-file";
import type { EnterpriseDocumentNetwork, EnterpriseDocumentRoot } from "./enterprise-document-network";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = ["current", "failed", "pending", "unavailable"] as const;
export type DocumentSyncResult = Readonly<{
  connection: string;
  state: typeof STATES[number];
  checkedAt: string | null;
  documents?: number;
  unreadable?: number;
  warning?: string;
}>;
type Binding = { schemaVersion: 1; installationId: string; connectionId: string;
  publications: Array<{ scope: string; scopeId: string | null }> };

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function binding(value: unknown, installationId: string): value is Binding {
  return object(value) && value.schemaVersion === 1 && value.installationId === installationId &&
    typeof value.connectionId === "string" && ID.test(value.connectionId) && Array.isArray(value.publications) &&
    value.publications.length > 0 && value.publications.length <= 32 && value.publications.every((item) =>
      object(item) && ["company", "department", "project", "private"].includes(String(item.scope)) &&
      (item.scope === "company" ? item.scopeId === null : typeof item.scopeId === "string" && UUID.test(item.scopeId)));
}

function unavailable(connection: string): DocumentSyncResult {
  return { connection, state: "unavailable", checkedAt: null,
    warning: "No se ha podido comprobar la fuente. La copia disponible puede estar desactualizada." };
}

/** Server-only bridge. No Windows path, credential or executable is accepted from a tool call. */
export class OnDemandDocumentSync {
  private readonly attempts = new Map<string, { promise: Promise<DocumentSyncResult>; finishedAt: number | null }>();

  constructor(private readonly network: EnterpriseDocumentNetwork,
    private readonly options: { ownerUid?: number; timeoutMs?: number; signal?: AbortSignal } = {}) {}

  async refresh(roots: readonly EnterpriseDocumentRoot[], target?: { scope: string; scopeId?: string | null; path: string }) {
    // Validate the server-issued objects before reading descriptors or contacting the host.
    await this.network.validateSyncRoots(roots);
    const allowed = target ? roots.filter((root) => root.scope === target.scope &&
      (target.scope !== "department" || root.scopeId === target.scopeId)) : roots;
    if (!allowed.length) return [];
    const directory = path.join(this.network.config.paths.dataRoot, "locks", "document-sync");
    let entries: string[];
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== (this.options.ownerUid ?? 0) || (info.mode & 0o022) ||
          await realpath(directory) !== path.resolve(directory)) throw new Error("Unsafe sync directory");
      entries = (await readdir(directory)).filter((entry) => /^[a-z0-9][a-z0-9-]{0,62}\.json$/.test(entry));
      if (entries.length > 8) throw new Error("Too many sync connections");
    } catch (error) {
      if (object(error) && error.code === "ENOENT") return [];
      return [unavailable("documents")];
    }
    const results: Promise<DocumentSyncResult>[] = [];
    for (const entry of entries) {
      const id = entry.slice(0, -5);
      if (target && !target.path.startsWith(`windows-${id}/`)) continue;
      try {
        const metadata = await lstat(path.join(directory, entry));
        if (metadata.uid !== (this.options.ownerUid ?? 0) || (metadata.mode & 0o022)) throw new Error("Unsafe descriptor");
        const value: unknown = JSON.parse((await readRegularFileWithin(directory, entry, 8192)).toString("utf8"));
        if (!binding(value, this.network.config.installationId) || value.connectionId !== id) throw new Error("Wrong binding");
        if (!value.publications.some((publication) => allowed.some((root) => root.scope === publication.scope && root.scopeId === publication.scopeId))) continue;
        const socket = path.join(directory, `${id}.sock`);
        const info = await lstat(socket);
        if (!info.isSocket() || info.uid !== (this.options.ownerUid ?? 0) || (info.mode & 0o007)) throw new Error("Unsafe broker socket");
        let attempt = this.attempts.get(id);
        if (!attempt || (attempt.finishedAt !== null && Date.now() - attempt.finishedAt >= 30_000)) {
          const entry = { promise: this.request(socket, id), finishedAt: null as number | null };
          entry.promise = entry.promise.finally(() => { entry.finishedAt = Date.now(); });
          attempt = entry;
          this.attempts.set(id, attempt);
        }
        results.push(attempt.promise);
      } catch {
        results.push(Promise.resolve(unavailable(id)));
      }
    }
    return Promise.all(results);
  }

  private request(socketPath: string, connection: string): Promise<DocumentSyncResult> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const socket = createConnection({ path: socketPath });
      let received = Buffer.alloc(0);
      let finished = false;
      const finish = (result: DocumentSyncResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", abort);
        socket.destroy();
        resolve(result);
      };
      const abort = () => finish(unavailable(connection));
      const timer = setTimeout(() => finish({ connection, state: "pending", checkedAt: null,
        warning: "La actualización sigue pendiente. No presentes la copia anterior como actualizada." }), this.options.timeoutMs ?? 185_000);
      this.options.signal?.addEventListener("abort", abort, { once: true });
      if (this.options.signal?.aborted) abort();
      socket.on("error", abort);
      socket.on("end", () => { if (!finished) abort(); });
      socket.on("connect", () => socket.write(JSON.stringify({ schemaVersion: 1, operation: "refresh", requestId,
        installationId: this.network.config.installationId, connectionId: connection }) + "\n"));
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 8192) return abort();
        const newline = received.indexOf(10);
        if (newline < 0) return;
        try {
          const value: unknown = JSON.parse(received.subarray(0, newline).toString("utf8"));
          if (!object(value) || value.requestId !== requestId || value.installationId !== this.network.config.installationId ||
              value.connectionId !== connection || !STATES.includes(value.state as typeof STATES[number]) ||
              !(value.checkedAt === null || typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt)))) return abort();
          if (value.state === "current" && (typeof value.checkedAt !== "string" || Date.parse(value.checkedAt) > Date.now() + 5000 ||
              Date.now() - Date.parse(value.checkedAt) > 60_000)) return abort();
          const counts = [value.documents, value.unreadable];
          if (counts.some((count) => count !== undefined && (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 10_000))) return abort();
          finish({ connection, state: value.state as DocumentSyncResult["state"], checkedAt: value.checkedAt as string | null,
            ...(typeof value.documents === "number" ? { documents: value.documents } : {}),
            ...(typeof value.unreadable === "number" ? { unreadable: value.unreadable } : {}),
            ...(value.state !== "current" ? { warning: "No se ha confirmado la actualización. Puedes leer la copia disponible indicando que puede estar desactualizada." } : {}) });
        } catch { abort(); }
      });
    });
  }
}
