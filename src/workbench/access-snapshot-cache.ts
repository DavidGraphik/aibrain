import type { WorkbenchSnapshot } from "./types";

export type AccessSnapshot = WorkbenchSnapshot & { turnContext: null };
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 32;

/** Process-local acceleration only. No actor, grant, group or permission
 * decision belongs here. Oversized metadata remains uncached, never truncated. */
export class AccessSnapshotCache {
  private readonly entries = new Map<string, { identity: string; bytes: number; snapshot: AccessSnapshot }>();
  private bytes = 0;
  constructor(private readonly limits = { entryBytes: MAX_ENTRY_BYTES, totalBytes: MAX_TOTAL_BYTES, entries: MAX_ENTRIES }) {}
  get retainedBytes() { return this.bytes; }
  get size() { return this.entries.size; }

  delete(key: string) {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(key);
  }
  get(key: string, identity: string) {
    const entry = this.entries.get(key);
    if (!entry || entry.identity !== identity) { this.delete(key); return null; }
    this.entries.delete(key); this.entries.set(key, entry);
    return structuredClone(entry.snapshot);
  }
  set(key: string, identity: string, snapshot: AccessSnapshot) {
    this.delete(key);
    if (snapshot.turnContext !== null || snapshot.threads.some(thread => thread.messages.length)) {
      throw Error("Access metadata cache must not retain conversation history.");
    }
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (bytes > this.limits.entryBytes || bytes > this.limits.totalBytes) return;
    this.entries.set(key, { identity, bytes, snapshot: structuredClone(snapshot) }); this.bytes += bytes;
    while (this.bytes > this.limits.totalBytes || this.entries.size > this.limits.entries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}
