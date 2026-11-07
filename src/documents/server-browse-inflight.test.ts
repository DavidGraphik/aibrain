import { describe, expect, it, vi } from "vitest";
import { ServerBrowseInflight } from "./server-browse-inflight";
describe("in-flight Server browsing", () => {
  it("coalesces reopen, isolates actor/project keys and always refreshes after completion", async () => {
    const pool = new ServerBrowseInflight();
    let finish!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const first = pool.run("installation:user:project:roots:path", read);
    const reopen = pool.run("installation:user:project:roots:path", read);
    expect(first).toBe(reopen);
    const other = pool.run("installation:other:project:roots:path", async () => "other");
    await expect(other).resolves.toBe("other");
    finish("fresh"); await first;
    expect(read).toHaveBeenCalledOnce();
    await expect(pool.run("installation:user:project:roots:path", async () => "external change")).resolves.toBe("external change");
  });
  it("bounds admissions and releases failed reads for retry", async () => {
    const pool = new ServerBrowseInflight(1);
    let fail!: (error: Error) => void;
    const first = pool.run("one", () => new Promise((_resolve, reject) => { fail = reject; }));
    await expect(pool.run("two", async () => 2)).rejects.toThrow("QUEUE_FULL");
    const result = expect(first).rejects.toThrow("failed"); fail(new Error("failed")); await result;
    await expect(pool.run("one", async () => "recovered")).resolves.toBe("recovered");
  });
});
