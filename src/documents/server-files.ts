import { legacyWordText } from "./legacy-word-text";
import { readG03PagedSpreadsheet } from "./g03-paged-spreadsheet";
import { FileDocumentConversionGate } from "./conversion-gate";
import { serverUserRoots, serverPathAllowed } from "./server-user-access";
import { randomUUID, createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { readRegularFileWithin } from "@/security/safe-file";
import type { EnterpriseDocumentNetwork, EnterpriseDocumentRoot } from "./enterprise-document-network";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
type ServerResult = { available: boolean; results?: unknown[]; [key: string]: unknown };
type NameWork = { query: string; depth: number };
type NameCursor = {
  installation: string; userId: string; roots: string; userRoots: string;
  needle: string; queryText: string; queue: NameWork[]; visited: string[];
  found: string[]; buffered: unknown[]; incomplete: boolean; priorPagesExcluded: boolean;
  checkedAt: string | null; expires: number; busy?: boolean; replay?: ServerResult;
};
// Cursors hold traversal state server-side: an unguessable reference is never an
// access grant. They are deliberately bounded and short-lived, and revalidated
// against the caller and their current roots on every continuation.
const nameCursors = new Map<string, NameCursor>();
const NAME_CURSOR_TTL_MS = 10 * 60_000;
const MAX_NAME_CURSORS = 16;
const MAX_NAME_VISITED = 2_000;
const MAX_NAME_QUEUE = 1_024;
// Keep one in-flight Windows operation; group a few more sequential pages per
// model call without raising the connector's per-operation timeout or limits.
const NAME_SEARCH_MAX_PAGES = 40;
const NAME_SEARCH_MAX_MS = 25_000;
function saveNameCursor(state: NameCursor): string | null {
  const now = Date.now();
  for (const [key, value] of nameCursors) if (value.expires <= now) nameCursors.delete(key);
  // Consumed cursors are kept briefly for safe retries, but never starve a
  // running traversal when the bounded cache fills.
  if (nameCursors.size >= MAX_NAME_CURSORS) {
    const oldReplay = [...nameCursors].find(([, value]) => value.replay && !value.busy);
    if (oldReplay) nameCursors.delete(oldReplay[0]);
  }
  if (nameCursors.size >= MAX_NAME_CURSORS) return null;
  const id = randomUUID();
  nameCursors.set(id, { ...state, expires: now + NAME_CURSOR_TTL_MS, busy: false, replay: undefined });
  setTimeout(() => nameCursors.delete(id), NAME_CURSOR_TTL_MS).unref();
  return `name-cursor:${id}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function unavailable(): ServerResult {
  return { available: false, warning: "No se ha podido consultar el servidor. No interpretes esta falta de acceso como que el archivo o carpeta no exista." };
}
export function isServerFilePath(value: string) {
  return /^server-[a-z0-9][a-z0-9-]{0,62}\//.test(value);
}
export function isServerDirectoryQuery(value: string) {
  return value.startsWith("server:/") || /^[A-Za-z]:[\\/]/.test(value);
}
function validatePath(value: string) {
  if (value.length > 1024 || /\p{C}/u.test(value) || value.includes("\\")) throw new Error("Invalid server path");
  const [raw, query, extra] = value.split("?");
  if (extra !== undefined || (query !== undefined && !/^part=[1-9][0-9]{0,2}(?:&sha256=[a-f0-9]{64})?$/.test(query))) throw new Error("Invalid server part");
  const segments = raw.replace(/\/$/, "").split("/");
  if (!/^server-[a-z0-9][a-z0-9-]{0,62}$/.test(segments[0]) || !/^[A-Za-z]$/.test(segments[1])) throw new Error("Invalid server drive");
  for (const raw of segments.slice(2)) {
    const segment = decodeURIComponent(raw);
    if (!segment || segment.startsWith(".") || /[\\/:*?<>|"\p{C}]/u.test(segment) || /[. ]$/.test(segment)) throw new Error("Invalid server segment");
  }
}

/** Compare and queue one canonical encoding without interpreting an encoded separator as a path. */
function canonicalDirectoryQuery(value: string): string {
  if (!value.startsWith("server:/")) throw new Error("Invalid directory query");
  const [location, offset, extra] = value.slice(8).split("?");
  if (!location || extra !== undefined || offset !== undefined && !/^offset=[0-9]{1,5}$/u.test(offset)) throw new Error("Invalid directory query");
  const directory = location.replace(/\/$/u, "");
  validatePath(`server-query/${directory}`);
  const encoded = directory.split("/").map(segment => encodeURIComponent(decodeURIComponent(segment).normalize("NFC"))).join("/");
  return `server:/${encoded}${offset === undefined ? "" : `?offset=${Number(offset.slice(7))}`}`;
}

/** Directory results are scoped to the page requested, not any other granted folder. */
function isDirectDirectoryChild(query: string, itemPath: string): boolean {
  try {
    validatePath(itemPath);
    const normalize = (value: string) => decodeURIComponent(value).normalize("NFC").toLocaleLowerCase();
    const requested = query.slice("server:/".length).split("?")[0].split("/").map(normalize);
    const parent = itemPath.split("/").slice(1, -1).map(normalize);
    return requested.length === parent.length && requested.every((part, index) => part === parent[index]);
  } catch { return false; }
}

/** A trusted app-side client; employees never receive its socket or credentials. */
export class ServerDocumentFiles {
  constructor(private readonly network: EnterpriseDocumentNetwork,
    private readonly options: { ownerUid?: number; timeoutMs?: number; signal?: AbortSignal; userId?: string; legacyWordReader?: typeof legacyWordText; spreadsheetReader?: typeof readG03PagedSpreadsheet } = {}) {}

  /** Navigation is trusted per-installation configuration, never a cached live listing. */
  async navigation(roots: readonly EnterpriseDocumentRoot[]): Promise<ServerResult | null> {
    await this.network.validateSyncRoots(roots);
    if (!roots.some(root => root.scope === "company" && root.scopeId === null)) return null;
    const directory = path.join(this.network.config.paths.dataRoot, "locks", "server-files");
    try {
      const owner = this.options.ownerUid ?? 0;
      const userRoots = await serverUserRoots(this.network.config.installationId,this.network.config.paths.dataRoot,this.options.userId,owner);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner || (info.mode & 0o022) || await realpath(directory) !== path.resolve(directory)) return unavailable();
      const entries = (await readdir(directory)).filter(name => /^[a-z0-9][a-z0-9-]{0,62}\.json$/.test(name)).sort();
      if (entries.length > 8) return unavailable();
      const results: Array<{ path: string; name: string; kind: "directory"; size: number; modifiedAt: null }> = [];
      for (const entry of entries) {
        const connection = entry.slice(0, -5);
        const metadata = await lstat(path.join(directory, entry));
        if (metadata.uid !== owner || (metadata.mode & 0o022)) return unavailable();
        const descriptor: unknown = JSON.parse((await readRegularFileWithin(directory, entry, 4096)).toString("utf8"));
        if (!record(descriptor) || descriptor.schemaVersion !== 1 || descriptor.connectionId !== connection ||
            descriptor.installationId !== this.network.config.installationId || descriptor.scope !== "company" || descriptor.mode !== "read-only") return unavailable();
        if (descriptor.entryPoints === undefined) continue;
        if (!Array.isArray(descriptor.entryPoints) || descriptor.entryPoints.length > 8) return unavailable();
        for (const item of descriptor.entryPoints) {
          if (!record(item) || typeof item.label !== "string" || !item.label.trim() || item.label.length > 60 || /\p{C}/u.test(item.label) ||
              typeof item.path !== "string" || item.path.length > 200 || item.path.includes("?") || !item.path.startsWith(`server-${connection}/`)) return unavailable();
          validatePath(item.path);
          if (serverPathAllowed(item.path,userRoots,true) && !results.some(result => result.path === item.path)) results.push({ path: item.path, name: item.label, kind: "directory", size: 0, modifiedAt: null });
        }
      }
      return { available: true, navigation: true, sourceChecked: false, results, checkedAt: null, nextQuery: null, limited: false };
    } catch (error) {
      return record(error) && error.code === "ENOENT" ? null : unavailable();
    }
  }

  async search(roots: readonly EnterpriseDocumentRoot[], query: string, limit = 50, fresh = false) {
    if (!query.trim() || query.length > 200 || /\p{C}/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid server query");
    if (this.network.config.installationId === "g03-production" && !isServerDirectoryQuery(query) && !fresh) {
      return this.searchNames(roots, query, limit);
    }
    const normalized = /^[A-Za-z]:[\\/]/.test(query)
      ? `server:/${query[0]}/${query.slice(3).replaceAll("\\", "/")}` : query;
    if (normalized.startsWith("server:/")) {
      const [location, offset, extra] = normalized.slice(8).split("?");
      if (extra !== undefined || (offset !== undefined && !/^offset=[0-9]{1,6}$/.test(offset))) throw new Error("Invalid server query");
      if (location) validatePath(`server-query/${location}`);
      else if (offset !== undefined) throw new Error("Invalid server query");
    } else if (/[\\/]/.test(normalized)) throw new Error("Invalid server query");
    if (fresh && !normalized.startsWith("server:/")) throw new Error("Live browsing requires a directory");
    return this.call(roots, fresh ? "browse" : "search", { query, limit });
  }

  /** G03's outbound reader browses directories; name search stays bounded in the app. */
  private async searchNames(roots: readonly EnterpriseDocumentRoot[], query: string, limit: number): Promise<ServerResult | null> {
    const navigation = await this.navigation(roots);
    if (!navigation?.available) return navigation;
    const owner = this.options.ownerUid ?? 0;
    const userRoots = await serverUserRoots(this.network.config.installationId, this.network.config.paths.dataRoot, this.options.userId, owner);
    const binding = JSON.stringify(roots), rootsBinding = JSON.stringify(userRoots);
    const cursorMatch = /^name-cursor:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(query);
    let prior: NameCursor | undefined;
    let state: NameCursor;
    if (query.startsWith("name-cursor:")) {
      prior = cursorMatch ? nameCursors.get(cursorMatch[1]) : undefined;
      if (!prior || !this.options.userId || prior.expires <= Date.now() || prior.installation !== this.network.config.installationId ||
          prior.userId !== this.options.userId || prior.roots !== binding || prior.userRoots !== rootsBinding) {
        return { available: false, limited: true, error: "SEARCH_CURSOR_EXPIRED_OR_DENIED", warning: "La continuación ha caducado o ya no está autorizada. Inicia una búsqueda nueva; no presupongas que la anterior terminó." };
      }
      if (prior.busy) return { available: false, limited: true, error: "SEARCH_CURSOR_BUSY", warning: "La continuación ya está en curso; vuelve a consultar el mismo cursor cuando termine." };
      if (prior.replay) return prior.replay;
      prior.busy = true;
      state = { ...prior, queue: prior.queue.map(item => ({ ...item })), visited: [...prior.visited], found: [...prior.found], buffered: [...prior.buffered] };
    } else {
      const match = /^(?:name:)?(.+?)(?:\s+in:(server:\/.+))?$/u.exec(query);
      if (!match || /[\\/]/u.test(match[1])) throw new Error("Invalid server name query");
      const needle = match[1].trim().normalize("NFC").toLocaleLowerCase();
      if (!needle) throw new Error("Invalid server name query");
      const entries = (navigation.results ?? []).filter(record).filter(item => typeof item.path === "string");
      let seeds = userRoots ?? entries.map(item => String(item.path));
      if (match[2]) {
        const location = canonicalDirectoryQuery(match[2]).slice(8);
        seeds = seeds.map(root => `server-${root.split("/")[0].slice(7)}/${location}`).filter(root => serverPathAllowed(root, userRoots));
      }
      seeds = [...new Set(seeds)].filter(root => entries.some(entry => String(entry.path).split("/")[0] === root.split("/")[0]));
      state = { installation: this.network.config.installationId, userId: this.options.userId ?? "", roots: binding, userRoots: rootsBinding,
        needle, queryText: match[1].trim(), queue: seeds.map(root => ({ query: canonicalDirectoryQuery(`server:/${root.split("/").slice(1).join("/")}`), depth: 0 })),
        visited: [], found: [], buffered: [], incomplete: false, priorPagesExcluded: Boolean(match[2]?.includes("?offset=")), checkedAt: null, expires: Date.now() + NAME_CURSOR_TTL_MS };
    }
    try {
      const queue = state.queue, visited = new Set(state.visited), found = new Set(state.found);
      const results = state.buffered.splice(0, limit), coverage: string[] = [];
      const signal = this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(NAME_SEARCH_MAX_MS)]) : AbortSignal.timeout(NAME_SEARCH_MAX_MS);
      const bounded = new ServerDocumentFiles(this.network, { ...this.options, signal, timeoutMs: Math.min(this.options.timeoutMs ?? 8_000, 8_000) });
      let pages = 0, traversalCapReached = false;
      while (queue.length && pages < NAME_SEARCH_MAX_PAGES && results.length < limit && !signal.aborted) {
        if (visited.size >= MAX_NAME_VISITED) { state.incomplete = true; traversalCapReached = true; break; }
        const current = queue.shift()!;
        if (visited.has(current.query)) continue;
        visited.add(current.query); pages++;
        const page = await bounded.call(roots, "browse", { query: current.query, limit: 50 });
        if (!page?.available || page.sourceChecked !== true) {
          // Deadline failures may be retried. Permanent rejections are recorded
          // as incomplete while allowing other authorized branches to progress.
          if (!page?.error) { visited.delete(current.query); queue.unshift(current); break; }
          state.incomplete = true;
          continue;
        }
        state.checkedAt = new Date().toISOString();
        coverage.push(current.query);
        for (const item of page.results ?? []) {
          if (!record(item) || typeof item.path !== "string" || !serverPathAllowed(item.path, userRoots)) continue;
          if (!isDirectDirectoryChild(current.query, item.path)) { state.incomplete = true; continue; }
          const name = decodeURIComponent(item.path.split("/").at(-1) ?? "").normalize("NFC").toLocaleLowerCase();
          if (name.includes(state.needle) && !found.has(item.path)) {
            if (found.size >= MAX_NAME_VISITED) { state.incomplete = true; traversalCapReached = true; }
            else { found.add(item.path); if (results.length < limit) results.push(item); else state.buffered.push(item); }
          }
          if (item.kind === "directory") {
            if (queue.length >= MAX_NAME_QUEUE) { state.incomplete = true; continue; }
            // The connector already rejects reparse points and validates every
            // direct child. A fixed depth of eight silently skipped legitimate
            // nested folders; the validated path-length and traversal budgets
            // provide the boundary without imposing that arbitrary cutoff.
            try {
              queue.push({ query: canonicalDirectoryQuery(`server:/${item.path.split("/").slice(1).join("/")}`), depth: current.depth + 1 });
            } catch { state.incomplete = true; }
          }
        }
        if (page.limited === true || page.truncated === true) {
          try {
            if (typeof page.nextQuery !== "string") throw new Error("Missing next page");
            const next = canonicalDirectoryQuery(page.nextQuery);
            const [base, offset] = current.query.split("?"), [nextBase, nextOffset] = next.split("?");
            const expectedOffset = Number(offset?.slice(7) ?? 0) + 50;
            if (nextBase !== base || nextOffset !== `offset=${expectedOffset}` || expectedOffset >= 50_000) throw new Error("Invalid next page");
            queue.unshift({ query: next, depth: current.depth });
          } catch { state.incomplete = true; }
        }
        if (traversalCapReached) break;
      }
      // A scope revoked during or between pages suppresses all prior names.
      const latest = await serverUserRoots(this.network.config.installationId, this.network.config.paths.dataRoot, this.options.userId, owner);
      if (JSON.stringify(latest) !== rootsBinding) return unavailable();
      const visible = results.filter(item => record(item) && typeof item.path === "string" && serverPathAllowed(item.path, latest));
      state.visited = [...visited]; state.found = [...found];
      const pending = queue.length > 0 || state.buffered.length > 0;
      const remainingInScopeComplete = !state.incomplete && !pending && !signal.aborted;
      const limited = !remainingInScopeComplete || state.priorPagesExcluded;
      const continuation = pending && !traversalCapReached && this.options.userId ? saveNameCursor(state) : null;
      const result: ServerResult = { available: Boolean(state.checkedAt), sourceChecked: Boolean(state.checkedAt), lookupMode: "bounded-live-name-search", checkedAt: state.checkedAt,
        results: visible, limited, nextQuery: continuation, coverage: { pages, directories: coverage, complete: !limited,
          priorPagesExcluded: state.priorPagesExcluded, remainingInScopeComplete, pendingCount: queue.length, pendingQueries: queue.slice(0, 10).map(item => item.query),
          bufferedMatches: state.buffered.length, totalMatchesObserved: found.size, resultsIncludePriorPages: false, snapshot: false,
          maxPages: NAME_SEARCH_MAX_PAGES, maxDepth: null, maxMilliseconds: NAME_SEARCH_MAX_MS },
        warning: (limited ? (continuation ? "Búsqueda parcial por nombre. Sigue nextQuery para continuar el mismo recorrido completo; conserva los resultados de cada página. El cursor es privado y caduca en 10 minutos." : "Búsqueda parcial sin continuación disponible. Acota la carpeta o inicia una búsqueda nueva; no demuestra que el archivo no exista.") : "Búsqueda por nombre completada en las carpetas autorizadas indicadas; reúne las páginas anteriores.") + " No es una captura instantánea: los cambios durante el recorrido pueden afectar los resultados. No incluye contenido de archivos ni unidades no conectadas." };
      if (prior) prior.replay = result;
      return result;
    } finally { if (prior) prior.busy = false; }
  }

  async read(roots: readonly EnterpriseDocumentRoot[], target: { scope: string; path: string }) {
    if (target.scope !== "company") throw new Error("Server file scope denied");
    validatePath(target.path);
    const [base, query] = target.path.split("?");
    const suffix = path.posix.extname(base).toLowerCase();
    if (this.network.config.installationId === "g03-production" && [".xlsx", ".xltx", ".xlsm"].includes(suffix)) {
      const match = query && /^part=([1-9][0-9]{0,2})(?:&sha256=([a-f0-9]{64}))?$/.exec(query);
      const part = match ? Number(match[1]) : 1;
      const original = await this.readOriginal(roots, { ...target, path: base });
      if (!original?.available || typeof original.base64 !== "string" || typeof original.sha256 !== "string") return original;
      if (match?.[2] && match[2] !== original.sha256) return { available: false, error: "SERVER_SOURCE_CHANGED", warning: "El documento ha cambiado; comienza de nuevo desde la primera parte." };
      try {
        const extracted = await (this.options.spreadsheetReader ?? readG03PagedSpreadsheet)(Buffer.from(original.base64, "base64"), suffix, part, {
          conversionGate: new FileDocumentConversionGate({ rootDirectory: path.join(this.network.config.paths.dataRoot, "locks", "document-conversions") }),
          signal: this.options.signal,
        });
        await this.network.validateSyncRoots(roots);
        const latestRoots = await serverUserRoots(this.network.config.installationId, this.network.config.paths.dataRoot, this.options.userId, this.options.ownerUid ?? 0);
        if (!serverPathAllowed(base, latestRoots)) return unavailable();
        const { base64: _bytes, ...metadata } = original;
        return { ...metadata, path: target.path, content: extracted.content, part, parts: extracted.parts,
          nextPath: part < extracted.parts ? `${base}?part=${part + 1}&sha256=${original.sha256}` : null,
          truncated: part < extracted.parts,
          coverage: { documentCompleteInResponse: extracted.parts === 1, versionBound: part === 1 || Boolean(match?.[2]) },
          warning: extracted.parts > 1 ? "La lectura es completa solo tras consultar todas las partes de la misma versión." : undefined,
          ...(part === 1 && extracted.preview ? { preview: extracted.preview } : {}) };
      } catch (error) {
        const code = error instanceof Error && ["SERVER_PART_UNAVAILABLE", "SERVER_TEXT_TOO_LARGE"].includes(error.message) ? error.message : "SERVER_SPREADSHEET_UNAVAILABLE";
        return { available: false, error: code, warning: "No se ha podido completar la lectura de la hoja de cálculo; no significa que falte o que no tengas acceso." };
      }
    }
    if (/\.doc(?:\?part=[1-9][0-9]{0,2})?$/i.test(target.path)) {
      const original = await this.readOriginal(roots, { ...target, path: base });
      if (!original?.available || typeof original.base64 !== "string") return original;
      try {
        const text = await (this.options.legacyWordReader ?? legacyWordText)(Buffer.from(original.base64, "base64"), {
          conversionGate: new FileDocumentConversionGate({ rootDirectory: path.join(this.network.config.paths.dataRoot, "locks", "document-conversions") }),
          signal: this.options.signal,
        });
        // Conversion may outlive revocation; repeat the original per-user gate.
        const latestRoots = await serverUserRoots(this.network.config.installationId, this.network.config.paths.dataRoot, this.options.userId, this.options.ownerUid ?? 0);
        if (!serverPathAllowed(base, latestRoots)) return unavailable();
        const characters = Array.from(text);
        const pages = Array.from({ length: Math.ceil(characters.length / 20000) }, (_, i) => characters.slice(i * 20000, (i + 1) * 20000).join(""));
        const part = query ? Number(query.slice(5)) : 1;
        if (!pages[part - 1]) return { available: false, error: "SERVER_PART_UNAVAILABLE" };
        const { base64: _bytes, ...metadata } = original;
        return { ...metadata, path: target.path, content: pages[part - 1], part, parts: pages.length,
          nextPath: part < pages.length ? `${base}?part=${part + 1}` : null, truncated: part < pages.length };
      } catch { return { available: false, error: "SERVER_WORD_TEXT_UNAVAILABLE", warning: "No se ha podido extraer el texto del Word original; no significa falta de permiso ni ausencia de datos." }; }
    }
    return this.call(roots, "read", { path: target.path });
  }

  async readOriginal(roots: readonly EnterpriseDocumentRoot[], target: { scope: string; path: string }) {
    if (target.scope !== "company" || target.path.includes("?")) throw new Error("Server original scope denied");
    validatePath(target.path);
    return this.call(roots, "read", { path: target.path, format: "original" });
  }

  async inventory(roots: readonly EnterpriseDocumentRoot[], target: { scope: string; path: string; offset?: number }) {
    if (target.scope !== "company" || target.path.includes("?")) throw new Error("Server inventory scope denied");
    validatePath(target.path);
    const offset = target.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 500_000) throw new Error("Invalid inventory offset");
    const result = await this.call(roots, "inventory", { path: target.path, offset });
    if (this.network.config.installationId === "g03-production" && result?.error === "SERVER_REQUEST_DENIED") {
      return { ...result, warning: "No se ha podido ejecutar el inventario. El relay actual de G03 no implementa inventario recursivo; esto no demuestra que falte acceso ni que la carpeta esté vacía. Usa búsqueda por nombre y continúa con nextQuery, indicando la cobertura." };
    }
    return result;
  }

  private async call(roots: readonly EnterpriseDocumentRoot[], operation: "search" | "browse" | "read" | "inventory", input: { query: string; limit: number } | { path: string; offset?: number; format?: "original" }): Promise<ServerResult | null> {
    await this.network.validateSyncRoots(roots);
    // Do not read even the host descriptor for a turn without company access.
    if (!roots.some((root) => root.scope === "company" && root.scopeId === null)) return null;
    if (this.options.signal?.aborted) return unavailable();
    const directory = path.join(this.network.config.paths.dataRoot, "locks", "server-files");
    try {
      const owner = this.options.ownerUid ?? 0;
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner || (info.mode & 0o022) || await realpath(directory) !== path.resolve(directory)) return unavailable();
      const entries = (await readdir(directory)).filter((name) => /^[a-z0-9][a-z0-9-]{0,62}\.json$/.test(name)).sort();
      if (entries.length > 8) return unavailable();
      for (const entry of entries) {
        const connection = entry.slice(0, -5);
        if ("path" in input && !input.path.startsWith(`server-${connection}/`)) continue;
        const metadata = await lstat(path.join(directory, entry));
        if (metadata.uid !== owner || (metadata.mode & 0o022)) return unavailable();
        const descriptor: unknown = JSON.parse((await readRegularFileWithin(directory, entry, 4096)).toString("utf8"));
        if (!record(descriptor) || descriptor.schemaVersion !== 1 || descriptor.connectionId !== connection ||
          !ID.test(connection) || descriptor.installationId !== this.network.config.installationId ||
          descriptor.scope !== "company" || descriptor.mode !== "read-only") return unavailable();
        const socketPath = path.join(directory, `${connection}.sock`);
        const socket = await lstat(socketPath);
        if (!socket.isSocket() || socket.uid !== owner || (socket.mode & 0o007)) return unavailable();
        const userRoots = await serverUserRoots(this.network.config.installationId,this.network.config.paths.dataRoot,this.options.userId,owner);
        if (userRoots?.length === 0) return unavailable();
        if ("path" in input && !serverPathAllowed(input.path,userRoots)) return unavailable();
        if ("query" in input && (input.query.startsWith("server:/") || /^[A-Za-z]:[\\/]/.test(input.query))) {
          const location=input.query.startsWith("server:/") ? input.query.slice(8) : input.query[0]+"/"+input.query.slice(3).replaceAll("\\","/");
          if (location && !serverPathAllowed(`server-${connection}/${location}`,userRoots,true)) return unavailable();
        }
        const result=await this.request(socketPath, connection, operation, input);
        // Re-read revocable grants after the potentially slow Windows operation.
        const latestRoots=await serverUserRoots(this.network.config.installationId,this.network.config.paths.dataRoot,this.options.userId,owner);
        if (latestRoots?.length === 0 || "path" in input && !serverPathAllowed(input.path,latestRoots)) return unavailable();
        if(Array.isArray(result.results)) result.results=result.results.filter(entry=>record(entry) && typeof entry.path==='string' && serverPathAllowed(entry.path,latestRoots,entry.kind==='directory'));
        return result;
      }
      return null;
    } catch (error) {
      return record(error) && error.code === "ENOENT" ? null : unavailable();
    }
  }

  private request(socketPath: string, connectionId: string, operation: string, input: object): Promise<ServerResult> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const socket = createConnection({ path: socketPath });
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      const original = operation === "read" && "format" in input && input.format === "original";
      let finished = false;
      const finish = (result: ServerResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", abort);
        socket.destroy();
        resolve(result);
      };
      const abort = () => finish(unavailable());
      const timer = setTimeout(abort, this.options.timeoutMs ?? 220_000);
      socket.on("error", abort);
      socket.on("end", () => { if (!finished) abort(); });
      socket.on("connect", () => {
        if (this.options.signal?.aborted) return abort();
        socket.write(JSON.stringify({ schemaVersion: 1, operation, requestId, installationId: this.network.config.installationId, connectionId, input }) + "\n");
      });
      this.options.signal?.addEventListener("abort", abort, { once: true });
      if (this.options.signal?.aborted) abort();
      socket.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > (original ? 23 * 1024 * 1024 : 256 * 1024)) return abort();
        chunks.push(chunk);
        if (!chunk.includes(10)) return;
        const received = Buffer.concat(chunks);
        const end = received.indexOf(10);
        try {
          const value: unknown = JSON.parse(received.subarray(0, end).toString("utf8"));
          if (!record(value) || value.requestId !== requestId || value.connectionId !== connectionId || value.installationId !== this.network.config.installationId || typeof value.available !== "boolean") return abort();
          if (value.available) {
            if (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) || Math.abs(Date.now() - Date.parse(value.checkedAt)) > 5 * 60_000) return abort();
            if (operation === "browse" && value.sourceChecked !== true) return abort();
            if (operation === "search" || operation === "browse" || operation === "inventory") {
              if (!Array.isArray(value.results) || value.results.length > 50) return abort();
              for (const entry of value.results) {
                if (!record(entry) || entry.scope !== "company" || typeof entry.path !== "string" || !entry.path.startsWith(`server-${connectionId}/`)) return abort();
                validatePath(entry.path);
                if (operation === "inventory" && !entry.path.toLowerCase().startsWith((input as { path: string }).path.replace(/\/$/, "").toLowerCase() + "/")) return abort();
              }
              if (operation === "inventory") {
                const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 500_000;
                const counts = (v: unknown) => record(v) && Object.keys(v).length <= 50 && Object.entries(v).every(([k, n]) => k.length <= 1024 && count(n));
                if (value.scope !== "company" || value.path !== (input as { path: string }).path ||
                  value.countBasis !== "observed-files-in-folder-tree" || value.businessRecordCount !== null || value.snapshot !== false ||
                  value.sourceChecked !== false || typeof value.enumerationComplete !== "boolean" || !count(value.fileCount) ||
                  !counts(value.directories) || !counts(value.fileTypes) || !counts(value.folders) ||
                  !(value.nextOffset === null || count(value.nextOffset) && Number(value.nextOffset) === Number((input as { offset: number }).offset) + 50)) return abort();
              }
            } else {
              if (value.scope !== "company" || value.path !== (input as { path: string }).path) return abort();
              if (original) {
                if (value.sourceChecked !== true || typeof value.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64) ||
                    !Number.isSafeInteger(value.size) || Number(value.size) < 1 || Number(value.size) > 16 * 1024 * 1024 ||
                    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return abort();
                const bytes = Buffer.from(value.base64, "base64");
                if (bytes.length !== value.size || bytes.toString("base64") !== value.base64 || createHash("sha256").update(bytes).digest("hex") !== value.sha256) return abort();
              } else if (typeof value.content !== "string" || Buffer.byteLength(value.content) > 120 * 1024) return abort();
            }
          }
          const { requestId: _request, installationId: _installation, connectionId: _connection, ...result } = value;
          finish(result as ServerResult);
        } catch { abort(); }
      });
    });
  }
}
