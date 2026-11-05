import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSupportRequestStore } from "@/support/store";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const input = { kind: "help" as const, description: "Necesito ayuda", context: { pathname: "/", projectId: null, threadId: null, viewport: "desktop" as const } };

describe("FileSupportRequestStore", () => {
  it("persists requests under the reporting user and isolates another user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-support-"));
    await Promise.all([mkdir(path.join(root, USER_A), { mode: 0o700 }), mkdir(path.join(root, USER_B), { mode: 0o700 })]);
    const created = await new FileSupportRequestStore("company-qa", USER_A, root).create(input);
    const stored = JSON.parse(await readFile(path.join(root, USER_A, "support", "requests.json"), "utf8")) as { requests: Array<{ id: string }> };
    expect(stored.requests[0].id).toBe(created.id);
    await expect(readFile(path.join(root, USER_B, "support", "requests.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rate limits repeated reports durably", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-support-rate-"));
    await mkdir(path.join(root, USER_A), { mode: 0o700 });
    const store = new FileSupportRequestStore("company-qa", USER_A, root, () => Date.parse("2026-09-05T10:00:00.000Z"));
    for (let index = 0; index < 10; index += 1) await store.create({ ...input, description: `${input.description} ${index}` });
    await expect(store.create(input)).rejects.toMatchObject({ code: "SUPPORT_RATE_LIMITED" });
  });
});
