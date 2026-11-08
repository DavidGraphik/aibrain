import "server-only";
import type { AuthSession } from "@/auth/types";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { loadInstallationConfig } from "@/config/installation";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileConnectorBindingStore } from "./binding-store";
import type { ConnectorPrincipal } from "./contracts";
import { COMPANY_MAIL_CONNECTOR_ID, COMPANY_MAIL_SCOPES, CompanyMailError, parseCompanyMailCredential, type CompanyMailSnapshot } from "./company-mail-contracts";
import { companyMailEncryptionKey, FileCompanyMailStore } from "./company-mail-store";
import { companyMailClientOptions, withCompanyMailbox } from "./company-mail-client";

export async function companyMailContext(session: AuthSession) {
  const config = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== config.installationId) throw new CompanyMailError("MAIL_IDENTITY_MISMATCH", "La sesión no pertenece a esta instalación.", 403);
  const catalog = await catalogRuntimeEnforcer(config.installationId, session.user.id);
  if (!catalog.allowsConnector(COMPANY_MAIL_CONNECTOR_ID)) throw new CompanyMailError("MAIL_CATALOG_DENIED", "No tienes acceso a este conector.", 403);
  return { config, principal: { installationId: config.installationId, userId: session.user.id, roleId: null } satisfies ConnectorPrincipal };
}
export async function companyMailAccessForIdentity(config: Readonly<InstallationConfig>, userId: string) {
  if (!config.connectors?.companyMail?.enabled) throw new CompanyMailError("MAIL_NOT_ENABLED", "El correo no está habilitado.", 404);
  const catalog = await catalogRuntimeEnforcer(config.installationId, userId);
  if (!catalog.allowsConnector(COMPANY_MAIL_CONNECTOR_ID)) throw new CompanyMailError("MAIL_CATALOG_DENIED", "No tienes acceso a este conector.", 403);
  const store = new FileCompanyMailStore(config, companyMailEncryptionKey());
  const binding = await new FileConnectorBindingStore(config.installationId, config.paths.dataRoot).resolve({ installationId: config.installationId, userId, roleId: null }, COMPANY_MAIL_CONNECTOR_ID, { allowShared: false });
  if (binding.userId !== userId || binding.status !== "active") throw new CompanyMailError("MAIL_LOGIN_REQUIRED", "Conecta el buzón desde Ajustes.", 401);
  const credential = await store.read(userId, binding.credentialRef);
  companyMailClientOptions(config, credential);
  return { binding, credential, store };
}

export async function connectCompanyMail(session: AuthSession, input: unknown) {
  const { config, principal } = await companyMailContext(session);
  if (!config.connectors?.companyMail?.enabled) throw new CompanyMailError("MAIL_NOT_ENABLED", "El correo no está habilitado.", 404);
  const credential = parseCompanyMailCredential(input, config.connectors.companyMail.emailDomain);
  const store = new FileCompanyMailStore(config, companyMailEncryptionKey());
  return store.withUserLock(principal.userId, async () => {
    await withCompanyMailbox(config, credential, async () => undefined);
    // Recheck after the remote login, which may outlive a permission change.
    await companyMailContext(session);
    const bindings = new FileConnectorBindingStore(config.installationId, config.paths.dataRoot);
    const existing = await bindings.readPersonalForManagement(principal, COMPANY_MAIL_CONNECTOR_ID).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    const credentialRef = await store.put(principal.userId, credential);
    try {
      const binding = await bindings.put({ schemaVersion: 1, connectorId: COMPANY_MAIL_CONNECTOR_ID, credentialRef,
        installationId: config.installationId, userId: principal.userId, scopes: [...COMPANY_MAIL_SCOPES], status: "active", version: (existing?.version ?? 0) + 1 });
      if (existing) await store.clear(principal.userId, existing.credentialRef).catch(() => undefined);
      return { status: "connected", accountEmail: credential.email, connectionVersion: binding.version };
    } catch (error) { await store.clear(principal.userId, credentialRef); throw error; }
  });
}
export async function disconnectCompanyMail(session: AuthSession) {
  const { config, principal } = await companyMailContext(session);
  const store = new FileCompanyMailStore(config, companyMailEncryptionKey());
  return store.withUserLock(principal.userId, async () => {
    const bindings = new FileConnectorBindingStore(config.installationId, config.paths.dataRoot);
    const binding = await bindings.readPersonalForManagement(principal, COMPANY_MAIL_CONNECTOR_ID);
    if (binding.status !== "revoked") await bindings.revoke(principal, COMPANY_MAIL_CONNECTOR_ID, { allowShared: false, manageShared: false, expectedVersion: binding.version });
    await store.clear(principal.userId, binding.credentialRef);
    return { status: "revoked", localCredentialDeleted: true };
  });
}
export async function companyMailCapabilityForSession(session: AuthSession): Promise<CompanyMailSnapshot> {
  const { config } = await companyMailContext(session);
  const base = { connectorId: COMPANY_MAIL_CONNECTOR_ID, label: "Correo de empresa", effectiveOperations: [], approvalRequiredOperations: [], checkedAt: null,
    accountEmail: null, connectionVersion: null, connectUrl: "/api/connectors/company-mail/connect", disconnectUrl: null };
  if (!config.connectors?.companyMail?.enabled) return { ...base, status: "not_configured", statusCode: "MAIL_NOT_ENABLED", connectUrl: null };
  try {
    companyMailEncryptionKey();
    companyMailClientOptions(config, { email: `preflight@${config.connectors.companyMail.emailDomain}`, password: "unused", folder: "INBOX", since: "2026-01-01" });
  } catch { return { ...base, status: "not_configured", statusCode: "MAIL_ADMIN_SETUP_REQUIRED", connectUrl: null }; }
  try {
    const { credential, binding } = await companyMailAccessForIdentity(config, session.user.id);
    // The login is validated on connect and on each operation. Settings is a local
    // credential receipt, not a claim that the provider is currently reachable.
    return { ...base, status: "connected", statusCode: null, effectiveOperations: ["import_attachments", "journal", "record_review"], accountEmail: credential.email,
      connectionVersion: binding.version, disconnectUrl: "/api/connectors/company-mail/disconnect" };
  } catch { return { ...base, status: "reauth_required", statusCode: "MAIL_LOGIN_REQUIRED" }; }
}
