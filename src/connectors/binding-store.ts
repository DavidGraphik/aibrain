import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertBindingAccess, credentialBindingFingerprint } from "@/connectors/authorization";
import {
  CONNECTOR_ID_PATTERN,
  INSTALLATION_ID_PATTERN,
  USER_ID_PATTERN,
  ConnectorError,
  type ConnectorPrincipal,
  type CredentialBinding,
} from "@/connectors/contracts";
import { atomicWriteJson } from "@/storage/atomic-file";
import { ResourceLockManager } from "@/storage/resource-lock";
import {
  ValidationContext,
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectOneOf,
  expectStrictRecord,
  expectString,
} from "@/storage/schema";

const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function expectOptionalUserId(value: unknown, context: ValidationContext) {
  return value === null ? null : expectString(value, context, {
    minLength: 36,
    maxLength: 36,
    pattern: USER_ID_PATTERN,
  });
}

export const credentialBindingSchema = defineVersionedSchema<CredentialBinding>({
  name: "CredentialBinding",
  schemaVersion: 1,
  keys: ["connectorId", "credentialRef", "installationId", "userId", "scopes", "status", "version"],
  parse(record, context) {
    const scopes = expectArray(record.scopes, context.at("scopes"), (value, item) =>
      expectString(value, item, { minLength: 1, maxLength: 256, pattern: SCOPE_PATTERN }),
    { maxLength: 64 });
    if (scopes.length === 0 || new Set(scopes).size !== scopes.length) {
      context.at("scopes").fail("must contain unique minimum scopes");
    }
    return {
      schemaVersion: 1,
      connectorId: expectString(record.connectorId, context.at("connectorId"), {
        minLength: 1,
        maxLength: 63,
        pattern: CONNECTOR_ID_PATTERN,
      }),
      credentialRef: expectString(record.credentialRef, context.at("credentialRef"), {
        minLength: 1,
        maxLength: 512,
        pattern: CREDENTIAL_REF_PATTERN,
      }),
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 1,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      userId: expectOptionalUserId(record.userId, context.at("userId")),
      scopes: [...scopes].sort(),
      status: expectOneOf(record.status, ["active", "reauth_required", "revoked"] as const, context.at("status")),
      version: expectInteger(record.version, context.at("version"), { minimum: 1 }),
    };
  },
});

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export class FileConnectorBindingStore {
  private readonly root: string;
  private readonly locks: ResourceLockManager;

  constructor(
    readonly installationId: string,
    dataRoot: string,
  ) {
    if (!INSTALLATION_ID_PATTERN.test(installationId) || !path.isAbsolute(dataRoot)) {
      throw new ConnectorError("CONNECTOR_STORE_OPTIONS_INVALID", "Connector binding store options are invalid.");
    }
    this.root = path.join(path.resolve(dataRoot), "connectors", "bindings", installationId);
    this.locks = new ResourceLockManager({
      rootDirectory: path.join(path.resolve(dataRoot), "connectors", "locks"),
      defaultTimeoutMs: 5_000,
    });
  }

  private bindingPath(connectorId: string, userId: string | null) {
    if (!CONNECTOR_ID_PATTERN.test(connectorId) ||
        (userId !== null && !USER_ID_PATTERN.test(userId))) {
      throw new ConnectorError("CONNECTOR_BINDING_ID_INVALID", "Connector binding identity is invalid.");
    }
    return path.join(this.root, userId ?? "shared", `${connectorId}.json`);
  }

  private async readExact(connectorId: string, userId: string | null) {
    const filePath = this.bindingPath(connectorId, userId);
    return credentialBindingSchema.parse(
      JSON.parse(await readFile(filePath, "utf8")) as unknown,
      filePath,
    );
  }

  async put(binding: CredentialBinding) {
    const parsed = credentialBindingSchema.parse(binding);
    if (parsed.installationId !== this.installationId) {
      throw new ConnectorError("CONNECTOR_BINDING_INSTALLATION_MISMATCH", "Credential binding belongs to another installation.");
    }
    const filePath = this.bindingPath(parsed.connectorId, parsed.userId);
    return this.locks.withLock(`connector-binding:${filePath}`, async () => {
      let existing: CredentialBinding | null = null;
      try {
        existing = await this.readExact(parsed.connectorId, parsed.userId);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (existing && parsed.version <= existing.version) {
        throw new ConnectorError("CONNECTOR_BINDING_VERSION_CONFLICT", "Credential binding version must increase.");
      }
      await atomicWriteJson(filePath, parsed, credentialBindingSchema, { mode: 0o600 });
      return parsed;
    });
  }

  async resolve(
    principal: ConnectorPrincipal,
    connectorId: string,
    options: { allowShared: boolean },
  ) {
    if (principal.installationId !== this.installationId) {
      throw new ConnectorError("CONNECTOR_BINDING_INSTALLATION_MISMATCH", "Principal belongs to another installation.");
    }
    try {
      const personal = await this.readExact(connectorId, principal.userId);
      assertBindingAccess(principal, personal, { allowShared: false });
      return personal;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (options.allowShared) {
      try {
        const shared = await this.readExact(connectorId, null);
        assertBindingAccess(principal, shared, { allowShared: true });
        return shared;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    throw new ConnectorError("CONNECTOR_BINDING_NOT_FOUND", "No credential binding is available for this principal.");
  }

  /** Reads only this user's exact binding, including a revoked record, so a
   * completed OAuth reconnect can advance its durable version. Never falls
   * back to a shared credential and never returns another user's record. */
  async readPersonalForManagement(principal: ConnectorPrincipal, connectorId: string) {
    if (principal.installationId !== this.installationId) {
      throw new ConnectorError("CONNECTOR_BINDING_INSTALLATION_MISMATCH", "Principal belongs to another installation.");
    }
    const binding = await this.readExact(connectorId, principal.userId);
    if (binding.installationId !== principal.installationId || binding.userId !== principal.userId) {
      throw new ConnectorError("CONNECTOR_BINDING_USER_MISMATCH", "Credential binding belongs to another user.");
    }
    return binding;
  }

  async revoke(
    principal: ConnectorPrincipal,
    connectorId: string,
    options: { allowShared: boolean; manageShared: boolean; expectedVersion: number },
  ) {
    const binding = await this.resolve(principal, connectorId, { allowShared: options.allowShared });
    if (binding.userId === null && !options.manageShared) {
      throw new ConnectorError("CONNECTOR_SHARED_BINDING_MANAGEMENT_DENIED", "Shared binding management is not allowed.");
    }
    const filePath = this.bindingPath(binding.connectorId, binding.userId);
    return this.locks.withLock(`connector-binding:${filePath}`, async () => {
      const current = await this.readExact(binding.connectorId, binding.userId);
      if (current.version !== options.expectedVersion ||
          credentialBindingFingerprint(current) !== credentialBindingFingerprint(binding)) {
        throw new ConnectorError("CONNECTOR_BINDING_VERSION_CONFLICT", "Credential binding changed before revocation.");
      }
      if (current.status === "revoked") return current;
      const revoked = credentialBindingSchema.parse({
        ...current,
        status: "revoked",
        version: current.version + 1,
      });
      await atomicWriteJson(filePath, revoked, credentialBindingSchema, { mode: 0o600 });
      return revoked;
    });
  }
}
