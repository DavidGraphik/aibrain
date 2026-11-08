import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/chat-contract";
import { AccessSnapshotCache, type AccessSnapshot } from "./access-snapshot-cache";
const empty = (): AccessSnapshot => ({ persistence: "filesystem", projects: [], threads: [], turnContext: null });
describe("small metadata-only process cache", () => {
  it("bounds serialized bytes and LRU entries without retaining message histories", () => {
    const bytes = Buffer.byteLength(JSON.stringify(empty()));
    const cache = new AccessSnapshotCache({ entryBytes: bytes, totalBytes: bytes * 2, entries: 2 });
    cache.set("A", "file-A", empty()); cache.set("B", "file-B", empty());
    expect(cache.get("A", "file-A")).not.toBeNull(); // A is now most recently used
    cache.set("C", "file-C", empty());
    expect(cache.get("B", "file-B")).toBeNull(); expect(cache.size).toBe(2);
    expect(cache.retainedBytes).toBeLessThanOrEqual(bytes * 2);
    expect(cache.get("A", "replacement-A")).toBeNull(); expect(cache.size).toBe(1);
    const tiny = new AccessSnapshotCache({ entryBytes: bytes - 1, totalBytes: bytes * 2, entries: 2 });
    tiny.set("large", "identity", empty()); expect(tiny.size).toBe(0);
  });
  it("returns isolated metadata and refuses to cache even one message or turn context", () => {
    const cache = new AccessSnapshotCache();
    const source = empty(); cache.set("A", "file-A", source);
    source.persistence = "browser-preview";
    const first = cache.get("A", "file-A")!; first.persistence = "browser-preview";
    expect(cache.get("A", "file-A")!.persistence).toBe("filesystem");
    expect(() => cache.set("history", "id", { ...empty(), threads: [{ id: "t", projectId: "p", title: "t", status: "active", pinned: false, createdAt: "", updatedAt: "", messages: [{} as ChatMessage] }] })).toThrow("history");
    expect(() => cache.set("context", "id", { ...empty(), turnContext: "private history" as never })).toThrow("history");
    expect(cache.size).toBe(1);
  });
});
