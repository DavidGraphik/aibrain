import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseInstallationConfig } from "@/config/installation-schema";
import { OUTLOOK_OAUTH_SCOPES } from "@/connectors/outlook-contracts";
import { FileOutlookOAuthStateStore, FileOutlookTokenStore } from "@/connectors/outlook-oauth-store";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const TENANT = "33333333-3333-4333-8333-333333333333";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); }, 60_000);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-outlook-oauth-")); roots.push(root);
  const dataRoot = path.join(root, "data"); const usersRoot = path.join(dataRoot, "users");
  for (const userId of [USER_A, USER_B]) await mkdir(path.join(usersRoot, userId), { recursive: true, mode: 0o700 });
  const config = parseInstallationConfig({ schemaVersion: 1, installationId: "company-qa", companyName: "Company", companySlug: "company", publicUrl: "https://brain.example", branding: { productName: "Company AI", logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#315ee7" }, paths: { dataRoot, companyContextRoot: path.join(dataRoot, "company-context"), usersRoot, sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(dataRoot, "backups") }, connectors: { outlook: { enabled: true, tenantId: TENANT } } });
  return { config };
}

describe("durable Outlook OAuth stores", () => {
  it("binds one-time PKCE state to the exact authenticated employee", async () => {
    const { config } = await fixture(); const now = Date.parse("2026-08-30T08:00:00.000Z");
    const store = new FileOutlookOAuthStateStore(config, () => now);
    const created = await store.create(USER_A, "https://brain.example/api/connectors/outlook/oauth/callback");
    await expect(store.consume(USER_B, created.state)).rejects.toMatchObject({ code: "OUTLOOK_OAUTH_STATE_IDENTITY_MISMATCH" });
    await expect(store.consume(USER_A, created.state)).resolves.toMatchObject({ codeVerifier: created.codeVerifier });
    await expect(store.consume(USER_A, created.state)).rejects.toMatchObject({ code: "OUTLOOK_OAUTH_STATE_REPLAYED" });
  }, 90_000);

  it("encrypts each token under its user root and clears only the exact binding", async () => {
    const { config } = await fixture(); const store = new FileOutlookTokenStore(config, Buffer.alloc(32, 9));
    const token = { accessToken: "access-token-value", refreshToken: "refresh-token-value", expiresAt: "2026-08-30T12:00:00.000Z", scopes: [...OUTLOOK_OAUTH_SCOPES], tokenType: "Bearer" as const };
    const stored = await store.put(USER_A, token);
    const file = path.join(config.paths.usersRoot, USER_A, "connectors", "outlook", "oauth-token.json");
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(token.accessToken); expect(raw).not.toContain(token.refreshToken);
    await expect(store.read(USER_B, stored.credentialRef)).rejects.toMatchObject({ code: "ENOENT" });
    await store.clear(USER_A, stored.credentialRef);
    await expect(store.read(USER_A, stored.credentialRef)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});
