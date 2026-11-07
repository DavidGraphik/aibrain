import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import { sharedAuthProvider, sharedAuthSnapshot } from "./shared-auth-broker";

const roots: string[] = [];
const now = Date.parse("2026-10-01T20:00:00Z");
function auth(expiry: number, account = "qa-account", version = "one") {
  const access = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(expiry / 1000), version,
    "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "business" },
  })).toString("base64url")}.signature`;
  return JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: access, account_id: account, refresh_token: "private-refresh-secret" } });
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "auth-broker-")); roots.push(root);
  const directory = path.join(root, "shared"); await mkdir(directory, { mode: 0o700 });
  const source = path.join(directory, "auth.json");
  const config = { installationId: "qa-company", paths: { dataRoot: root } } as InstallationConfig;
  return { root, source, config };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("single-owner shared authentication", () => {
  it("returns only external access credentials and never rotates a usable session for readiness", async () => {
    const { source, config } = await fixture(); await writeFile(source, auth(now + 86_400_000), { mode: 0o600 });
    const refresh = vi.fn(); const provider = sharedAuthProvider(config, {}, { source, now: () => now, refresh })!;
    const tokens = await provider();
    expect(tokens).toMatchObject({ chatgptAccountId: "qa-account", chatgptPlanType: "business" });
    expect(JSON.stringify(tokens)).not.toContain("private-refresh-secret");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("coalesces expiry renewal across independent callers using the same filesystem lease", async () => {
    const { source, config } = await fixture(); await writeFile(source, auth(now - 1), { mode: 0o600 });
    const refresh = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 30)); await writeFile(source, auth(now + 86_400_000, "qa-account", "two"), { mode: 0o600 }); });
    const a = sharedAuthProvider(config, {}, { source, now: () => now, refresh })!;
    const b = sharedAuthProvider(config, {}, { source, now: () => now, refresh })!;
    const results = await Promise.all([a(), b(), a(), b()]);
    expect(refresh).toHaveBeenCalledOnce(); expect(new Set(results.map(x => x.accessToken)).size).toBe(1);
  });

  it("reuses a concurrent replacement after 401 and renews the rejected version only once", async () => {
    const { source, config } = await fixture(); await writeFile(source, auth(now + 86_400_000), { mode: 0o600 });
    const rejected = sharedAuthSnapshot(JSON.parse(await readFile(source, "utf8"))).tokens.accessToken;
    const refresh = vi.fn(async () => { await writeFile(source, auth(now + 86_400_000, "qa-account", "two"), { mode: 0o600 }); });
    const provider = sharedAuthProvider(config, {}, { source, now: () => now, refresh })!;
    await Promise.all([provider("qa-account", rejected), provider("qa-account", rejected)]);
    expect(refresh).toHaveBeenCalledOnce();
    await expect(provider("foreign-account", rejected)).rejects.toThrow("account changed");
  });

  it("fails closed for invalid credentials, unsafe sources and unverified renewal", async () => {
    const { root, source, config } = await fixture();
    await writeFile(source, auth(now - 1), { mode: 0o600 });
    const provider = sharedAuthProvider(config, {}, { source, now: () => now, refresh: async () => undefined })!;
    await expect(provider()).rejects.toThrow("not verified");
    await writeFile(source, "{}", { mode: 0o600 }); await expect(provider()).rejects.toThrow("invalid");
    const linked = path.join(root, "auth.json"); await symlink(source, linked);
    await expect(sharedAuthProvider(config, {}, { source: linked })!()).rejects.toThrow("escapes");
  });
});
