import {
  CONNECTOR_ID_PATTERN,
  FINGERPRINT_PATTERN,
  INSTALLATION_ID_PATTERN,
  USER_ID_PATTERN,
  ConnectorError,
  type ConnectorAuthorizationSnapshot,
  type ConnectorDefinition,
  type ConnectorPrincipal,
  type CredentialBinding,
} from "@/connectors/contracts";
import { connectorFingerprint } from "@/connectors/canonical";

const DEFAULT_TTL_MS = 2 * 60_000;

export function credentialBindingFingerprint(binding: CredentialBinding) {
  return connectorFingerprint(binding);
}

export function assertConnectorPrincipal(principal: ConnectorPrincipal) {
  if (!INSTALLATION_ID_PATTERN.test(principal.installationId) ||
      !USER_ID_PATTERN.test(principal.userId) ||
      (principal.roleId !== null && !CONNECTOR_ID_PATTERN.test(principal.roleId))) {
    throw new ConnectorError("CONNECTOR_PRINCIPAL_INVALID", "Connector principal is invalid.");
  }
}

export function assertBindingAccess(
  principal: ConnectorPrincipal,
  binding: CredentialBinding,
  options: { allowShared: boolean },
) {
  assertConnectorPrincipal(principal);
  if (binding.installationId !== principal.installationId) {
    throw new ConnectorError("CONNECTOR_BINDING_INSTALLATION_MISMATCH", "Credential binding belongs to another installation.");
  }
  if (binding.userId === null) {
    if (!options.allowShared) {
      throw new ConnectorError("CONNECTOR_SHARED_BINDING_DENIED", "Shared credential binding is not allowed for this request.");
    }
  } else if (binding.userId !== principal.userId) {
    throw new ConnectorError("CONNECTOR_BINDING_USER_MISMATCH", "Credential binding belongs to another user.");
  }
}

function operationFor(definition: ConnectorDefinition, operationId: string) {
  const operation = definition.operations.find((candidate) => candidate.id === operationId);
  if (!operation) {
    throw new ConnectorError("CONNECTOR_OPERATION_UNKNOWN", "Connector operation is not registered.");
  }
  return operation;
}

function assertFingerprint(value: string, field: string) {
  if (!FINGERPRINT_PATTERN.test(value)) {
    throw new ConnectorError("CONNECTOR_AUTHORIZATION_INVALID", `${field} is not a SHA-256 fingerprint.`);
  }
}

export function prepareConnectorAuthorization(input: {
  principal: ConnectorPrincipal;
  definition: ConnectorDefinition;
  binding: CredentialBinding;
  operation: string;
  resourceId: string | null;
  args: unknown;
  permissionFingerprint: string;
  workspacePolicyFingerprint: string;
  allowSharedCredential: boolean;
  now?: () => number;
  ttlMs?: number;
}): ConnectorAuthorizationSnapshot {
  assertBindingAccess(input.principal, input.binding, { allowShared: input.allowSharedCredential });
  if (input.definition.id !== input.binding.connectorId) {
    throw new ConnectorError("CONNECTOR_BINDING_CONNECTOR_MISMATCH", "Credential binding does not belong to this connector.");
  }
  if (input.binding.status !== "active") {
    throw new ConnectorError("CONNECTOR_BINDING_INACTIVE", "Credential binding is not active.");
  }
  const operation = operationFor(input.definition, input.operation);
  const granted = new Set(input.binding.scopes);
  if (operation.requiredScopes.some((scope) => !granted.has(scope))) {
    throw new ConnectorError("CONNECTOR_SCOPE_MISSING", "Credential binding does not grant the operation's minimum scopes.");
  }
  assertFingerprint(input.permissionFingerprint, "permissionFingerprint");
  assertFingerprint(input.workspacePolicyFingerprint, "workspacePolicyFingerprint");
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 5 * 60_000) {
    throw new ConnectorError("CONNECTOR_AUTHORIZATION_INVALID", "Authorization TTL is invalid.");
  }
  const now = input.now ?? Date.now;
  const preparedAt = new Date(now()).toISOString();
  const bindingFingerprint = credentialBindingFingerprint(input.binding);
  const unsigned = {
    schemaVersion: 1 as const,
    principal: input.principal,
    connectorId: input.definition.id,
    operation: operation.id,
    resourceId: input.resourceId,
    argsHash: connectorFingerprint(input.args),
    permissionFingerprint: input.permissionFingerprint,
    workspacePolicyFingerprint: input.workspacePolicyFingerprint,
    credentialBindingFingerprint: bindingFingerprint,
    mutating: operation.mutating,
    preparedAt,
    expiresAt: new Date(new Date(preparedAt).valueOf() + ttlMs).toISOString(),
  };
  return { ...unsigned, authorizationFingerprint: connectorFingerprint(unsigned) };
}

export function assertAuthorizationFresh(
  snapshot: ConnectorAuthorizationSnapshot,
  binding: CredentialBinding,
  now: () => number = Date.now,
) {
  const { authorizationFingerprint, ...unsigned } = snapshot;
  if (connectorFingerprint(unsigned) !== authorizationFingerprint) {
    throw new ConnectorError("CONNECTOR_AUTHORIZATION_TAMPERED", "Connector authorization snapshot fingerprint does not match.");
  }
  if (new Date(snapshot.expiresAt).valueOf() <= now()) {
    throw new ConnectorError("CONNECTOR_AUTHORIZATION_EXPIRED", "Connector authorization snapshot has expired.");
  }
  if (binding.status !== "active" ||
      credentialBindingFingerprint(binding) !== snapshot.credentialBindingFingerprint) {
    throw new ConnectorError("CONNECTOR_BINDING_CHANGED", "Credential binding changed after authorization.");
  }
}
