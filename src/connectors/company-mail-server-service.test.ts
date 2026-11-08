import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import type { AuthSession } from "@/auth/types";
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: vi.fn() }));
vi.mock("@/catalog/access-service", () => ({ catalogRuntimeEnforcer: vi.fn() }));
vi.mock("./company-mail-client", () => ({ companyMailClientOptions: vi.fn(), withCompanyMailbox: vi.fn() }));
import { loadInstallationConfig } from "@/config/installation";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { withCompanyMailbox } from "./company-mail-client";
import { connectCompanyMail, companyMailAccessForIdentity, companyMailCapabilityForSession, disconnectCompanyMail } from "./company-mail-server-service";
import { FileCompanyMailStore, companyMailEncryptionKey } from "./company-mail-store";
import { CompanyMailError } from "./company-mail-contracts";
const userId = "00000000-0000-4000-8000-000000000001";
const session = { provider: "local", tenant: { id: "company-qa" }, user: { id: userId } } as AuthSession;
const credential = { email: "billing@example-company.invalid", password: "test-private-password", folder: "INBOX", since: "2026-10-01" };
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mail-binding-")); roots.push(root);
  const config = { installationId: "company-qa", paths: { dataRoot: root }, connectors: { companyMail: { enabled: true, host: "imap.example-company.invalid", emailDomain: "example-company.invalid" } } } as InstallationConfig;
  vi.mocked(loadInstallationConfig).mockResolvedValue(config);
  vi.mocked(catalogRuntimeEnforcer).mockResolvedValue({ allowsConnector: () => true } as unknown as Awaited<ReturnType<typeof catalogRuntimeEnforcer>>);
  vi.stubEnv("AIBRAIN_COMPANY_MAIL_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.mocked(withCompanyMailbox).mockResolvedValue(undefined);
  return config;
}

describe("verified company mailbox connection lifecycle", () => {
  it("does not create a credential binding after failed provider login", async () => {
    const config = await setup();
    vi.mocked(withCompanyMailbox).mockRejectedValueOnce(new CompanyMailError("MAIL_LOGIN_REQUIRED", "Reconnect"));
    await expect(connectCompanyMail(session, credential)).rejects.toMatchObject({ code: "MAIL_LOGIN_REQUIRED" });
    await expect(companyMailAccessForIdentity(config, userId)).rejects.toMatchObject({ code: "CONNECTOR_BINDING_NOT_FOUND" });
    expect(await companyMailCapabilityForSession(session)).toMatchObject({ status: "reauth_required", accountEmail: null });
  });
  it("rotates references on reconnect, advances binding versions and revokes before removing the credential", async () => {
    const config = await setup();
    expect(await connectCompanyMail(session, credential)).toMatchObject({ connectionVersion: 1, accountEmail: credential.email });
    const before = await companyMailAccessForIdentity(config, userId);
    expect(before.credential.password).toBe(credential.password);
    expect(await connectCompanyMail(session, { ...credential, password: "new-private-password" })).toMatchObject({ connectionVersion: 2 });
    const after = await companyMailAccessForIdentity(config, userId);
    expect(after.binding.credentialRef).not.toBe(before.binding.credentialRef);
    await expect(new FileCompanyMailStore(config, companyMailEncryptionKey()).read(userId, before.binding.credentialRef)).rejects.toMatchObject({ code: "MAIL_CREDENTIAL_UNAVAILABLE" });
    expect(await disconnectCompanyMail(session)).toMatchObject({ status: "revoked" });
    await expect(companyMailAccessForIdentity(config, userId)).rejects.toMatchObject({ code: "MAIL_LOGIN_REQUIRED" });
    await expect(new FileCompanyMailStore(config, companyMailEncryptionKey()).read(userId, after.binding.credentialRef)).rejects.toMatchObject({ code: "MAIL_CREDENTIAL_UNAVAILABLE" });
    expect(await disconnectCompanyMail(session)).toMatchObject({ status: "revoked" });
  });
  it("rejects a foreign session and a catalog DENY before provider login", async () => {
    await setup();
    await expect(connectCompanyMail({ ...session, tenant: { ...session.tenant, id: "foreign" } }, credential)).rejects.toMatchObject({ code: "MAIL_IDENTITY_MISMATCH" });
    vi.mocked(catalogRuntimeEnforcer).mockResolvedValue({ allowsConnector: () => false } as unknown as Awaited<ReturnType<typeof catalogRuntimeEnforcer>>);
    await expect(connectCompanyMail(session, credential)).rejects.toMatchObject({ code: "MAIL_CATALOG_DENIED" });
    expect(withCompanyMailbox).not.toHaveBeenCalled();
  });
});
