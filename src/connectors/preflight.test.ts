import { describe, expect, it } from "vitest";
import {
  CODEX_MANAGED_APP_CONNECTOR_ID,
  CODEX_MANAGED_APP_EXECUTE_SCOPE,
  CODEX_MANAGED_APP_READ_SCOPE,
} from "@/connectors/codex-managed-app-provider";
import {
  runCodexManagedAppPreflight,
  type CodexManagedAppPreflightDependencies,
} from "@/connectors/preflight";
import type { CredentialBinding } from "@/connectors/contracts";
import type { InstallationConfig } from "@/config/installation-schema";

const userId = "b2e0c2e8-0c4c-4db7-aeb7-f65c383b4690";
const installation: InstallationConfig = {
  schemaVersion: 1,
  installationId: "arnall",
  companyName: "Arnall",
  companySlug: "arnall",
  publicUrl: "https://arnall.example.test",
  branding: { productName: "Arnall", logoPath: "/logo.svg", faviconPath: "/favicon.ico", accentColor: "#123456" },
  paths: {
    dataRoot: "/var/lib/aibrain/arnall",
    companyContextRoot: "/var/lib/aibrain/arnall/company",
    usersRoot: "/var/lib/aibrain/arnall/users",
    sourceReadRoot: "/var/lib/aibrain/arnall/source",
    publishWriteRoot: "/var/lib/aibrain/arnall/publish",
    backupsRoot: "/var/lib/aibrain/arnall/backups",
  },
  connectors: {
    codexManagedAppAction: {
      appId: "approved-app",
      server: "action-server",
      tool: "action-tool",
      arguments: { safe: "fixed", nested: { safe: true } },
      correlationField: "id",
      readback: {
        server: "readback-server",
        tool: "readback-tool",
        arguments: { safe: "fixed" },
        correlationArgument: "id",
      },
    },
  },
};

function binding(overrides: Partial<CredentialBinding> = {}): CredentialBinding {
  return {
    schemaVersion: 1,
    connectorId: CODEX_MANAGED_APP_CONNECTOR_ID,
    credentialRef: "codex-app:approved-app",
    installationId: installation.installationId,
    userId,
    scopes: [CODEX_MANAGED_APP_READ_SCOPE, CODEX_MANAGED_APP_EXECUTE_SCOPE],
    status: "active",
    version: 1,
    ...overrides,
  };
}

function dependencies(overrides: Partial<CodexManagedAppPreflightDependencies> = {}): CodexManagedAppPreflightDependencies {
  return {
    loadInstallation: async () => installation,
    readLocalUser: async () => ({ enabled: true }),
    workspacePolicy: async () => ({ roleId: "workspace-member", execute: true }),
    resolveBinding: async () => binding(),
    inspectApp: async () => ({ status: "connected", code: null }),
    listMcpInventory: async () => [
      { name: "action-server", tools: ["action-tool"], authStatus: "oAuth" },
      { name: "readback-server", tools: ["readback-tool"], authStatus: "bearerToken" },
    ],
    ...overrides,
  };
}

describe("runCodexManagedAppPreflight", () => {
  it("reports ready only after all local, binding, app, action, and readback checks pass", async () => {
    const report = await runCodexManagedAppPreflight(userId, dependencies());

    expect(report).toEqual({
      schemaVersion: 1,
      ready: true,
      checks: {
        manifest: { ok: true, code: null }, localUser: { ok: true, code: null },
        executePolicy: { ok: true, code: null }, binding: { ok: true, code: null },
        app: { ok: true, code: null }, action: { ok: true, code: null }, readback: { ok: true, code: null },
      },
    });
  });

  it("fails closed when the fixed action manifest is absent", async () => {
    const report = await runCodexManagedAppPreflight(userId, dependencies({
      loadInstallation: async () => ({ ...installation, connectors: undefined }),
    }));

    expect(report.ready).toBe(false);
    expect(report.checks.manifest).toEqual({ ok: false, code: "CODEX_APP_ACTION_NOT_CONFIGURED" });
    expect(report.checks.app.code).toBe("PREFLIGHT_NOT_RUN");
  });

  it("rejects an unavailable, foreign, or revoked personal binding before app inspection", async () => {
    for (const candidate of [
      dependencies({ resolveBinding: async () => { throw new Error("missing"); } }),
      dependencies({ resolveBinding: async () => binding({ userId: "3b7f3b5a-8973-45b1-9577-2c7bb26ba650" }) }),
      dependencies({ resolveBinding: async () => binding({ credentialRef: "codex-app:another-app" }) }),
      dependencies({ resolveBinding: async () => binding({ status: "revoked" }) }),
    ]) {
      const report = await runCodexManagedAppPreflight(userId, candidate);
      expect(report.ready).toBe(false);
      expect(report.checks.binding.ok).toBe(false);
      expect(report.checks.app.code).toBe("PREFLIGHT_NOT_RUN");
    }
  });

  it("rejects execute policy denial and missing required scope", async () => {
    const denied = await runCodexManagedAppPreflight(userId, dependencies({
      workspacePolicy: async () => ({ roleId: "workspace-member", execute: false }),
    }));
    const missingScope = await runCodexManagedAppPreflight(userId, dependencies({
      resolveBinding: async () => binding({ scopes: [CODEX_MANAGED_APP_READ_SCOPE] }),
    }));

    expect(denied.checks.executePolicy).toEqual({ ok: false, code: "CODEX_APP_ACTION_PERMISSION_DENIED" });
    expect(missingScope.checks.binding).toEqual({ ok: false, code: "CODEX_APP_MINIMUM_SCOPE_MISSING" });
  });

  it("reports app degradation and missing action or readback server/tool inventory", async () => {
    const degraded = await runCodexManagedAppPreflight(userId, dependencies({
      inspectApp: async () => ({ status: "degraded", code: "CODEX_APP_DISABLED" }),
    }));
    const actionMissing = await runCodexManagedAppPreflight(userId, dependencies({
      listMcpInventory: async () => [{ name: "readback-server", tools: ["readback-tool"], authStatus: "oAuth" }],
    }));
    const readbackMissing = await runCodexManagedAppPreflight(userId, dependencies({
      listMcpInventory: async () => [{ name: "action-server", tools: ["action-tool"], authStatus: "oAuth" }],
    }));
    const toolsMissing = await runCodexManagedAppPreflight(userId, dependencies({
      listMcpInventory: async () => [
        { name: "action-server", tools: [], authStatus: "oAuth" },
        { name: "readback-server", tools: [], authStatus: "oAuth" },
      ],
    }));

    expect(degraded.checks.app).toEqual({ ok: false, code: "CODEX_APP_DISABLED" });
    expect(actionMissing.checks.action).toEqual({ ok: false, code: "MCP_ACTION_SERVER_UNAVAILABLE" });
    expect(readbackMissing.checks.readback).toEqual({ ok: false, code: "MCP_READBACK_SERVER_UNAVAILABLE" });
    expect(toolsMissing.checks.action).toEqual({ ok: false, code: "MCP_ACTION_TOOL_UNAVAILABLE" });
    expect(toolsMissing.checks.readback).toEqual({ ok: false, code: "MCP_READBACK_TOOL_UNAVAILABLE" });
  });

  it("fails closed when visible tools report notLoggedIn auth, including one shared action/readback server", async () => {
    const sharedServerInstallation: InstallationConfig = {
      ...installation,
      connectors: {
        codexManagedAppAction: {
          ...installation.connectors!.codexManagedAppAction!,
          readback: { ...installation.connectors!.codexManagedAppAction!.readback, server: "action-server" },
        },
      },
    };
    const report = await runCodexManagedAppPreflight(userId, dependencies({
      loadInstallation: async () => sharedServerInstallation,
      // Baseline before this correction: these visible tools made ready=true.
      listMcpInventory: async () => [{
        name: "action-server",
        tools: ["action-tool", "readback-tool"],
        authStatus: "notLoggedIn",
      }],
    }));

    expect(report.ready).toBe(false);
    expect(report.checks.action).toEqual({ ok: false, code: "MCP_ACTION_AUTH_UNAVAILABLE" });
    expect(report.checks.readback).toEqual({ ok: false, code: "MCP_READBACK_AUTH_UNAVAILABLE" });
  });

  it("accepts bearer, OAuth, and explicit no-auth support while rejecting unknown auth", async () => {
    const bearer = await runCodexManagedAppPreflight(userId, dependencies({
      listMcpInventory: async () => [
        { name: "action-server", tools: ["action-tool"], authStatus: "bearerToken" },
        { name: "readback-server", tools: ["readback-tool"], authStatus: "unsupported" },
      ],
    }));
    const unknown = await runCodexManagedAppPreflight(userId, dependencies({
      listMcpInventory: async () => [
        { name: "action-server", tools: ["action-tool"], authStatus: "unknown" },
        { name: "readback-server", tools: ["readback-tool"], authStatus: "oAuth" },
      ],
    }));

    expect(bearer.ready).toBe(true);
    expect(unknown.ready).toBe(false);
    expect(unknown.checks.action).toEqual({ ok: false, code: "MCP_ACTION_AUTH_UNAVAILABLE" });
  });

  it("never serializes binding, manifest arguments, names, or a provider secret into the operator artifact", async () => {
    const report = await runCodexManagedAppPreflight(userId, dependencies({
      resolveBinding: async () => binding({ credentialRef: "codex-app:top-secret-app", scopes: ["secret.scope", CODEX_MANAGED_APP_READ_SCOPE, CODEX_MANAGED_APP_EXECUTE_SCOPE] }),
      listMcpInventory: async () => [
        { name: "action-server", tools: ["action-tool"], authStatus: "oAuth" },
        { name: "readback-server", tools: ["readback-tool"], authStatus: "bearerToken" },
      ],
    }));
    const artifact = JSON.stringify(report);

    expect(artifact).not.toContain("top-secret");
    expect(artifact).not.toContain("approved-app");
    expect(artifact).not.toContain("action-server");
    expect(artifact).not.toContain("safe");
    expect(artifact).not.toContain("secret.scope");
    expect(artifact).not.toContain("oAuth");
    expect(artifact).not.toContain("bearerToken");
    expect(JSON.parse(artifact)).toEqual(report);
  });
});
