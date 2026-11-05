import { createHash } from 'node:crypto';
export function compactEvent(item, maximum) {
  const snapshot = item.snapshot;
  const raw = JSON.stringify(snapshot.data ?? {});
  const parsed = new Date(snapshot.fetched_at ?? 0);
  return { snapshot_id: item.snapshotId, event_id: String(snapshot.event_id ?? item.snapshotId),
    event_type: String(snapshot.event_type ?? ''), fetched_at: Number.isNaN(parsed.getTime()) ? '1970-01-01T00:00:00.000Z' : parsed.toISOString(),
    payload_json: raw.length <= maximum ? raw : `${raw.slice(0, maximum)}…[truncated]` };
}
export function hashJson(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
