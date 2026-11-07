import { legacyWordText } from "./legacy-word-text";
import { readG03PagedSpreadsheet } from "./g03-paged-spreadsheet";
import { FileDocumentConversionGate } from "./conversion-gate";
import { serverUserRoots, serverPathAllowed } from "./server-user-access";
import { randomUUID, createHash } from "node:crypto";
import { DurableNameCursors, CURSOR_MAX_BYTES } from "./server-name-cursors";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { readRegularFileWithin } from "@/security/safe-file";
import type { EnterpriseDocumentNetwork, EnterpriseDocumentRoot } from "./enterprise-document-network";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
type ServerResult = { available: boolean; results?: unknown[]; [key: string]: unknown };
type FilenameSearchInput = { roots: string[]; needle: string | null; cursor: string | null; binding: string; limit: number; budgetMs: number };
type ServerInput = { query: string; limit: number } | { path: string; offset?: number; format?: "original" } | FilenameSearchInput;
type NameWork = { query: string; depth: number };
type NameMatch = { item: unknown; origin: string };
type NameReplay = { version: 1; result: ServerResult; matches: NameMatch[] };
type NameCursor = {
  installation: string; userId: string; roots: string; userRoots: string;
  needle: string; queryText: string; queue: NameWork[]; visited: string[];
  found: string[]; buffered: NameMatch[]; incomplete: boolean; priorPagesExcluded: boolean;
  checkedAt: string | null; expires: number; busy?: boolean; replay?: ServerResult;
};
// One bounded request yields a resumable, private persistent cursor.
const NAME_CURSOR_TTL_MS = 10 * 60_000;
const NAME_SEARCH_MAX_PAGES = 40;
const NAME_SEARCH_MAX_MS = 25_000;
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
    private readonly options: { ownerUid?: number; timeoutMs?: number; signal?: AbortSignal; userId?: string; cursorMinimumFreeBytes?: number; legacyWordReader?: typeof legacyWordText; spreadsheetReader?: typeof readG03PagedSpreadsheet } = {}) {}

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
    if (!fresh && !isServerDirectoryQuery(query) && !query.startsWith("name-cursor:")) {
      const native = await this.searchSourceNames(roots, query, limit);
      if (native !== null) return native;
    }
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

  /** An optional source capability. A legacy descriptor causes no new RPC. */
  private async searchSourceNames(roots: readonly EnterpriseDocumentRoot[], query: string, limit: number): Promise<ServerResult | null> {
    if (this.options.signal?.aborted) return { available: false, error: "SEARCH_CANCELLED" };
    // A continuation must resume the backend that created it, even if a new
    // source capability became available after its first page.
    if (query.startsWith("name-cursor:")) return null;
    const continuation = /^filename-cursor:([a-z0-9][a-z0-9-]{0,62}):([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u.exec(query);
    if (query.startsWith("filename-cursor:") && !continuation) throw Error("Invalid filename cursor");
    if (!this.options.userId) return continuation ? { available: false, error: "SEARCH_CURSOR_EXPIRED_OR_DENIED" } : null;
    const navigation = await this.navigation(roots);
    if (!navigation?.available) return continuation ? navigation : null;
    const grants = await serverUserRoots(this.network.config.installationId, this.network.config.paths.dataRoot, this.options.userId, this.options.ownerUid ?? 0);
    let seeds = grants ?? (navigation.results ?? []).filter(record).map(item => String(item.path));
    const parsed = /^(?:name:)?(.+?)(?:\s+in:(server:\/.+))?$/u.exec(query);
    if (!continuation && (!parsed || /[\\/]/u.test(parsed[1]))) return null;
    if (!continuation && parsed && parsed[1].trim().length > 128) return null;
    if (!continuation && parsed?.[2]) {
      const location = canonicalDirectoryQuery(parsed[2]);
      // A browse offset belongs to the legacy paged reader. It cannot be
      // converted into a fresh source search without dropping prior coverage.
      if (location.includes("?")) return null;
      seeds = [...new Set(seeds.map(root => `${root.split("/")[0]}/${location.slice(8)}`))]
        .filter(root => serverPathAllowed(root, grants));
    }
    const connections = [...new Set(seeds.map(root => root.split("/")[0].slice(7)))];
    const connection = continuation?.[1] ?? (connections.length === 1 ? connections[0] : null);
    if (!connection) return null;
    seeds = seeds.filter(root => root.startsWith(`server-${connection}/`));
    if (!seeds.length || seeds.length > 16) return continuation ? { available: false, error: "SEARCH_CURSOR_EXPIRED_OR_DENIED" } : null;
    for (const seed of seeds) validatePath(seed);
    const input: FilenameSearchInput = {
      roots: seeds, needle: continuation ? null : parsed![1].trim().normalize("NFC"), cursor: continuation?.[2] ?? null,
      binding: createHash("sha256").update(JSON.stringify([this.network.config.installationId, this.options.userId, roots, grants])).digest("hex"),
      limit, budgetMs: 4000,
    };
    const result = await this.call(roots, "filename_search", input);
    if (result?.error === "FILENAME_SEARCH_UNSUPPORTED") return continuation ? { available: false, error: "SEARCH_CURSOR_EXPIRED_OR_DENIED", restartRequired: true, nextQuery: null } : null;
    if (!result) return continuation ? { available: false, error: "SEARCH_SOURCE_OFFLINE" } : null;
    const { nextCursor, ...visible } = result;
    if (["SEARCH_CURSOR_EXPIRED_OR_DENIED", "SEARCH_POLICY_CHANGED"].includes(String(visible.error))) return { ...visible, nextQuery: null, restartRequired: true,
      warning: "La continuación ya no corresponde al estado o los permisos actuales. Inicia una búsqueda nueva en las carpetas autorizadas; no se ha demostrado que el archivo no exista." };
    return { ...visible, nextQuery: typeof nextCursor === "string" ? `filename-cursor:${connection}:${nextCursor}` : !visible.available && continuation ? query : null };
  }

  /** G03's outbound reader browses directories; name search stays bounded in the app. */
  private async searchNames(roots: readonly EnterpriseDocumentRoot[], query: string, limit: number): Promise<ServerResult | null> {
    const navigation = await this.navigation(roots);
    if (!navigation?.available) return navigation;
    const owner = this.options.ownerUid ?? 0;
    const userRoots = await serverUserRoots(this.network.config.installationId, this.network.config.paths.dataRoot, this.options.userId, owner);
    const binding = JSON.stringify(roots), rootsBinding = JSON.stringify(userRoots);
    const cursorMatch = /^name-cursor:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(query);
    const cursorBinding = { installation: this.network.config.installationId, userId: this.options.userId ?? "", roots: binding, userRoots: rootsBinding };
    let store: DurableNameCursors;
    try { store = new DurableNameCursors(this.network.config.paths.dataRoot, Date.now, this.options.cursorMinimumFreeBytes); }
    catch { return { available: false, limited: true, error: "SEARCH_STORAGE_UNAVAILABLE", nextQuery: cursorMatch ? query : null, warning: "No se puede guardar una búsqueda recuperable; no se ha completado." }; }
    let prior: { id: string; lease: string } | null = null;
    let state: NameCursor;
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(NAME_SEARCH_MAX_MS)]) : AbortSignal.timeout(NAME_SEARCH_MAX_MS);
    const bounded = new ServerDocumentFiles(this.network, { ...this.options, signal, timeoutMs: Math.min(this.options.timeoutMs ?? 8_000, 8_000) });
    const sourceRecheckFailure = (): ServerResult => ({ available: false, limited: true, error: "SEARCH_SOURCE_RECHECK", nextQuery: cursorMatch ? query : null,
      warning: "No se han podido volver a comprobar los resultados guardados en Windows. Reintenta la continuación o inicia una búsqueda nueva; no se ha demostrado que hayan desaparecido." });
    const recheck = async (matches: NameMatch[]): Promise<NameMatch[] | null> => {
      const checked = new Map<string, ServerResult>();
      const refreshed: NameMatch[] = [];
      for (const match of matches) {
        if (signal.aborted || !record(match) || typeof match.origin !== "string" || !record(match.item) ||
            typeof match.item.path !== "string" || !serverPathAllowed(match.item.path, userRoots) ||
            !isDirectDirectoryChild(match.origin, match.item.path)) return null;
        const currentRoots = await serverUserRoots(this.network.config.installationId, this.network.config.paths.dataRoot, this.options.userId, owner);
        if (JSON.stringify(currentRoots) !== rootsBinding) return null;
        let page = checked.get(match.origin);
        if (!page) {
          page = await bounded.call(roots, "browse", { query: match.origin, limit: 50 }) ?? undefined;
          if (!page?.available || page.sourceChecked !== true || !Array.isArray(page.results)) return null;
          checked.set(match.origin, page);
        }
        const current = page.results?.find(item => record(item) && item.path === (match.item as Record<string, unknown>).path &&
          item.kind === (match.item as Record<string, unknown>).kind && typeof item.path === "string" &&
          serverPathAllowed(item.path, userRoots) && isDirectDirectoryChild(match.origin, item.path));
        if (!current) return null;
        refreshed.push({ item: current, origin: match.origin });
      }
      return refreshed;
    };
    try {
      if (query.startsWith("name-cursor:")) {
        const admission = cursorMatch && this.options.userId ? store.acquire<NameCursor, NameReplay>(cursorMatch[1], cursorBinding) : { kind: "denied" as const };
        if (admission.kind === "denied") { return { available: false, limited: true, error: "SEARCH_CURSOR_EXPIRED_OR_DENIED", warning: "La continuación ha caducado o ya no está autorizada. Inicia una búsqueda nueva; no presupongas que la anterior terminó." }; }
        if (admission.kind === "busy") { return { available: false, limited: true, error: "SEARCH_CURSOR_BUSY", warning: "La continuación ya está en curso; vuelve a consultar el mismo cursor cuando termine." }; }
        if (admission.kind === "replay") {
          const saved = admission.result;
          if (!record(saved) || saved.version !== 1 || !record(saved.result) || !Array.isArray(saved.matches)) return sourceRecheckFailure();
          const fresh = await recheck(saved.matches);
          await this.network.validateSyncRoots(roots);
          const latest = await serverUserRoots(this.network.config.installationId, this.network.config.paths.dataRoot, this.options.userId, owner);
          if (!fresh || JSON.stringify(latest) !== rootsBinding) return sourceRecheckFailure();
          return { ...saved.result, results: fresh.map(match => match.item), checkedAt: fresh.length ? new Date().toISOString() : saved.result.checkedAt };
        }
        prior = { id: cursorMatch![1], lease: admission.lease };
        state = admission.state;
      } else {
        const match = /^(?:name:)?(.+?)(?:\s+in:(server:\/.+))?$/u.exec(query);
        if (!match || /[\\/]/u.test(match[1])) { throw new Error("Invalid server name query"); }
        const needle = match[1].trim().normalize("NFC").toLocaleLowerCase();
        if (!needle) { throw new Error("Invalid server name query"); }
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
      const queue = state.queue, visited = new Set(state.visited), found = new Set(state.found);
      const cached = state.buffered.slice(0, limit);
      const refreshed = await recheck(cached);
      if (!refreshed) return sourceRecheckFailure();
      state.buffered.splice(0, cached.length);
      if (refreshed.length) state.checkedAt = new Date().toISOString();
      const results = refreshed, coverage: string[] = [];
      let pages = 0, quotaPaused = false;
      let sourceError: string | undefined;
      while (queue.length && pages < NAME_SEARCH_MAX_PAGES && results.length < limit && !signal.aborted) {
        // A page is committed into the next cursor as a unit. If it exceeds
        // quota, restore the pre-page state and preserve that page to retry.
        const checkpoint = { queue: queue.map(item => ({ ...item })), visited: [...visited], found: [...found],
          buffered: [...state.buffered], results: [...results], checkedAt: state.checkedAt, incomplete: state.incomplete };
        const current = queue.shift()!;
        if (visited.has(current.query)) continue;
        visited.add(current.query);
        const pageRoots = await serverUserRoots(this.network.config.installationId, this.network.config.paths.dataRoot, this.options.userId, owner);
        if (JSON.stringify(pageRoots) !== rootsBinding) return unavailable();
        const page = await bounded.call(roots, "browse", { query: current.query, limit: 50 });
        if (!page?.available || page.sourceChecked !== true) {
          // Never discard an unavailable branch. Move it behind other work so
          // an inaccessible path does not starve the rest; a later call can
          // retry it, and it prevents a false complete-coverage claim.
          sourceError = typeof page?.error === "string" && /^[A-Z_]{1,80}$/u.test(page.error) ? page.error : "SEARCH_SOURCE_OFFLINE";
          visited.delete(current.query); queue.push(current); break;
        }
        pages++;
        state.checkedAt = new Date().toISOString();
        coverage.push(current.query);
        for (const item of page.results ?? []) {
          if (!record(item) || typeof item.path !== "string" || !serverPathAllowed(item.path, userRoots)) continue;
          if (!isDirectDirectoryChild(current.query, item.path)) { state.incomplete = true; continue; }
          const name = decodeURIComponent(item.path.split("/").at(-1) ?? "").normalize("NFC").toLocaleLowerCase();
          if (name.includes(state.needle) && !found.has(item.path)) {
            found.add(item.path); const match = { item, origin: current.query }; if (results.length < limit) results.push(match); else state.buffered.push(match);
          }
          if (item.kind === "directory") {
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
        if (Buffer.byteLength(JSON.stringify({ ...state, visited: [...visited], found: [...found] })) > CURSOR_MAX_BYTES - 128 * 1024) {
          queue.splice(0, queue.length, ...checkpoint.queue);
          // Let other queued work drain before retrying a page that grows the
          // frontier; no branch or earlier results are discarded.
          if (queue.length > 1) queue.push(queue.shift()!);
          visited.clear(); checkpoint.visited.forEach(value => visited.add(value));
          found.clear(); checkpoint.found.forEach(value => found.add(value)); state.buffered = checkpoint.buffered;
          results.splice(0, results.length, ...checkpoint.results); state.checkedAt = checkpoint.checkedAt; state.incomplete = checkpoint.incomplete;
          coverage.pop(); pages--; quotaPaused = true; break;
        }
      }
      // A scope revoked during or between pages suppresses all prior names.
      await this.network.validateSyncRoots(roots);
      const latest = await serverUserRoots(this.network.config.installationId, this.network.config.paths.dataRoot, this.options.userId, owner);
      if (JSON.stringify(latest) !== rootsBinding) return unavailable();
      const visible = results.filter(match => record(match.item) && typeof match.item.path === "string" && serverPathAllowed(match.item.path, latest));
      state.visited = [...visited]; state.found = [...found];
      const pending = queue.length > 0 || state.buffered.length > 0;
      const remainingInScopeComplete = !state.incomplete && !pending && !signal.aborted;
      const limited = !remainingInScopeComplete || state.priorPagesExcluded;
      const persist = pending && this.options.userId ? state : null;
      return store.finish(cursorBinding, persist, prior, continuation => {
        const result: ServerResult = { available: Boolean(state.checkedAt), sourceChecked: Boolean(state.checkedAt), lookupMode: "bounded-live-name-search", checkedAt: state.checkedAt,
          results: visible.map(match => match.item), limited, nextQuery: continuation, coverage: { pages, directories: [], complete: !limited,
            priorPagesExcluded: state.priorPagesExcluded, remainingInScopeComplete, pendingCount: queue.length, pendingQueries: [],
            bufferedMatches: state.buffered.length, totalMatchesObserved: found.size, resultsIncludePriorPages: false, snapshot: false,
            maxPages: NAME_SEARCH_MAX_PAGES, maxDepth: null, maxMilliseconds: NAME_SEARCH_MAX_MS },
          ...(sourceError ? { error: sourceError } : {}), ...(quotaPaused ? { error: "SEARCH_QUOTA_PAUSED" } : {}),
          warning: (limited ? (continuation ? "Búsqueda parcial por nombre. Sigue nextQuery para continuar el mismo recorrido completo; conserva los resultados de cada página. El cursor es privado y caduca en 10 minutos." : "Búsqueda parcial sin continuación disponible. Acota la carpeta o inicia una búsqueda nueva; no demuestra que el archivo no exista.") : "Búsqueda por nombre completada en las carpetas autorizadas indicadas; reúne las páginas anteriores.") + " No es una captura instantánea: los cambios durante el recorrido pueden afectar los resultados. No incluye contenido de archivos ni unidades no conectadas." };
        return result;
      }, result => ({ version: 1, result, matches: visible }));
    } catch (error) {
      if (error instanceof Error && (error.message.includes("CURSOR_STORAGE_QUOTA") || error.message.includes("database or disk is full"))) {
        return { available: false, limited: true, error: "SEARCH_QUOTA_PAUSED", nextQuery: prior ? `name-cursor:${prior.id}` : null,
          warning: "No hay espacio para guardar el siguiente avance. La búsqueda sigue incompleta; reduce el ámbito o vuelve a intentarlo cuando haya espacio." };
      }
      throw error;
    } finally { try { if (prior) store.release(prior.id, prior.lease); } finally { store.close(); } }
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

  private async call(roots: readonly EnterpriseDocumentRoot[], operation: "search" | "browse" | "read" | "inventory" | "filename_search", input: ServerInput): Promise<ServerResult | null> {
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
        if ("binding" in input && !input.roots.every(root => root.startsWith(`server-${connection}/`))) continue;
        const metadata = await lstat(path.join(directory, entry));
        if (metadata.uid !== owner || (metadata.mode & 0o022)) return unavailable();
        const descriptor: unknown = JSON.parse((await readRegularFileWithin(directory, entry, 4096)).toString("utf8"));
        if (!record(descriptor) || descriptor.schemaVersion !== 1 || descriptor.connectionId !== connection ||
          !ID.test(connection) || descriptor.installationId !== this.network.config.installationId ||
          descriptor.scope !== "company" || descriptor.mode !== "read-only") return unavailable();
        if (operation === "filename_search" && (!Array.isArray(descriptor.capabilities) || !descriptor.capabilities.includes("filename_search_v1"))) {
          return { available: false, error: "FILENAME_SEARCH_UNSUPPORTED" };
        }
        const socketPath = path.join(directory, `${connection}.sock`);
        const socket = await lstat(socketPath);
        if (!socket.isSocket() || socket.uid !== owner || (socket.mode & 0o007)) return unavailable();
        const userRoots = await serverUserRoots(this.network.config.installationId,this.network.config.paths.dataRoot,this.options.userId,owner);
        if (userRoots?.length === 0) return unavailable();
        if ("binding" in input && !input.roots.every(root => serverPathAllowed(root, userRoots))) return { available: false, error: "SEARCH_CURSOR_EXPIRED_OR_DENIED" };
        if ("path" in input && !serverPathAllowed(input.path,userRoots)) return unavailable();
        if ("query" in input && (input.query.startsWith("server:/") || /^[A-Za-z]:[\\/]/.test(input.query))) {
          const location=input.query.startsWith("server:/") ? input.query.slice(8) : input.query[0]+"/"+input.query.slice(3).replaceAll("\\","/");
          if (location && !serverPathAllowed(`server-${connection}/${location}`,userRoots,true)) return unavailable();
        }
        const result=await this.request(socketPath, connection, operation, input);
        // Re-read revocable grants after the potentially slow Windows operation.
        const latestRoots=await serverUserRoots(this.network.config.installationId,this.network.config.paths.dataRoot,this.options.userId,owner);
        await this.network.validateSyncRoots(roots);
        if ("binding" in input && JSON.stringify(latestRoots) !== JSON.stringify(userRoots)) return { available: false, error: "SEARCH_CURSOR_EXPIRED_OR_DENIED" };
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
      const abort = () => finish(operation === "filename_search" ? { available: false, error: this.options.signal?.aborted ? "SEARCH_CANCELLED" : "SEARCH_SOURCE_OFFLINE" } : unavailable());
      const reject = () => finish(operation === "filename_search" ? { available: false, error: "SEARCH_SOURCE_INVALID_RESPONSE" } : unavailable());
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
          if (operation === "filename_search" && !value.available && (!/^(FILENAME_SEARCH_UNSUPPORTED|SEARCH_(SOURCE_(BUSY|OFFLINE|INACCESSIBLE|INVALID_RESPONSE)|CANCELLED|CURSOR_EXPIRED_OR_DENIED|POLICY_CHANGED|CAPACITY))$/u.test(String(value.error)) || value.nextCursor !== undefined)) return reject();
          if (value.available) {
            if (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) || Math.abs(Date.now() - Date.parse(value.checkedAt)) > 5 * 60_000) return abort();
            if (operation === "browse" && value.sourceChecked !== true) return abort();
            if (operation === "filename_search") {
              const args = input as FilenameSearchInput;
              if (value.sourceChecked !== true || value.lookupMode !== "source-filename-search-v1" || !Array.isArray(value.results) || value.results.length > args.limit ||
                  typeof value.limited !== "boolean" || !(value.nextCursor === null || typeof value.nextCursor === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value.nextCursor)) ||
                  value.limited !== (value.nextCursor !== null) || !record(value.coverage) || value.coverage.snapshot !== false || typeof value.coverage.complete !== "boolean" || value.coverage.complete === value.limited) return reject();
              for (const entry of value.results) {
                if (!record(entry) || entry.scope !== "company" || typeof entry.path !== "string" || !entry.path.startsWith(`server-${connectionId}/`) ||
                    !serverPathAllowed(entry.path, args.roots) || !["file", "directory"].includes(String(entry.kind)) ||
                    typeof entry.name !== "string" || entry.name.length > 255 || /\p{C}/u.test(entry.name) ||
                    !Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || typeof entry.modifiedAt !== "string" || !Number.isFinite(Date.parse(entry.modifiedAt))) return reject();
                validatePath(entry.path);
                if (decodeURIComponent(entry.path.split("/").at(-1) ?? "").normalize("NFC") !== entry.name.normalize("NFC")) return reject();
              }
            } else if (operation === "search" || operation === "browse" || operation === "inventory") {
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
