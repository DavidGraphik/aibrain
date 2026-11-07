import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { NativeOAuthCallbackStore, forwardNativeOAuthCallback, NATIVE_OAUTH_PORT_MIN, nativeOAuthPortAvailable } from "./native-oauth-callback";
vi.mock("server-only", () => ({}));
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const generation = { generation: "33333333-3333-4333-8333-333333333333", instanceId: "app", dev: 1, ino: 2 };
const otherGeneration = { ...generation, generation: "44444444-4444-4444-8444-444444444444" };
const owner = (userId = A) => ({ userId, resourceId: "personal-mail", server: "mail", generation });
let root: string, now: number;
const store = (available: (port: number) => Promise<boolean> = async () => true) => new NativeOAuthCallbackStore("company-qa", root, "https://brain.example", () => now, available);
async function pending(selected = store(), user = A, state = "sdk-state-A") {
  const lease = await selected.begin(owner(user));
  await selected.bind(lease.attempt.id, `https://provider.example/authorize?redirect_uri=${encodeURIComponent(lease.callbackUrl)}&state=${encodeURIComponent(state)}`, "native-login");
  return { selected, lease, url: `${lease.callbackUrl}?code=synthetic-provider-code&state=${encodeURIComponent(state)}` };
}
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), "native-callback-"))); now = Date.now(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("private single-use native OAuth callback leases", () => {
  it("uses one stable URI for two users with distinct private ports and states", async () => {
    const first = await pending(store(), A, "sdk-state-A");
    const second = await pending(store(), B, "sdk-state-B");
    expect(first.lease.callbackUrl).toBe("https://brain.example/api/connectors/native/callback");
    expect(second.lease.callbackUrl).toBe(first.lease.callbackUrl);
    expect(first.lease.attempt.port).not.toBe(second.lease.attempt.port);
    expect(await first.selected.consume(A, first.url, async () => generation)).toMatchObject({ userId: A, phase: "consuming" });
    expect(await second.selected.consume(B, second.url, async () => generation)).toMatchObject({ userId: B, phase: "consuming" });
  });
  it("persists only a state digest, never code, state, authorization URL or token", async () => {
    await pending();
    const raw = await readFile(path.join(root, "native-oauth-callbacks/state.json"), "utf8");
    for (const value of ["synthetic-provider-code", "sdk-state-A", "provider.example", "access_token", "code_verifier"]) expect(raw).not.toContain(value);
    expect(JSON.parse(raw).attempts[0].stateHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("does not consume another user's known state", async () => {
    const p = await pending(); const validate = vi.fn(async () => generation);
    await expect(p.selected.consume(B, p.url, validate)).rejects.toMatchObject({ code: "NATIVE_OAUTH_SCOPE_DENIED" });
    expect(validate).not.toHaveBeenCalled();
    await expect(p.selected.consume(A, p.url, validate)).resolves.toMatchObject({ phase: "consuming" });
  });
  it("serializes concurrent duplicate callbacks and preserves consumption across restarts", async () => {
    const p = await pending();
    const results = await Promise.allSettled([p.selected.consume(A, p.url, async () => generation), store().consume(A, p.url, async () => generation)]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    await expect(store().consume(A, p.url, async () => generation)).rejects.toMatchObject({ code: "NATIVE_OAUTH_ATTEMPT_EXPIRED" });
  });
  it("rejects a replaced worker generation before forwarding and retains a valid same-generation receipt", async () => {
    const p = await pending();
    await expect(store().consume(A, p.url, async () => otherGeneration)).rejects.toMatchObject({ code: "NATIVE_OAUTH_RUNTIME_CHANGED" });
    await expect(store().consume(A, p.url, async () => generation)).resolves.toMatchObject({ phase: "consuming" });
  });
  it("rejects expired, revoked, absent and unknown states before runtime lookup", async () => {
    const p = await pending(); const validate = vi.fn(async () => generation);
    for (const url of [p.lease.callbackUrl, p.url.replace("sdk-state-A", "unknown"), p.url + "&state=duplicate"]) await expect(p.selected.consume(A, url, validate)).rejects.toBeDefined();
    await p.selected.revoke(A, "personal-mail");
    await expect(p.selected.consume(A, p.url, validate)).rejects.toMatchObject({ code: "NATIVE_OAUTH_ATTEMPT_EXPIRED" });
    expect(validate).not.toHaveBeenCalled();
    const fresh = await pending(store(), B, "sdk-state-B"); now += 600_000;
    await expect(fresh.selected.consume(B, fresh.url, validate)).rejects.toMatchObject({ code: "NATIVE_OAUTH_ATTEMPT_EXPIRED" });
    expect(validate).not.toHaveBeenCalled();
  });
  it("keeps collided/consumed ports unavailable until the native listener lease expires", async () => {
    const available = vi.fn(async (port: number) => port !== NATIVE_OAUTH_PORT_MIN);
    const selected = store(available), first = await pending(selected);
    expect(first.lease.attempt.port).toBe(NATIVE_OAUTH_PORT_MIN + 1);
    await selected.consume(A, first.url, async () => generation); await selected.finish(first.lease.attempt.id, "completed");
    const second = await pending(selected, B, "sdk-state-B");
    expect(second.lease.attempt.port).toBe(NATIVE_OAUTH_PORT_MIN + 2);
    await expect(store(async () => false).begin(owner("55555555-5555-4555-8555-555555555555"))).rejects.toMatchObject({ code: "NATIVE_OAUTH_NO_PRIVATE_PORT" });
  });
  it("binds settings writes to the private preparing lease and owner, never URL alone", async () => {
    const selected = store(), lease = await selected.begin(owner());
    await expect(selected.assertPreparing(lease.callbackUrl, owner(), lease.attempt.port)).resolves.toBeUndefined();
    for (const [who, port] of [[owner(B), lease.attempt.port], [owner(), lease.attempt.port + 1], [{ ...owner(), generation: otherGeneration }, lease.attempt.port]] as const) {
      await expect(selected.assertPreparing(lease.callbackUrl, who, port)).rejects.toMatchObject({ code: "NATIVE_OAUTH_LEASE_DENIED" });
    }
  });
  it("rejects PAR/absent state, ambiguous native states and foreign callback origins", async () => {
    const selected = store(), first = await selected.begin(owner());
    await expect(selected.bind(first.attempt.id, "https://provider.example/authorize?request_uri=opaque", "id")).rejects.toMatchObject({ code: "NATIVE_OAUTH_CALLBACK_STATE_UNSUPPORTED" });
    await expect(selected.bind(first.attempt.id, `https://provider.example/authorize?state=one&redirect_uri=${encodeURIComponent("https://foreign.example/api/connectors/native/callback")}`, "id")).rejects.toMatchObject({ code: "NATIVE_OAUTH_CALLBACK_MISMATCH" });
    await selected.bind(first.attempt.id, `https://provider.example/authorize?state=one&redirect_uri=${encodeURIComponent(first.callbackUrl)}`, "id");
    const second = await selected.begin(owner(B));
    await expect(selected.bind(second.attempt.id, `https://provider.example/authorize?state=one&redirect_uri=${encodeURIComponent(second.callbackUrl)}`, "id-B")).rejects.toMatchObject({ code: "NATIVE_OAUTH_STATE_AMBIGUOUS" });
  });
  it("blocks browser-unreachable callback origins while allowing local disconnect bookkeeping", async () => {
    const local = new NativeOAuthCallbackStore("company-qa", root, "http://localhost:3000", () => now);
    await expect(local.begin(owner())).rejects.toMatchObject({ code: "NATIVE_OAUTH_PUBLIC_ORIGIN_INVALID" });
    await expect(local.revoke(A, "personal-mail")).resolves.toBeUndefined();
  });
  it("forwards only the leased loopback path/query, without credentials, cookies or redirects", async () => {
    const received: Array<{ headers: unknown; url: string }> = [];
    const server = createServer((request, response) => { received.push({ headers: request.headers, url: request.url! }); response.writeHead(303, { Location: "https://unvisited.example" }); response.end("fixture"); });
    let port = NATIVE_OAUTH_PORT_MIN;
    while (!await nativeOAuthPortAvailable(port)) port++;
    await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
    try {
      const selected = store(async value => value === port), p = await pending(selected);
      const row = await selected.consume(A, p.url, async () => generation);
      expect(await forwardNativeOAuthCallback(row, p.url + "&destination=https://unvisited.example")).toBe(303);
      expect(received).toHaveLength(1);
      expect(received[0].headers).not.toHaveProperty("cookie"); expect(received[0].headers).not.toHaveProperty("authorization");
      expect(received[0].url).toContain("/api/connectors/native/callback?");
      await expect(forwardNativeOAuthCallback({ ...row, port: 0 }, p.url)).rejects.toMatchObject({ code: "NATIVE_OAUTH_FORWARD_DENIED" });
      await expect(forwardNativeOAuthCallback(row, p.url.replace("/native/callback", "/foreign"))).rejects.toMatchObject({ code: "NATIVE_OAUTH_FORWARD_DENIED" });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

 it("rejects unverified native callback suffixes and gives a specific static-registration blocker", async () => {
  const selected=store(), lease=await selected.begin(owner());
  const auth=`https://provider.example/authorize?state=one&redirect_uri=${encodeURIComponent(lease.callbackUrl+"/opaque-sdk-suffix")}`;
  await expect(selected.bind(lease.attempt.id,auth,"login",true)).rejects.toMatchObject({code:"NATIVE_OAUTH_STATIC_CALLBACK_UNSUPPORTED"});
  await expect(selected.bind(lease.attempt.id,auth,"login",false)).rejects.toMatchObject({code:"NATIVE_OAUTH_CALLBACK_VARIANT_UNSUPPORTED"});
 });
