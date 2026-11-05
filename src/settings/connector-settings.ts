import type { ConnectorCapabilitySnapshot } from "@/connectors/contracts";

export type PersonalConnectorSettings = {
  id: string;
  label: string;
  status: "connected" | "requires_login" | "admin_setup_required" | "unavailable";
  statusCode: string | null;
  statusDetail: string;
  accountEmail: string | null;
  scopes: string[];
  connectUrl: string | null;
  disconnectUrl: string | null;
  connectionVersion: number | null;
  /** Password connections submit locally; they must never be opened as OAuth links. */
  connectionMethod?: "password";
};

type PersonalConnectorCapability = ConnectorCapabilitySnapshot & {
  accountEmail: string | null;
  connectionVersion: number | null;
  connectUrl: string | null;
  disconnectUrl: string | null;
};

type ConnectorCopy = {
  connected: string;
  requiresLogin: string;
  adminSetupRequired: string;
  unavailable: string;
};

/**
 * Projects an already-authorized connector into employee-safe settings copy.
 * Authorization is deliberately resolved before this function is called: an
 * absent card means the installation/role catalog denied it, while this state
 * explains whether an authorized connector still needs administrator setup or
 * the employee's own OAuth login.
 */
export function projectPersonalConnectorSettings(
  capability: PersonalConnectorCapability,
  scopes: readonly string[],
  copy: ConnectorCopy,
): PersonalConnectorSettings {
  const status = capability.status === "connected"
    ? "connected" as const
    : capability.status === "reauth_required"
      ? "requires_login" as const
      : capability.status === "not_configured"
        ? "admin_setup_required" as const
        : "unavailable" as const;
  return {
    id: capability.connectorId,
    label: capability.label,
    status,
    statusCode: capability.statusCode,
    statusDetail: status === "connected"
      ? copy.connected
      : status === "requires_login"
        ? copy.requiresLogin
        : status === "admin_setup_required"
          ? copy.adminSetupRequired
          : copy.unavailable,
    accountEmail: capability.accountEmail,
    scopes: [...scopes],
    // Keep the OAuth start route available for an explicit reconnect. It uses
    // a fresh one-use state receipt and replaces only this user's binding.
    connectUrl: status === "admin_setup_required" ? null : capability.connectUrl,
    disconnectUrl: capability.disconnectUrl,
    connectionVersion: capability.connectionVersion,
  };
}
