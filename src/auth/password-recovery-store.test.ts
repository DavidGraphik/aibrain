import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePasswordRecoveryStore, PASSWORD_RECOVERY_MS } from "./password-recovery-store";

const roots: string[] = [];
const key = Buffer.alloc(32, 11);
const scope = { installationId: "example-lab-dev", publicOrigin: "https://brain.example.test" };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "recovery-store-")); roots.push(root);
  let now = 1_000_000;
  const options = { rootDirectory: root, encryptionKey: key, now: () => now };
  const store = new FilePasswordRecoveryStore(options);
  const request = await store.create({ ...scope, email: "employee@example.test" });
  const file = path.join(root, "records", `${createHash("sha256").update(request.recoveryId).digest("hex")}.json`);
  return { store, request, file, options, expire: () => { now += PASSWORD_RECOVERY_MS; } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("encrypted browser-bound password recovery state", () => {
  it("stores neither verifier, browser handle nor email in plaintext and survives an app restart", async () => {
    const { request, file, options } = await fixture();
    const bytes = await readFile(file, "utf8");
    for (const secret of [request.codeVerifier, request.recoveryId, "employee@example.test"]) expect(bytes).not.toContain(secret);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await new FilePasswordRecoveryStore(options).consume(request.recoveryId, scope, async (value) => value))
      .toEqual({ codeVerifier: request.codeVerifier, email: "employee@example.test" });
  });

  it("rejects another installation, origin or browser before consuming state", async () => {
    const { store, request } = await fixture(); const operation = vi.fn().mockResolvedValue("accepted");
    expect(await store.consume(request.recoveryId, { ...scope, installationId: "foreign-lab" }, operation)).toBeNull();
    expect(await store.consume(request.recoveryId, { ...scope, publicOrigin: "https://foreign.example.test" }, operation)).toBeNull();
    expect(await store.consume("b".repeat(43), scope, operation)).toBeNull();
    expect(await store.consume("../../invalid", scope, operation)).toBeNull();
    expect(operation).not.toHaveBeenCalled();
    expect(await store.consume(request.recoveryId, scope, operation)).toBe("accepted");
  });

  it("expires the pending request without invoking the provider", async () => {
    const { store, request, expire } = await fixture(); expire(); const operation = vi.fn();
    expect(await store.consume(request.recoveryId, scope, operation)).toBeNull();
    expect(operation).not.toHaveBeenCalled();
  });

  it("allows only one completion across concurrent process-store instances", async () => {
    const { store, request, options } = await fixture(); const operation = vi.fn().mockResolvedValue("accepted");
    const results = await Promise.all([store, new FilePasswordRecoveryStore(options)].map((value) => value.consume(request.recoveryId, scope, operation)));
    expect(results.filter((value) => value === "accepted")).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("claims state before provider effects and does not replay after a crash or outage", async () => {
    const { store, request } = await fixture();
    await expect(store.consume(request.recoveryId, scope, async () => { throw new Error("synthetic crash"); })).rejects.toThrow("synthetic crash");
    const operation = vi.fn(); expect(await store.consume(request.recoveryId, scope, operation)).toBeNull();
    expect(operation).not.toHaveBeenCalled();
  });

  it("authenticates encrypted payload and installation metadata before provider effects", async () => {
    const { store, request, file } = await fixture();
    const record = JSON.parse(await readFile(file, "utf8"));
    record.publicOrigin = "https://foreign.example.test";
    await writeFile(file, JSON.stringify(record)); const operation = vi.fn();
    await expect(store.consume(request.recoveryId, { ...scope, publicOrigin: record.publicOrigin }, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });

  it("prunes expired states when the next request is created", async () => {
    const { store, file, expire } = await fixture(); expire();
    await store.create({ ...scope, email: "other@example.test" });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
