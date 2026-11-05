import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FileSupportRequestStore } from "@/support/store";
import { parseSupportRequestInput } from "@/support/contracts";
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const input = { kind: "bug" as const, description: "No funciona\nAdjunto captura", context: { pathname: "/workspace", projectId: null, threadId: null, viewport: "desktop" as const } };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=";
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "support-lifecycle-")); let now = Date.parse("2026-11-04T08:00:00Z"); const store = new FileSupportRequestStore("trinalum-production", USER, root, () => now); return { root, store, advance: (ms: number) => { now += ms; } }; }
describe("durable support lifecycle", () => {
  it("deduplicates delivery retries before rate limit and rejects reused identity with changed payload", async () => {
    const { store } = await fixture(); const report = { ...input, clientRequestId: randomUUID() };
    const first = await store.create(report);
    for (let i = 0; i < 12; i++) expect((await store.create(report)).id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
    await expect(store.create({ ...report, description: "Other" })).rejects.toMatchObject({ code: "SUPPORT_IDEMPOTENCY_CONFLICT" });
  });
  it("stores screenshots separately, with private owner-only lookup and no binary in request response", async () => {
    const { store, root } = await fixture();
    const request = await store.create({ ...input, screenshots: [{ name: "capture.png", mimeType: "image/png", dataUrl: PNG }] });
    expect(JSON.stringify(request)).not.toContain("base64");
    expect(JSON.stringify(await store.list())).not.toContain("base64");
    const image = await store.readScreenshot(request.id, request.screenshots[0].id);
    expect(image?.data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(await new FileSupportRequestStore("trinalum-production", OTHER, root).readScreenshot(request.id, request.screenshots[0].id)).toBeNull();
    await expect(new FileSupportRequestStore("g03-production", USER, root).list()).rejects.toMatchObject({ code: "SUPPORT_STORE_CORRUPT" });
  });
  it("rejects disguised SVG/HTML screenshots and unknown fields before persist", async () => {
    const { store } = await fixture();
    await expect(store.create({ ...input, screenshots: [{ name: "bad.png", mimeType: "image/png", dataUrl: `data:image/png;base64,${Buffer.from("<svg onload='alert(1)'/>").toString("base64")}` }] })).rejects.toMatchObject({ code: "SUPPORT_SCREENSHOT_INVALID" });
    expect(parseSupportRequestInput({ ...input, evidence: { revision: "a".repeat(40) } })).toBeNull();
  });
  it("grants one claim, fences expired workers, and keeps private lease off user responses", async () => {
    const { store, advance } = await fixture(); await store.create(input);
    const first = (await store.claim("worker1"))!;
    expect(await store.claim("worker2")).toBeNull();
    expect(JSON.stringify(await store.list())).not.toContain(first.token);
    advance(121_000);
    const next = (await store.claim("worker2"))!;
    expect(next.token).not.toBe(first.token);
    await expect(store.update(first.request.id, first.token, { status: "declined", body: "old", clientRequestId: randomUUID() })).rejects.toMatchObject({ code: "SUPPORT_LEASE_LOST" });
    await expect(store.renew(next.request.id, next.token)).resolves.toHaveProperty("expiresAt");
  });
  it("requires matching fresh deployed UI evidence before resolution", async () => {
    const { store } = await fixture(); await store.create(input); const claim = (await store.claim("worker"))!;
    const update = { status: "resolved" as const, body: "Ya funciona", clientRequestId: randomUUID() };
    await expect(store.update(claim.request.id, claim.token, update)).rejects.toMatchObject({ code: "SUPPORT_ACCEPTANCE_REQUIRED" });
    await expect(store.update(claim.request.id, claim.token, { ...update, evidence: { revision: "a".repeat(40), installationId: "other", checkedAt: "2026-11-04T08:00:00Z", url: "https://brain.example.test/" } })).rejects.toMatchObject({ code: "SUPPORT_ACCEPTANCE_REQUIRED" });
    const done = await store.update(claim.request.id, claim.token, { ...update, evidence: { revision: "a".repeat(40), installationId: "trinalum-production", checkedAt: "2026-11-04T08:00:00Z", url: "https://brain.example.test/workspace" } });
    expect(done.status).toBe("resolved"); expect(await store.claim("worker")).toBeNull();
  });
  it("reopens the same case once and invalidates acceptance and outstanding workers on a user reply", async () => {
    const { store } = await fixture(); const report = await store.create(input); const claim = (await store.claim("worker"))!;
    const reply = { body: "Sigue fallando", clientRequestId: randomUUID() };
    await store.reply(report.id, reply); await store.reply(report.id, reply);
    const requests = await store.list(); expect(requests).toHaveLength(1); expect(requests[0].messages).toHaveLength(2); expect(requests[0].status).toBe("queued");
    await expect(store.renew(report.id, claim.token)).rejects.toMatchObject({ code: "SUPPORT_LEASE_LOST" });
  });
  it("normalizes legacy records without losing original description or notification receipt", async () => {
    const { store, root } = await fixture(); await mkdir(path.join(root, USER, "support"), { recursive: true });
    const legacy = { ...input, id: randomUUID(), schemaVersion: 1, installationId: "trinalum-production", userId: USER, createdAt: "2026-11-03T08:00:00Z", notification: "delivered" };
    const target = path.join(root, USER, "support", "requests.json"); await writeFile(target, JSON.stringify({ schemaVersion: 1, requests: [legacy] }));
    expect((await store.list())[0]).toMatchObject({ status: "queued", description: input.description, notification: "delivered", screenshots: [], messages: [{ body: input.description }] });
    expect((await readFile(target, "utf8"))).not.toContain("messages");
  });
  it("rejects path traversal and linked support roots", async () => {
    const { root } = await fixture();
    expect(() => new FileSupportRequestStore("trinalum-production", "../other", root)).toThrow();
    await mkdir(path.join(root, OTHER)); await mkdir(path.join(root, USER)); await symlink(path.join(root, OTHER), path.join(root, USER, "support"));
    await expect(new FileSupportRequestStore("trinalum-production", USER, root).list()).rejects.toMatchObject({ code: "SUPPORT_STORE_UNSAFE" });
  });
});
