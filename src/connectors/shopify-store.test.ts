import { afterEach, it, expect, vi } from "vitest";
import { mkdtemp, realpath, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import type { InstallationConfig } from "@/config/installation-schema";
import { ShopifyStore } from "./shopify-store";
const user = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222", session = "a".repeat(64), callback = "https://brain.example/api/connectors/shopify/oauth/callback";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(now = Date.now) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "modtime-shopify-test-"))); roots.push(root);
  const config = { installationId: "modtime", paths: { dataRoot: root } } as InstallationConfig;
  return { root, config, store: new ShopifyStore(config, Buffer.alloc(32, 7), now) };
}
const token = () => ({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600_000, refreshExpiresAt: Date.now() + 7_776_000_000, scopes: ["read_orders", "read_draft_orders"] });
it("durable state binds operator/session/redirect, survives new instance, and consumes exactly once", async () => {
  const { config, store } = await fixture(), state = await store.createState(user, session, callback);
  await expect(store.consumeState(other, session, state, callback)).rejects.toThrow();
  await expect(store.consumeState(user, "b".repeat(64), state, callback)).rejects.toThrow();
  await expect(store.consumeState(user, session, state, callback + "/foreign")).rejects.toThrow();
  const another = new ShopifyStore(config, Buffer.alloc(32, 7));
  const results = await Promise.allSettled([store.consumeState(user, session, state, callback), another.consumeState(user, session, state, callback)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  await expect(store.consumeState(user, session, state, callback)).rejects.toThrow();
});
it("expired and superseded states fail closed", async () => {
  let now = Date.now(); const { store } = await fixture(() => now);
  const old = await store.createState(user, session, callback); await store.createState(user, session, callback);
  await expect(store.consumeState(user, session, old, callback)).rejects.toThrow();
  const fresh = await store.createState(user, session, callback); now += 300_001;
  await expect(store.consumeState(user, session, fresh, callback)).rejects.toThrow();
});
it("encrypts durable MODTIME tokens, rejects foreign installation/key and serializes refresh", async () => {
  const { config, root, store } = await fixture();
  expect(() => new ShopifyStore({ ...config, installationId: "foreign" }, Buffer.alloc(32, 7))).toThrow();
  await store.install(user, async () => ({ ...token(), expiresAt: Date.now() - 1 }));
  const raw = await readFile(path.join(root, "connectors/shopify-orders/token.json"), "utf8");
  expect(raw).not.toContain("synthetic"); expect(raw).not.toContain(user);
  const refresh = vi.fn(async () => token());
  const second = new ShopifyStore(config, Buffer.alloc(32, 7));
  await Promise.all([store.withAccess(refresh, async () => "safe"), second.withAccess(refresh, async () => "safe")]);
  expect(refresh).toHaveBeenCalledTimes(1);
  await expect(new ShopifyStore(config, Buffer.alloc(32, 8)).withAccess(refresh, async () => "safe")).rejects.toThrow("STORAGE_INVALID");
});
it("rejects a symlinked connector root and missing credentials", async () => {
  const { config, root, store } = await fixture();
  await expect(store.withAccess(async () => token(), async () => "safe")).rejects.toThrow("LOGIN_REQUIRED");
  const otherFixture = await fixture(); await symlink(root, path.join(otherFixture.root, "connectors"));
  await expect(new ShopifyStore(otherFixture.config, Buffer.alloc(32, 7)).createState(user, session, callback)).rejects.toThrow("STORAGE_UNSAFE");
  expect(config.installationId).toBe("modtime");
});
it("expired refresh requires reauthorization and failed refresh never overwrites durable credentials", async () => {
  const { root, store } = await fixture();
  await store.install(user, async () => ({ ...token(), expiresAt: Date.now() - 1, refreshExpiresAt: Date.now() - 1 }));
  const refresh = vi.fn(async () => token()), read = vi.fn(async () => "safe");
  await expect(store.withAccess(refresh, read)).rejects.toThrow("REAUTH_REQUIRED"); expect(refresh).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  await store.install(user, async () => ({ ...token(), expiresAt: Date.now() - 1 }));
  const file = path.join(root, "connectors/shopify-orders/token.json"), before = await readFile(file, "utf8");
  await expect(store.withAccess(async () => { throw Error("synthetic-provider-failure"); }, read)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before); expect(read).not.toHaveBeenCalled();
  await expect(store.withAccess(async () => ({ ...token(), expiresAt: Date.now() - 1 }), read)).rejects.toThrow("TOKEN_INVALID");
  expect(await readFile(file, "utf8")).toBe(before);
});
it("persists and refreshes a theme write grant with implicit read without touching the Orders grant", async () => {
  const { config, root, store: orders } = await fixture();
  await orders.install(user, async () => token());
  const ordersPath = path.join(root, "connectors/shopify-orders/token.json"), before = await readFile(ordersPath, "utf8");
  const profile = { clientId: "synthetic-theme-client", scopes: ["read_themes", "write_themes"], directory: "shopify-themes" as const };
  const themes = new ShopifyStore(config, Buffer.alloc(32, 6), Date.now, profile);
  await themes.install(user, async () => ({ ...token(), scopes: ["write_themes"], expiresAt: Date.now() - 1 }));
  await expect(themes.withAccess(async () => ({ ...token(), scopes: ["write_themes"] }), async () => "live-read")).resolves.toBe("live-read");
  expect(await readFile(ordersPath, "utf8")).toBe(before);
  expect(await readFile(path.join(root, "connectors/shopify-themes/token.json"), "utf8")).not.toContain("synthetic-access");
});
