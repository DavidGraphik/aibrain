import { randomUUID } from 'node:crypto';
import { constants, closeSync, lstatSync, mkdirSync, openSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Every row is an immutable snapshot, scoped to installation, identity and
// current authorization. A completed cursor stores its replay atomically with
// the next cursor so an interrupted response never loses the traversal.
export const CURSOR_MAX_BYTES = 2 * 1024 * 1024;
const TTL = 10 * 60_000;
const LEASE = 120_000;
const MAX_ROWS = 16;
const MAX_USER_ROWS = 8;
// Small application-specific store budget, not a replacement for host/deploy
// reserve. Installation code may supply a higher private storage floor.
const MIN_FREE_BYTES = 100 * 1000 ** 2;

type Binding = { installation: string; userId: string; roots: string; userRoots: string };
type Row = { binding: string; state: string; expires: number; lease: string | null; lease_until: number | null; replay: string | null };
export type CursorAdmission<T, R> = { kind: 'denied' } | { kind: 'busy' } | { kind: 'replay'; result: R } | { kind: 'acquired'; state: T; lease: string };

export class DurableNameCursors {
  private readonly db: DatabaseSync;
  private readonly directory: string;
  constructor(dataRoot: string, private readonly now = () => Date.now(), private readonly minimumFreeBytes = MIN_FREE_BYTES) {
    if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0 || !path.isAbsolute(dataRoot)) throw Error('CURSOR_STORAGE_UNSAFE');
    const root = lstatSync(dataRoot);
    const uid = process.getuid?.();
    if (!root.isDirectory() || root.isSymbolicLink() || (uid !== undefined && root.uid !== uid) || (root.mode & 0o077)) throw Error('CURSOR_STORAGE_UNSAFE');
    const dir = path.join(dataRoot, 'server-name-search');
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const meta = lstatSync(dir);
    if (!meta.isDirectory() || meta.isSymbolicLink() || (uid !== undefined && meta.uid !== uid) || (meta.mode & 0o077)) throw Error('CURSOR_STORAGE_UNSAFE');
    this.checkSpace(dir);
    this.directory = dir;
    const file = path.join(dir, 'cursors.sqlite3');
    try { closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try {
        const extra = lstatSync(file + suffix);
        if (!extra.isFile() || extra.isSymbolicLink() || (uid !== undefined && extra.uid !== uid) || (extra.mode & 0o077) || extra.nlink !== 1) throw Error('CURSOR_STORAGE_UNSAFE');
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) || info.nlink !== 1) throw Error('CURSOR_STORAGE_UNSAFE');
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA busy_timeout=2500; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
        PRAGMA max_page_count=10240;
        CREATE TABLE IF NOT EXISTS cursors(id TEXT PRIMARY KEY, binding TEXT NOT NULL, user_key TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL, lease TEXT, lease_until INTEGER, replay TEXT);`);
      this.db.prepare('DELETE FROM cursors WHERE expires<=? AND (lease IS NULL OR lease_until<=?)').run(this.now(), this.now());
    } catch (error) { this.db.close(); throw error; }
  }
  private checkSpace(directory: string) {
    const fs = statfsSync(directory); if (fs.bavail * fs.bsize < this.minimumFreeBytes) throw Error('CURSOR_STORAGE_QUOTA');
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  acquire<T, R>(id: string, binding: Binding): CursorAdmission<T, R> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT binding,state,expires,lease,lease_until,replay FROM cursors WHERE id=?').get(id) as Row | undefined;
      const now = this.now();
      if (!row || row.expires <= now || row.binding !== JSON.stringify(binding)) return { kind: 'denied' };
      if (row.replay) return { kind: 'replay', result: JSON.parse(row.replay) as R };
      if (row.lease && (row.lease_until ?? 0) > now) return { kind: 'busy' };
      const lease = randomUUID();
      this.db.prepare('UPDATE cursors SET lease=?,lease_until=? WHERE id=?').run(lease, now + LEASE, id);
      return { kind: 'acquired', state: JSON.parse(row.state) as T, lease };
    });
  }
  release(id: string, lease: string) { this.db.prepare('UPDATE cursors SET lease=NULL,lease_until=NULL WHERE id=? AND lease=?').run(id, lease); }
  finish<T, R>(binding: Binding, state: T | null, prior: { id: string; lease: string } | null, build: (next: string | null) => R, replayValue?: (result: R) => unknown): R {
    this.checkSpace(this.directory);
    const serialized = state === null ? null : JSON.stringify(state);
    if (serialized && Buffer.byteLength(serialized) > CURSOR_MAX_BYTES) throw Error('CURSOR_STORAGE_QUOTA');
    return this.transaction(() => {
      const now = this.now();
      this.db.prepare('DELETE FROM cursors WHERE expires<=? AND (lease IS NULL OR lease_until<=?)').run(now, now);
      if (prior) {
        const row = this.db.prepare('SELECT binding,lease,lease_until FROM cursors WHERE id=?').get(prior.id) as Row | undefined;
        if (!row || row.binding !== JSON.stringify(binding) || row.lease !== prior.lease || (row.lease_until ?? 0) <= now) throw Error('CURSOR_LEASE_LOST');
      }
      let next: string | null = null;
      if (serialized !== null) {
        // Keep completed responses replayable for the full TTL unless a quota
        // requires evicting the oldest replay. Never evict live work or the
        // request whose completion is being committed.
        const userKey = binding.installation + '\0' + binding.userId;
        const counts = () => this.db.prepare('SELECT count(*) AS total, coalesce(sum(user_key=?),0) AS own FROM cursors').get(userKey) as { total: number; own: number };
        let count = counts();
        if (count.own >= MAX_USER_ROWS) {
          this.db.prepare('DELETE FROM cursors WHERE id=(SELECT id FROM cursors WHERE replay IS NOT NULL AND user_key=? AND id!=? ORDER BY expires LIMIT 1)').run(userKey, prior?.id ?? '');
          count = counts();
        }
        if (count.total >= MAX_ROWS) {
          this.db.prepare('DELETE FROM cursors WHERE id=(SELECT id FROM cursors WHERE replay IS NOT NULL AND id!=? ORDER BY expires LIMIT 1)').run(prior?.id ?? '');
          count = counts();
        }
        if (count.total >= MAX_ROWS || count.own >= MAX_USER_ROWS) throw Error('CURSOR_STORAGE_QUOTA');
        next = randomUUID();
        this.db.prepare('INSERT INTO cursors(id,binding,user_key,state,expires) VALUES(?,?,?,?,?)').run(next, JSON.stringify(binding), binding.installation + '\0' + binding.userId, serialized, now + TTL);
      }
      const result = build(next ? `name-cursor:${next}` : null);
      const replay = JSON.stringify(replayValue ? replayValue(result) : result);
      if (Buffer.byteLength(replay) > CURSOR_MAX_BYTES) throw Error('CURSOR_STORAGE_QUOTA');
      if (prior) this.db.prepare('UPDATE cursors SET state=?,replay=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=?').run('{}', replay, prior.id, prior.lease);
      return result;
    });
  }
}
