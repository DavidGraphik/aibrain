import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), metadata: { uid: 0, mode: 0o100644, nlink: 1, size: 200, isFile: () => true }, content: "", close: vi.fn() }));
vi.mock("node:fs/promises", () => ({ open: mocks.open }));
import { readSupportAccessPolicy, SUPPORT_ENABLE_MAX_MS } from "./support-access-policy";
const now = 100000;
const marker = { schemaVersion: 1, installationId: "g03-production", operatorUserId: "10000000-0000-4000-8000-000000000001", expiresAt: now + 60000 };
beforeEach(() => {
  mocks.content = JSON.stringify(marker); mocks.metadata = { uid: 0, mode: 0o100644, nlink: 1, size: 200, isFile: () => true };
  mocks.close.mockReset().mockResolvedValue(undefined); mocks.open.mockReset().mockImplementation(async () => ({ stat: async () => mocks.metadata, readFile: async () => mocks.content, close: mocks.close }));
});
describe("temporary root-owned support opt-in", () => {
  it("accepts only the opened root-owned installation-bound short-lived marker", async () => {
    expect(await readSupportAccessPolicy("/private/data", "g03-production", now)).toEqual(marker);
    expect(mocks.open.mock.calls[0][0]).toBe("/private/data/locks/support-access-enable.json");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it.each([ { uid: 501 }, { mode: 0o100664 }, { mode: 0o100646 }, { nlink: 2 }, { size: 2049 }, { isFile: () => false } ])("rejects unsafe opened-inode metadata %o", async metadata => {
    Object.assign(mocks.metadata, metadata); expect(await readSupportAccessPolicy("/private/data", "g03-production", now)).toBeNull();
  });
  it.each([ { installationId: "other-client" }, { expiresAt: now }, { expiresAt: now + SUPPORT_ENABLE_MAX_MS + 1 }, { operatorUserId: "invalid" }, { unknown: true } ])("rejects invalid, wrong-tenant or expired markers %o", async change => {
    mocks.content = JSON.stringify({ ...marker, ...change }); expect(await readSupportAccessPolicy("/private/data", "g03-production", now)).toBeNull();
  });
  it("fails closed on missing/symlink markers and malformed JSON", async () => {
    mocks.open.mockRejectedValueOnce(Object.assign(new Error("link refused"), { code: "ELOOP" }));
    expect(await readSupportAccessPolicy("/private/data", "g03-production", now)).toBeNull();
    mocks.content = "broken"; expect(await readSupportAccessPolicy("/private/data", "g03-production", now)).toBeNull();
  });
});
