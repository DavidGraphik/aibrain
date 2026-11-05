import { describe, expect, it } from "vitest";
import { projectPersonalConnectorSettings } from "@/settings/connector-settings";

const copy = {
  connected: "Cuenta verificada.",
  requiresLogin: "Disponible para conectar.",
  adminSetupRequired: "Disponible cuando el administrador complete OAuth.",
  unavailable: "No se puede comprobar ahora.",
};

function capability(status: "connected" | "reauth_required" | "not_configured" | "degraded") {
  return {
    connectorId: "gmail",
    label: "Gmail",
    status,
    statusCode: status === "not_configured" ? "GMAIL_GOOGLE_CLOUD_NOT_CONFIGURED" : null,
    checkedAt: null,
    effectiveOperations: status === "connected" ? ["search", "read"] : [],
    approvalRequiredOperations: [],
    accountEmail: status === "connected" ? "user@example.com" : null,
    connectionVersion: status === "connected" ? 2 : null,
    connectUrl: "/api/connectors/gmail/oauth/start",
    disconnectUrl: status === "connected" ? "/api/connectors/gmail/disconnect" : null,
  };
}

describe("personal connector settings", () => {
  it("distinguishes administrator OAuth setup from the employee login", () => {
    expect(projectPersonalConnectorSettings(capability("not_configured"), ["mail.read"], copy)).toMatchObject({
      status: "admin_setup_required",
      statusCode: "GMAIL_GOOGLE_CLOUD_NOT_CONFIGURED",
      statusDetail: "Disponible cuando el administrador complete OAuth.",
      connectUrl: null,
    });
    expect(projectPersonalConnectorSettings(capability("reauth_required"), ["mail.read"], copy)).toMatchObject({
      status: "requires_login",
      statusDetail: "Disponible para conectar.",
      connectUrl: "/api/connectors/gmail/oauth/start",
    });
  });

  it("exposes a connected personal binding without provider credentials", () => {
    const projected = projectPersonalConnectorSettings(capability("connected"), ["mail.read"], copy);
    expect(projected).toMatchObject({ status: "connected", accountEmail: "user@example.com", connectionVersion: 2, connectUrl: "/api/connectors/gmail/oauth/start" });
    expect(JSON.stringify(projected)).not.toMatch(/token|secret|credentialRef/i);
  });
});
