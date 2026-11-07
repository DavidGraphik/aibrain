import { expect, it, vi } from "vitest";
import { G03PublicationClient } from "./publication-client";

const target = "server-g03/M/G03/PRODUCCIO/prova.txt";
function fixture() {
  const client = new G03PublicationClient({ installationId: "g03-qa", socketDirectory: "/tmp/synthetic-clock-test" });
  const sourceTime = new Date(Date.now() + 69.3 * 60_000).toISOString();
  const value = { available: true, sourceChecked: true, exists: true, size: 42, sha256: "a".repeat(64),
    modifiedAt: sourceTime, checkedAt: new Date().toISOString(),
    sourceClock: { basis: "windows-wall-clock", checkedAt: sourceTime, freshness: "authenticated-monotonic-job-v2" } };
  // Snapshot validation unit tests only. Real authenticated socket/HTTP contract
  // with skewed Windows metadata is exercised by outbound-contract.test.ts.
  const response = vi.spyOn(client as unknown as { request(): Promise<Record<string, unknown>> }, "request");
  response.mockResolvedValue(value);
  return { client, value, response, sourceTime };
}
it("preserves raw Windows mtime only with explicit v2 source clock provenance", async () => {
  const f = fixture();
  expect((await f.client.snapshot(target)).mtimeMs).toBe(Date.parse(f.sourceTime));
  const { sourceClock: _clock, ...legacy } = f.value;
  f.response.mockResolvedValue(legacy);
  await expect(f.client.snapshot(target)).rejects.toThrow();
});
it.each([
  { basis: "untrusted", checkedAt: new Date().toISOString(), freshness: "authenticated-monotonic-job-v2" },
  { basis: "windows-wall-clock", checkedAt: "invalid", freshness: "authenticated-monotonic-job-v2" },
  { basis: "windows-wall-clock", checkedAt: new Date().toISOString(), freshness: "disabled" },
  { basis: "windows-wall-clock", checkedAt: new Date().toISOString(), freshness: "authenticated-monotonic-job-v2", extra: true },
])( "rejects invalid source-clock provenance %#", async (sourceClock) => {
  const f = fixture(); f.response.mockResolvedValue({ ...f.value, sourceClock });
  await expect(f.client.snapshot(target)).rejects.toThrow();
});
it("retains the source-domain future-mtime bound", async () => {
  const f = fixture();
  f.response.mockResolvedValue({ ...f.value, modifiedAt: new Date(Date.parse(f.sourceTime) + 301_000).toISOString() });
  await expect(f.client.snapshot(target)).rejects.toThrow();
});
