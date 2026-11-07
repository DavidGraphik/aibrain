import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({ entries: new Map<string, { content: string; changes?: Record<string, bigint>; symlink?: boolean }>(), reads: 0, onRead: undefined as (() => void) | undefined }));
vi.mock("server-only", () => ({}));
vi.mock("node:fs/promises", () => {
  const entry = (path: string) => {
    const value = files.entries.get(path);
    if (!value) throw new Error("missing synthetic protected file");
    return value;
  };
  const stat = (path: string) => ({
    isFile: () => true, isSymbolicLink: () => Boolean(entry(path).symlink),
    dev: 1n, ino: 2n, uid: 0n, gid: BigInt(process.getegid?.() ?? -1),
    mode: 0o100640n, nlink: 1n, size: BigInt(Buffer.byteLength(entry(path).content)),
    mtimeNs: 1n, ctimeNs: 1n, ...entry(path).changes,
  });
  return {
    realpath: async (path: string) => entry(path).symlink ? `${path}.target` : path,
    lstat: async (path: string) => stat(path),
    open: async (path: string) => {
      const captured = entry(path).content;
      return {
        stat: async () => stat(path), close: async () => undefined,
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const data = Buffer.from(captured).subarray(position, position + length);
          data.copy(buffer, offset); files.reads += 1; files.onRead?.();
          return { bytesRead: data.length };
        },
      };
    },
  };
});
import { assertPrivateOwnerSession, isPrivateOwnerAuthConfigured, PrivateOwnerIdentityProvider, PRIVATE_OWNER_LOGIN_PATH } from "@/auth/private-owner-identity-provider";
import { PERSONAL_MODEL_TEST_PATH } from "@/runtime/server-model-auth";

const identity = { installationId: "owner-private-test", userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const password = "Synthetic-private-test-123!";
const salt = Buffer.alloc(32, 17);
const hash = scryptSync(password, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
const owner = () => ({ schemaVersion: 1, installationId: identity.installationId, canonicalUserId: identity.userId, email: identity.email, salt: salt.toString("base64"), passwordHash: hash.toString("base64") });
const profile = () => ({ schemaVersion: 1, installationId: identity.installationId, canonicalUserId: identity.userId, createdAt: Date.now() - 1000, expiresAt: Date.now() + 60000 });
const set = (path: string, value: unknown) => files.entries.set(path, { content: JSON.stringify(value) });
const marker = vi.fn(async () => false);
const provider = () => new PrivateOwnerIdentityProvider(identity.installationId, { hasInitialPasswordMarker: marker });

beforeEach(() => {
  vi.stubEnv("AIBRAIN_AUTH_MODE", "private-owner"); vi.stubEnv("AIBRAIN_MODEL_AUTH", "personal-test");
  vi.stubEnv("AIBRAIN_CODEX_AUTH_SCOPE", "per-user"); vi.stubEnv("AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT", "/synthetic/private-broker");
  for (const name of ["AIBRAIN_SHARED_CODEX_AUTH_SOURCE", "AIBRAIN_CODEX_OWNER_AUTH_SOCKET", "AIBRAIN_INSTALLATION_OWNER_AUTH_ACK", "OPENAI_API_KEY", "CODEX_API_KEY"]) vi.stubEnv(name, "");
  vi.stubEnv("AIBRAIN_CODEX_TRANSPORT", "stdio");
  files.entries.clear(); files.reads = 0; files.onRead = undefined; marker.mockReset().mockResolvedValue(false);
  set(PRIVATE_OWNER_LOGIN_PATH, owner()); set(PERSONAL_MODEL_TEST_PATH, profile());
});
afterEach(() => vi.unstubAllEnvs());

describe("private owner login boundary", () => {
  it("verifies a real scrypt password and returns only the bound identity", async () => {
    expect(await provider().verifyPassword(identity.email.toUpperCase(), password)).toMatchObject({ userId: identity.userId, email: identity.email });
    await expect(assertPrivateOwnerSession(identity)).resolves.toBeUndefined();
  });
  it("uses the same public error for a wrong password and unknown email", async () => {
    for (const [email, candidate] of [[identity.email, "wrong"], ["unknown@example.test", password]]) {
      await expect(provider().verifyPassword(email, candidate)).rejects.toMatchObject({ code: "invalid_credentials", message: "Email or password is incorrect." });
    }
  });
  it.each(["supabase", "demo", ""])("does not enable private login in %s mode", async mode => {
    vi.stubEnv("AIBRAIN_AUTH_MODE", mode);
    expect(isPrivateOwnerAuthConfigured()).toBe(false);
    await expect(provider().verifyPassword(identity.email, password)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it.each(["server-api-key", "personal-codex"])("rejects model mode %s", async mode => {
    vi.stubEnv("AIBRAIN_MODEL_AUTH", mode);
    await expect(assertPrivateOwnerSession(identity)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it.each<Record<string, bigint>>([
    { uid: 1n }, { gid: BigInt(process.getegid?.() ?? -1) + 1n }, { mode: 0o100644n },
    { mode: 0o100660n }, { nlink: 2n }, { size: 4097n },
  ])("rejects unsafe credential metadata %#", async changes => {
    files.entries.get(PRIVATE_OWNER_LOGIN_PATH)!.changes = changes;
    await expect(assertPrivateOwnerSession(identity)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it.each(["symlink", "missing", "invalid-json", "unknown-key", "bad-base64", "foreign-installation", "foreign-email", "foreign-user"])("rejects %s credentials", async kind => {
    if (kind === "symlink") files.entries.get(PRIVATE_OWNER_LOGIN_PATH)!.symlink = true;
    if (kind === "missing") files.entries.delete(PRIVATE_OWNER_LOGIN_PATH);
    if (kind === "invalid-json") files.entries.get(PRIVATE_OWNER_LOGIN_PATH)!.content = "{";
    if (kind === "unknown-key") set(PRIVATE_OWNER_LOGIN_PATH, { ...owner(), N: 2 });
    if (kind === "bad-base64") set(PRIVATE_OWNER_LOGIN_PATH, { ...owner(), salt: `${owner().salt}\n` });
    if (kind === "foreign-installation") set(PRIVATE_OWNER_LOGIN_PATH, { ...owner(), installationId: "other" });
    if (kind === "foreign-email") set(PRIVATE_OWNER_LOGIN_PATH, { ...owner(), email: "other@example.test" });
    if (kind === "foreign-user") set(PRIVATE_OWNER_LOGIN_PATH, { ...owner(), canonicalUserId: "22222222-2222-4222-8222-222222222222" });
    await expect(assertPrivateOwnerSession(identity)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it.each(["expired", "removed", "foreign", "oversized-window"])("rechecks the %s personal profile on session access", async kind => {
    await assertPrivateOwnerSession(identity);
    if (kind === "removed") files.entries.delete(PERSONAL_MODEL_TEST_PATH);
    else set(PERSONAL_MODEL_TEST_PATH, { ...profile(), ...(kind === "expired" ? { expiresAt: Date.now() - 1 } : kind === "foreign" ? { canonicalUserId: "22222222-2222-4222-8222-222222222222" } : { expiresAt: Date.now() + 3 * 3600000 }) });
    await expect(assertPrivateOwnerSession(identity)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it("rejects replacement during a protected file read", async () => {
    files.onRead = () => { files.entries.get(PRIVATE_OWNER_LOGIN_PATH)!.changes = { ino: 3n }; };
    await expect(assertPrivateOwnerSession(identity)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it("rechecks the credential fingerprint after password derivation", async () => {
    marker.mockImplementationOnce(async () => { set(PRIVATE_OWNER_LOGIN_PATH, { ...owner(), email: "changed@example.test" }); return false; });
    await expect(provider().verifyPassword(identity.email, password)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it("refuses initial password markers and unsupported recovery/update", async () => {
    marker.mockResolvedValue(true);
    await expect(provider().verifyPassword(identity.email, password)).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(provider().requestPasswordRecovery(identity.email, "", "")).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(provider().updatePassword({ accessToken: "synthetic", refreshToken: "synthetic" }, password)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});
