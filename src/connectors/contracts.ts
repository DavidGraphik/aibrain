export const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const INSTALLATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type ConnectorPrincipal = {
  installationId: string;
  userId: string;
  roleId: string | null;
};

export type CredentialBindingStatus = "active" | "reauth_required" | "revoked";

/**
 * Durable metadata only. credentialRef is an opaque provider reference and
 * must never be returned by an HTTP route, sent to Codex, or written to audit.
 */
export type CredentialBinding = {
  schemaVersion: 1;
  connectorId: string;
  credentialRef: string;
  installationId: string;
  userId: string | null;
  scopes: string[];
  status: CredentialBindingStatus;
  version: number;
};

export type ConnectorOperationDefinition = {
  id: string;
  requiredScopes: readonly string[];
  mutating: boolean;
  approval: "never" | "required";
};

export type ConnectorDefinition = {
  id: string;
  label: string;
  operations: readonly ConnectorOperationDefinition[];
};

export type ConnectorAuthorizationSnapshot = {
  schemaVersion: 1;
  principal: ConnectorPrincipal;
  connectorId: string;
  operation: string;
  resourceId: string | null;
  argsHash: string;
  permissionFingerprint: string;
  workspacePolicyFingerprint: string;
  credentialBindingFingerprint: string;
  mutating: boolean;
  preparedAt: string;
  expiresAt: string;
  authorizationFingerprint: string;
};

export type ConnectorHealthStatus =
  | "connected"
  | "degraded"
  | "reauth_required"
  | "revoked"
  | "not_configured";

export type ConnectorCredentialHandle = {
  handleId: string;
  bindingFingerprint: string;
  bindingVersion: number;
};

export type ConnectorProviderHealth = {
  status: Exclude<ConnectorHealthStatus, "not_configured">;
  checkedAt: string;
  code: string | null;
};

export type ConnectorCapabilitySnapshot = {
  connectorId: string;
  label: string;
  status: ConnectorHealthStatus;
  statusCode: string | null;
  checkedAt: string | null;
  effectiveOperations: string[];
  approvalRequiredOperations: string[];
};

export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ConnectorError";
  }
}
