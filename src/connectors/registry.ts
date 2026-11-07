import { assertBindingAccess, credentialBindingFingerprint } from "@/connectors/authorization";
import {
  CONNECTOR_ID_PATTERN,
  ConnectorError,
  type ConnectorCapabilitySnapshot,
  type ConnectorCredentialHandle,
  type ConnectorDefinition,
  type ConnectorPrincipal,
  type ConnectorProviderHealth,
  type CredentialBinding,
} from "@/connectors/contracts";
import type { FileConnectorBindingStore } from "@/connectors/binding-store";

export interface ConnectorCredentialProvider {
  inspect(input: {
    principal: ConnectorPrincipal;
    binding: CredentialBinding;
  }): Promise<{ handle: ConnectorCredentialHandle; health: ConnectorProviderHealth }>;
  revoke(input: {
    principal: ConnectorPrincipal;
    handle: ConnectorCredentialHandle;
  }): Promise<void>;
}

export type RegisteredConnector = {
  definition: ConnectorDefinition;
  credentialProvider: ConnectorCredentialProvider;
};

function validateDefinition(definition: ConnectorDefinition) {
  if (!CONNECTOR_ID_PATTERN.test(definition.id) || !definition.label.trim() || definition.operations.length === 0) {
    throw new ConnectorError("CONNECTOR_DEFINITION_INVALID", "Connector definition is invalid.");
  }
  const ids = new Set<string>();
  for (const operation of definition.operations) {
    if (!CONNECTOR_ID_PATTERN.test(operation.id) || ids.has(operation.id) || operation.requiredScopes.length === 0 ||
        (operation.mutating && operation.approval !== "required")) {
      throw new ConnectorError("CONNECTOR_DEFINITION_INVALID", "Connector operation definition is invalid.");
    }
    ids.add(operation.id);
  }
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "CONNECTOR_HEALTH_FAILED";
}

export class ConnectorRegistry {
  private readonly registrations = new Map<string, RegisteredConnector>();

  constructor(
    private readonly bindings: FileConnectorBindingStore,
    registrations: readonly RegisteredConnector[] = [],
  ) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: RegisteredConnector) {
    validateDefinition(registration.definition);
    if (this.registrations.has(registration.definition.id)) {
      throw new ConnectorError("CONNECTOR_ALREADY_REGISTERED", "Connector is already registered.");
    }
    this.registrations.set(registration.definition.id, registration);
  }

  definitions() {
    return [...this.registrations.values()].map(({ definition }) => definition);
  }

  async capabilities(
    principal: ConnectorPrincipal,
    options: { allowSharedCredentials: boolean },
  ): Promise<ConnectorCapabilitySnapshot[]> {
    return Promise.all([...this.registrations.values()].map(async (registration) => {
      const { definition, credentialProvider } = registration;
      let binding: CredentialBinding;
      try {
        binding = await this.bindings.resolve(principal, definition.id, {
          allowShared: options.allowSharedCredentials,
        });
      } catch (error) {
        if (errorCode(error) !== "CONNECTOR_BINDING_NOT_FOUND") throw error;
        return {
          connectorId: definition.id,
          label: definition.label,
          status: "not_configured",
          statusCode: "CONNECTOR_BINDING_NOT_FOUND",
          checkedAt: null,
          effectiveOperations: [],
          approvalRequiredOperations: [],
        } satisfies ConnectorCapabilitySnapshot;
      }

      assertBindingAccess(principal, binding, { allowShared: options.allowSharedCredentials });
      if (binding.status === "revoked" || binding.status === "reauth_required") {
        return {
          connectorId: definition.id,
          label: definition.label,
          status: binding.status === "revoked" ? "revoked" : "reauth_required",
          statusCode: binding.status === "revoked" ? "CONNECTOR_BINDING_REVOKED" : "CONNECTOR_REAUTH_REQUIRED",
          checkedAt: null,
          effectiveOperations: [],
          approvalRequiredOperations: [],
        } satisfies ConnectorCapabilitySnapshot;
      }

      try {
        const { handle, health } = await credentialProvider.inspect({ principal, binding });
        if (handle.bindingVersion !== binding.version ||
            handle.bindingFingerprint !== credentialBindingFingerprint(binding)) {
          throw new ConnectorError("CONNECTOR_HANDLE_BINDING_MISMATCH", "Credential provider returned a handle for another binding.");
        }
        const granted = new Set(binding.scopes);
        const operations = health.status === "connected"
          ? definition.operations.filter((operation) => operation.requiredScopes.every((scope) => granted.has(scope)))
          : [];
        return {
          connectorId: definition.id,
          label: definition.label,
          status: health.status,
          statusCode: health.code,
          checkedAt: health.checkedAt,
          effectiveOperations: operations.map((operation) => operation.id),
          approvalRequiredOperations: operations.filter((operation) => operation.approval === "required")
            .map((operation) => operation.id),
        } satisfies ConnectorCapabilitySnapshot;
      } catch (error) {
        return {
          connectorId: definition.id,
          label: definition.label,
          status: "degraded",
          statusCode: errorCode(error),
          checkedAt: new Date().toISOString(),
          effectiveOperations: [],
          approvalRequiredOperations: [],
        } satisfies ConnectorCapabilitySnapshot;
      }
    }));
  }

  async revoke(input: {
    principal: ConnectorPrincipal;
    connectorId: string;
    allowSharedCredential: boolean;
    manageSharedCredential: boolean;
    expectedVersion: number;
  }) {
    const registration = this.registrations.get(input.connectorId);
    if (!registration) {
      throw new ConnectorError("CONNECTOR_NOT_REGISTERED", "Connector is not registered.");
    }
    const binding = await this.bindings.resolve(input.principal, input.connectorId, {
      allowShared: input.allowSharedCredential,
    });
    let handle: ConnectorCredentialHandle | null = null;
    let providerErrorCode: string | null = null;
    try {
      const inspected = await registration.credentialProvider.inspect({
        principal: input.principal,
        binding,
      });
      if (inspected.handle.bindingVersion !== binding.version ||
          inspected.handle.bindingFingerprint !== credentialBindingFingerprint(binding)) {
        throw new ConnectorError("CONNECTOR_HANDLE_BINDING_MISMATCH", "Credential provider returned a handle for another binding.");
      }
      handle = inspected.handle;
    } catch (error) {
      providerErrorCode = errorCode(error);
    }

    // Block local use even when the provider is unavailable. A provider-side
    // revoke failure cannot leave the credential usable through AiBrain and is
    // reported explicitly for operator retry.
    const revoked = await this.bindings.revoke(input.principal, input.connectorId, {
      allowShared: input.allowSharedCredential,
      manageShared: input.manageSharedCredential,
      expectedVersion: input.expectedVersion,
    });
    if (!handle) {
      return { binding: revoked, providerRevoked: false, errorCode: providerErrorCode };
    }
    try {
      await registration.credentialProvider.revoke({ principal: input.principal, handle });
      return { binding: revoked, providerRevoked: true, errorCode: null };
    } catch (error) {
      return { binding: revoked, providerRevoked: false, errorCode: errorCode(error) };
    }
  }
}
