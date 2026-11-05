import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthSession } from "@/auth/types";
import { createInteractiveChatAuthorization } from "@/runtime/interactive-chat-authorization";
import {
  ConnectorError,
  ConnectorRegistry,
  FileConnectorBindingStore,
  assertAuthorizationFresh,
  assertBindingAccess,
  credentialBindingFingerprint,
  prepareConnectorAuthorization,
  type ConnectorCredentialProvider,
  type ConnectorDefinition,
  type ConnectorPrincipal,
  type CredentialBinding,
} from "@/connectors";
import {
  CODEX_MANAGED_APP_CONNECTOR_ID,
  CODEX_MANAGED_APP_EXECUTE_SCOPE,
  CODEX_MANAGED_APP_READ_SCOPE,
  CodexManagedAppProvider,
  codexManagedAppDefinition,
} from "@/connectors/codex-managed-app-provider";
import { CodexManagedAppAction } from "@/connectors/codex-managed-app-action";
import { FileConnectorAuthorizationStore } from "@/connectors/authorization-store";
import { parseInstallationConfig, type CodexManagedAppActionConfig } from "@/config/installation-schema";
import { FileApprovalStore } from "@/runtime/approval-store";

const INSTALLATION_ID = "example-lab";
const USER_ONE = "00000000-0000-4000-8000-000000000001";
const USER_TWO = "00000000-0000-4000-8000-000000000002";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const roots: string[] = [];

const principal = (userId = USER_ONE): ConnectorPrincipal => ({
  installationId: INSTALLATION_ID,
  userId,
  roleId: "workspace-member",
});

const definition: ConnectorDefinition = {
  id: "google-drive",
  label: "Google Drive",
  operations: [
    { id: "read-file", requiredScopes: ["https://www.googleapis.com/auth/drive.file"], mutating: false, approval: "never" },
    { id: "create-file", requiredScopes: ["https://www.googleapis.com/auth/drive.file"], mutating: true, approval: "required" },
  ],
};

const binding = (overrides: Partial<CredentialBinding> = {}): CredentialBinding => ({
  schemaVersion: 1,
  connectorId: "google-drive",
  credentialRef: "vault://example-lab/users/user-one/google-drive",
  installationId: INSTALLATION_ID,
  userId: USER_ONE,
  scopes: ["https://www.googleapis.com/auth/drive.file"],
  status: "active",
  version: 1,
  ...overrides,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-connectors-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  return {
    root,
    dataRoot,
    store: new FileConnectorBindingStore(INSTALLATION_ID, dataRoot),
  };
}

class Provider implements ConnectorCredentialProvider {
  inspect = vi.fn(async ({ binding: current }: { principal: ConnectorPrincipal; binding: CredentialBinding }) => ({
    handle: {
      handleId: `handle:${current.connectorId}`,
      bindingFingerprint: credentialBindingFingerprint(current),
      bindingVersion: current.version,
    },
    health: { status: "connected" as const, checkedAt: "2026-08-28T10:00:00.000Z", code: null },
  }));

  revoke = vi.fn(async () => undefined);
}

describe("connector credential bindings", () => {
  it("binds metadata to one installation/user and permits shared bindings only explicitly", async () => {
    const { dataRoot, store } = await fixture();
    await store.put(binding());

    await expect(store.resolve(principal(), "google-drive", { allowShared: false }))
      .resolves.toMatchObject({ userId: USER_ONE, status: "active" });
    await expect(store.resolve(principal(USER_TWO), "google-drive", { allowShared: false }))
      .rejects.toMatchObject({ code: "CONNECTOR_BINDING_NOT_FOUND" });
    expect(() => assertBindingAccess(principal(USER_TWO), binding(), { allowShared: false }))
      .toThrowError(expect.objectContaining({ code: "CONNECTOR_BINDING_USER_MISMATCH" }));

    const shared = binding({ userId: null, credentialRef: "vault://example-lab/shared/google-drive", version: 1 });
    await store.put(shared);
    await expect(store.resolve(principal(USER_TWO), "google-drive", { allowShared: false }))
      .rejects.toMatchObject({ code: "CONNECTOR_BINDING_NOT_FOUND" });
    await expect(store.resolve(principal(USER_TWO), "google-drive", { allowShared: true }))
      .resolves.toMatchObject({ userId: null });
    await expect(store.put(binding({ installationId: "other-company" })))
      .rejects.toMatchObject({ code: "CONNECTOR_BINDING_INSTALLATION_MISMATCH" });

    const stored = path.join(dataRoot, "connectors", "bindings", INSTALLATION_ID, USER_ONE, "google-drive.json");
    expect((await stat(stored)).mode & 0o777).toBe(0o600);
    expect(await readFile(stored, "utf8")).not.toContain("access_token");
    expect(await readFile(stored, "utf8")).not.toContain("refresh_token");
  });

  it("requires monotonic versions and exact authority to revoke shared credentials", async () => {
    const { store } = await fixture();
    await store.put(binding({ userId: null, credentialRef: "vault://example-lab/shared/google-drive" }));
    await expect(store.put(binding({ userId: null, credentialRef: "vault://example-lab/shared/google-drive" })))
      .rejects.toMatchObject({ code: "CONNECTOR_BINDING_VERSION_CONFLICT" });
    await expect(store.revoke(principal(), "google-drive", {
      allowShared: true,
      manageShared: false,
      expectedVersion: 1,
    })).rejects.toMatchObject({ code: "CONNECTOR_SHARED_BINDING_MANAGEMENT_DENIED" });
    await expect(store.revoke(principal(), "google-drive", {
      allowShared: true,
      manageShared: true,
      expectedVersion: 1,
    })).resolves.toMatchObject({ status: "revoked", version: 2 });
  });

  it("blocks a revoked personal binding and permits only the same user to version a reconnect", async () => {
    const { store } = await fixture();
    await store.put(binding());
    await expect(store.revoke(principal(), "google-drive", { allowShared: false, manageShared: false, expectedVersion: 1 }))
      .resolves.toMatchObject({ status: "revoked", version: 2 });
    await expect(store.resolve(principal(), "google-drive", { allowShared: false }))
      .resolves.toMatchObject({ status: "revoked", version: 2 });
    expect(() => prepareConnectorAuthorization({
      principal: principal(), definition, binding: binding({ status: "revoked", version: 2 }), operation: "read-file",
      resourceId: null, args: {}, permissionFingerprint: SHA_A, workspacePolicyFingerprint: SHA_B, allowSharedCredential: false,
    })).toThrowError(expect.objectContaining({ code: "CONNECTOR_BINDING_INACTIVE" }));
    await expect(store.readPersonalForManagement(principal(), "google-drive"))
      .resolves.toMatchObject({ userId: USER_ONE, status: "revoked", version: 2 });
    await expect(store.readPersonalForManagement(principal(USER_TWO), "google-drive"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.put(binding({ status: "active", version: 3 })))
      .resolves.toMatchObject({ status: "active", version: 3 });
  });
});

describe("connector authorization snapshots", () => {
  it("canonically binds identity, scopes, arguments and policy fingerprints", () => {
    const first = prepareConnectorAuthorization({
      principal: principal(),
      definition,
      binding: binding(),
      operation: "create-file",
      resourceId: null,
      args: { mimeType: "text/plain", name: "AiBrain connector acceptance.txt" },
      permissionFingerprint: SHA_A,
      workspacePolicyFingerprint: SHA_B,
      allowSharedCredential: false,
      now: () => Date.parse("2026-08-28T10:00:00.000Z"),
    });
    const reordered = prepareConnectorAuthorization({
      principal: principal(),
      definition,
      binding: binding(),
      operation: "create-file",
      resourceId: null,
      args: { name: "AiBrain connector acceptance.txt", mimeType: "text/plain" },
      permissionFingerprint: SHA_A,
      workspacePolicyFingerprint: SHA_B,
      allowSharedCredential: false,
      now: () => Date.parse("2026-08-28T10:00:00.000Z"),
    });
    expect(first.mutating).toBe(true);
    expect(first.argsHash).toBe(reordered.argsHash);
    expect(first.authorizationFingerprint).toBe(reordered.authorizationFingerprint);
    expect(first.authorizationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertAuthorizationFresh(first, binding(), () => Date.parse("2026-08-28T10:01:00.000Z")))
      .not.toThrow();
  });

  it("fails closed for cross-user, missing scope, expiry, tampering and binding rotation", () => {
    const base = {
      principal: principal(),
      definition,
      binding: binding(),
      operation: "read-file",
      resourceId: "drive-file-one",
      args: { fields: ["id", "name"] },
      permissionFingerprint: SHA_A,
      workspacePolicyFingerprint: SHA_B,
      allowSharedCredential: false,
      now: () => Date.parse("2026-08-28T10:00:00.000Z"),
    };
    expect(() => prepareConnectorAuthorization({ ...base, principal: principal(USER_TWO) }))
      .toThrowError(expect.objectContaining({ code: "CONNECTOR_BINDING_USER_MISMATCH" }));
    expect(() => prepareConnectorAuthorization({ ...base, binding: binding({ scopes: ["scope:unrelated"] }) }))
      .toThrowError(expect.objectContaining({ code: "CONNECTOR_SCOPE_MISSING" }));
    const snapshot = prepareConnectorAuthorization(base);
    expect(() => assertAuthorizationFresh(snapshot, binding(), () => Date.parse("2026-08-28T10:03:00.000Z")))
      .toThrowError(expect.objectContaining({ code: "CONNECTOR_AUTHORIZATION_EXPIRED" }));
    expect(() => assertAuthorizationFresh({ ...snapshot, resourceId: "other-file" }, binding()))
      .toThrowError(expect.objectContaining({ code: "CONNECTOR_AUTHORIZATION_TAMPERED" }));
    expect(() => assertAuthorizationFresh(
      snapshot,
      binding({ version: 2 }),
      () => Date.parse("2026-08-28T10:01:00.000Z"),
    ))
      .toThrowError(expect.objectContaining({ code: "CONNECTOR_BINDING_CHANGED" }));
  });
});

describe("ConnectorRegistry", () => {
  it("shows only registered connectors and never advertises an unbound provider", async () => {
    const { store } = await fixture();
    const provider = new Provider();
    const empty = new ConnectorRegistry(store);
    expect(empty.definitions()).toEqual([]);
    await expect(empty.capabilities(principal(), { allowSharedCredentials: false })).resolves.toEqual([]);

    const registry = new ConnectorRegistry(store, [{ definition, credentialProvider: provider }]);
    const capabilities = await registry.capabilities(principal(), { allowSharedCredentials: false });
    expect(capabilities).toEqual([expect.objectContaining({
      connectorId: "google-drive",
      status: "not_configured",
      effectiveOperations: [],
    })]);
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(JSON.stringify(capabilities)).not.toContain("credentialRef");
    expect(JSON.stringify(capabilities)).not.toContain("vault://");
  });

  it("derives capabilities from binding scopes plus live provider health", async () => {
    const { store } = await fixture();
    await store.put(binding());
    const provider = new Provider();
    const registry = new ConnectorRegistry(store, [{ definition, credentialProvider: provider }]);
    await expect(registry.capabilities(principal(), { allowSharedCredentials: false }))
      .resolves.toEqual([expect.objectContaining({
        status: "connected",
        effectiveOperations: ["read-file", "create-file"],
        approvalRequiredOperations: ["create-file"],
      })]);
    expect(provider.inspect).toHaveBeenCalledTimes(1);

    provider.inspect.mockResolvedValueOnce({
      handle: {
        handleId: "wrong",
        bindingFingerprint: "c".repeat(64),
        bindingVersion: 1,
      },
      health: { status: "connected", checkedAt: "2026-08-28T10:00:00.000Z", code: null },
    });
    await expect(registry.capabilities(principal(), { allowSharedCredentials: false }))
      .resolves.toEqual([expect.objectContaining({
        status: "degraded",
        statusCode: "CONNECTOR_HANDLE_BINDING_MISMATCH",
        effectiveOperations: [],
      })]);
  });

  it("revokes locally before reporting an explicit provider revoke failure", async () => {
    const { store } = await fixture();
    await store.put(binding());
    const provider = new Provider();
    provider.revoke.mockRejectedValueOnce(new ConnectorError("PROVIDER_REVOKE_FAILED", "Provider unavailable."));
    const registry = new ConnectorRegistry(store, [{ definition, credentialProvider: provider }]);
    const result = await registry.revoke({
      principal: principal(),
      connectorId: "google-drive",
      allowSharedCredential: false,
      manageSharedCredential: false,
      expectedVersion: 1,
    });
    expect(result).toMatchObject({
      providerRevoked: false,
      errorCode: "PROVIDER_REVOKE_FAILED",
      binding: { status: "revoked", version: 2 },
    });
    await expect(registry.capabilities(principal(), { allowSharedCredentials: false }))
      .resolves.toEqual([expect.objectContaining({
        status: "revoked",
        effectiveOperations: [],
      })]);
  });
});

describe("Codex managed App connector", () => {
  const codexBinding = (overrides: Partial<CredentialBinding> = {}): CredentialBinding => ({
    schemaVersion: 1,
    connectorId: CODEX_MANAGED_APP_CONNECTOR_ID,
    credentialRef: "codex-app:app-arnall-files",
    installationId: INSTALLATION_ID,
    userId: USER_ONE,
    scopes: [CODEX_MANAGED_APP_READ_SCOPE],
    status: "active",
    version: 1,
    ...overrides,
  });

  it("reads only the installed-app snapshot and exposes no provider reference", async () => {
    const request = vi.fn(async () => ({ apps: [{ id: "app-arnall-files", enabled: true, callable: true }] }));
    const provider = new CodexManagedAppProvider(async () => ({ request }), () => Date.parse("2026-08-28T10:00:00.000Z"));
    const result = await provider.inspect({ principal: principal(), binding: codexBinding() });
    expect(request).toHaveBeenCalledWith(
      "app/installed",
      { forceRefresh: false },
      "connector-codex-app-list",
      10_000,
    );
    expect(result).toMatchObject({ health: { status: "connected", code: null }, handle: { bindingVersion: 1 } });
    expect(JSON.stringify(result)).not.toContain("credentialRef");
    expect(JSON.stringify(result)).not.toContain("codex-app:");
  });

  it("fails closed for missing scope, shared bindings and an unavailable App", async () => {
    const request = vi.fn(async () => ({ apps: [] }));
    const provider = new CodexManagedAppProvider(async () => ({ request }));
    await expect(provider.inspect({ principal: principal(), binding: codexBinding({ scopes: ["other.scope"] }) }))
      .rejects.toMatchObject({ code: "CONNECTOR_SCOPE_MISSING" });
    await expect(provider.inspect({ principal: principal(), binding: codexBinding({ userId: null }) }))
      .rejects.toMatchObject({ code: "CODEX_APP_SHARED_BINDING_DENIED" });
    await expect(provider.inspect({ principal: principal(), binding: codexBinding() }))
      .resolves.toMatchObject({ health: { status: "reauth_required", code: "CODEX_APP_NOT_INSTALLED" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never advertises the connector when Codex health is not connected", async () => {
    const { store } = await fixture();
    await store.put(codexBinding());
    const provider = new CodexManagedAppProvider(async () => ({
      request: async () => ({ apps: [{ id: "app-arnall-files", enabled: false, callable: false }] }),
    }));
    const registry = new ConnectorRegistry(store, [{ definition: codexManagedAppDefinition, credentialProvider: provider }]);
    await expect(registry.capabilities(principal(), { allowSharedCredentials: false }))
      .resolves.toEqual([expect.objectContaining({
        connectorId: CODEX_MANAGED_APP_CONNECTOR_ID,
        status: "degraded",
        statusCode: "CODEX_APP_DISABLED",
        effectiveOperations: [],
      })]);
  });
});

describe("Codex managed App action", () => {
  const config: CodexManagedAppActionConfig = {
    appId: "app-arnall-files",
    server: "arnall-erp",
    tool: "sync-confirmed-export",
    arguments: { mode: "approved" },
    correlationField: "executionId",
    readback: {
      server: "arnall-erp",
      tool: "read-sync-status",
      arguments: { detail: "status" },
      correlationArgument: "executionId",
    },
  };

  async function actionFixture(overrides: {
    binding?: Partial<CredentialBinding>;
    responses?: unknown[];
  } = {}) {
    const { root, dataRoot, store } = await fixture();
    const usersRoot = path.join(root, "users");
    await mkdir(path.join(usersRoot, USER_ONE), { recursive: true, mode: 0o700 });
    const approvals = new FileApprovalStore({ installationId: INSTALLATION_ID, userId: USER_ONE, usersRoot });
    await store.put({
      schemaVersion: 1,
      connectorId: CODEX_MANAGED_APP_CONNECTOR_ID,
      credentialRef: "codex-app:app-arnall-files",
      installationId: INSTALLATION_ID,
      userId: USER_ONE,
      scopes: [CODEX_MANAGED_APP_READ_SCOPE, CODEX_MANAGED_APP_EXECUTE_SCOPE],
      status: "active",
      version: 1,
      ...overrides.binding,
    });
    const responses = overrides.responses ?? [
      { apps: [{ id: "app-arnall-files", enabled: true, callable: true }] },
      { apps: [{ id: "app-arnall-files", enabled: true, callable: true }] },
      { structuredContent: { executionId: "execution-1" }, content: [] },
      { structuredContent: { executionId: "execution-1" }, content: [] },
    ];
    const request = vi.fn(async (..._requestArguments: unknown[]) => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    });
    const authorizations = new FileConnectorAuthorizationStore(INSTALLATION_ID, dataRoot);
    const action = new CodexManagedAppAction(
      store,
      authorizations,
      approvals,
      principal(),
      config,
      async () => ({ request } as never),
      SHA_A,
      SHA_B,
    );
    const locator = {
      installationId: INSTALLATION_ID,
      userId: USER_ONE,
      threadId: "thread-connector-action",
      turnId: "turn-connector-action",
      itemId: "item-connector-action",
      approvalId: "approval-connector-action",
    };
    return { action, approvals, authorizations, locator, request, dataRoot, bindings: store };
  }

  function chatContext() {
    const identity = { installationId: INSTALLATION_ID, userId: USER_ONE,
      threadId: "chat-thread", turnId: "chat-turn" };
    const userMessageId = "chat-message", message = "Run the configured export sync";
    const controller = new AbortController();
    const authorization = createInteractiveChatAuthorization({ ...identity, userMessageId, message,
      session: { tenant: { id: INSTALLATION_ID }, user: { id: USER_ONE },
        expiresAt: new Date(Date.now() + 3600000).toISOString() } as AuthSession,
      signal: controller.signal, backgroundExecution: false, mode: "agent", localTurnId: "local-turn",
      permissions: { installationId: INSTALLATION_ID, userId: USER_ONE, turnId: "local-turn", fingerprint: SHA_A,
        rules: [{ ruleId: "tools.execute", action: "execute", effect: "allow", instruction: "Execute requested tools",
          sourceScope: "installation", sourcePolicyVersion: 1, precedence: 0 }] },
    })!;
    return { authorization, threadId: identity.threadId, turnId: identity.turnId, userMessageId, message, controller };
  }

  it("executes the authenticated chat request once without a visible approval item and replays its durable result", async () => {
    const { action, approvals, request } = await actionFixture();
    const context = chatContext();
    const result = await action.executeFromChat(context);
    expect(result).toMatchObject({ outcome: "executed", value: { correlation: "execution-1" } });
    expect(await approvals.read(result.record!)).toBeNull();
    expect(await approvals.readEvents()).toHaveLength(0);
    await expect(action.executeFromChat(context)).resolves.toMatchObject({ outcome: "replayed" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("rejects copied authority, changed actor/turn/message/policy and cancellation before provider access", async () => {
    const { action, request } = await actionFixture();
    const context = chatContext();
    for (const patch of [{ authorization: undefined }, { authorization: { ...context.authorization } },
      { threadId: "foreign" }, { turnId: "foreign" }, { userMessageId: "foreign" }, { message: "Different action" }]) {
      await expect(action.executeFromChat({ ...context, ...patch })).rejects.toThrow();
    }
    context.controller.abort();
    await expect(action.executeFromChat(context)).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses changed allowlist and policy when recovering the same chat action", async () => {
    const f = await actionFixture();
    const context = chatContext();
    await f.action.executeFromChat(context);
    for (const [actionConfig, policy] of [[{ ...config, arguments: { mode: "changed" } }, SHA_A], [config, SHA_B]] as const) {
      const changed = new CodexManagedAppAction(f.bindings, f.authorizations, f.approvals, principal(), actionConfig,
        async () => ({ request: f.request } as never), policy, SHA_B);
      await expect(changed.executeFromChat(context)).rejects.toMatchObject({ code: "CODEX_APP_CHAT_AUTHORITY_MISMATCH" });
    }
    expect(f.request).toHaveBeenCalledTimes(4);
  });

  it("does not dispatch a chat action with missing scopes or another user's binding", async () => {
    for (const binding of [{ userId: USER_TWO }, { scopes: [CODEX_MANAGED_APP_READ_SCOPE] }]) {
      const f = await actionFixture({ binding });
      await expect(f.action.executeFromChat(chatContext())).rejects.toThrow();
      expect(f.request.mock.calls.some(([, params]) => (params as { tool?: string }).tool)).toBe(false);
    }
  });

  it("preserves indeterminate chat readback durably without repeating the side effect", async () => {
    const f = await actionFixture({ responses: [
      { apps: [{ id: "app-arnall-files", enabled: true, callable: true }] },
      { apps: [{ id: "app-arnall-files", enabled: true, callable: true }] },
      { structuredContent: { executionId: "chat-execution" } },
      { structuredContent: { executionId: "different-execution" } },
    ] });
    const context = chatContext();
    await expect(f.action.executeFromChat(context)).resolves.toMatchObject({ outcome: "indeterminate" });
    await expect(f.action.executeFromChat(context)).resolves.toMatchObject({ outcome: "indeterminate" });
    expect(f.request).toHaveBeenCalledTimes(4);
  });

  it("rechecks cancellation after acquiring the dispatch transport", async () => {
    const f = await actionFixture();
    const context = chatContext();
    let transportAcquisitions = 0;
    const action = new CodexManagedAppAction(f.bindings, f.authorizations, f.approvals, principal(), config,
      async () => {
        if (++transportAcquisitions === 3) context.controller.abort();
        return { request: f.request } as never;
      }, SHA_A, SHA_B);
    await expect(action.executeFromChat(context)).resolves.toMatchObject({ outcome: "indeterminate" });
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.some(([, params]) => (params as { tool?: string }).tool)).toBe(false);
  });

  it("dispatches at most once when duplicate chat tools race", async () => {
    const f = await actionFixture({ responses: [
      { apps: [{ id: "app-arnall-files", enabled: true, callable: true }] },
      { apps: [{ id: "app-arnall-files", enabled: true, callable: true }] },
      { apps: [{ id: "app-arnall-files", enabled: true, callable: true }] },
      { structuredContent: { executionId: "raced" } },
      { structuredContent: { executionId: "raced" } },
    ] });
    const context = chatContext();
    const results = await Promise.allSettled([f.action.executeFromChat(context), f.action.executeFromChat(context)]);
    expect(results.some(result => result.status === "fulfilled" && result.value.outcome === "executed")).toBe(true);
    expect(f.request.mock.calls.filter(([, params]) => (params as { tool?: string }).tool === "sync-confirmed-export")).toHaveLength(1);
  });

  it("runs the approved fixed action once and returns its durable readback without replaying the side effect", async () => {
    const { action, approvals, locator, request } = await actionFixture();
    const prepared = await action.prepare(locator);
    expect(prepared).toMatchObject({ operation: "execute-allowlisted-action", approval: { status: "pending" } });
    expect(JSON.stringify(prepared)).not.toContain("receipt");
    expect(JSON.stringify(prepared)).not.toContain("credentialRef");
    expect(JSON.stringify(prepared)).not.toContain("sync-confirmed-export");
    await expect(approvals.read(locator)).resolves.toMatchObject({ requestType: "connector", status: "pending" });
    await approvals.resolve(locator, "accept");
    await expect(action.execute(prepared)).resolves.toMatchObject({ outcome: "executed", value: { correlation: "execution-1" } });
    expect(request).toHaveBeenNthCalledWith(3, "mcpServer/tool/call", {
      threadId: locator.threadId,
      server: "arnall-erp",
      tool: "sync-confirmed-export",
      arguments: { mode: "approved" },
    }, "connector-codex-action", 10_000);
    expect(request).toHaveBeenNthCalledWith(4, "mcpServer/tool/call", {
      threadId: locator.threadId,
      server: "arnall-erp",
      tool: "read-sync-status",
      arguments: { detail: "status", executionId: "execution-1" },
    }, "connector-codex-readback", 10_000);
    await expect(action.execute(prepared)).resolves.toMatchObject({ outcome: "replayed" });
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.filter(([, parameters]) =>
      (parameters as { tool?: string }).tool === "sync-confirmed-export")).toHaveLength(1);
  });

  it("fails closed for another user and missing execute scope before calling a tool", async () => {
    const crossUser = await actionFixture({ binding: { userId: USER_TWO } });
    await expect(crossUser.action.prepare(crossUser.locator))
      .rejects.toMatchObject({ code: "CONNECTOR_BINDING_NOT_FOUND" });
    expect(crossUser.request).not.toHaveBeenCalled();

    const missingScope = await actionFixture({ binding: { scopes: [CODEX_MANAGED_APP_READ_SCOPE] } });
    await expect(missingScope.action.prepare(missingScope.locator))
      .rejects.toMatchObject({ code: "CONNECTOR_SCOPE_MISSING" });
    expect(missingScope.request).toHaveBeenCalledTimes(1);
  });

  it("marks a post-dispatch readback failure indeterminate and never re-dispatches after restart", async () => {
    const postDispatchFailure = await actionFixture({ responses: [
      { apps: [{ id: "app-arnall-files", enabled: true, callable: true }] },
      { apps: [{ id: "app-arnall-files", enabled: true, callable: true }] },
      { structuredContent: { executionId: "execution-2" }, content: [] },
      { structuredContent: {}, content: [] },
    ] });
    const prepared = await postDispatchFailure.action.prepare(postDispatchFailure.locator);
    await postDispatchFailure.approvals.resolve(postDispatchFailure.locator, "accept");
    await expect(postDispatchFailure.action.execute(prepared)).resolves.toMatchObject({ outcome: "indeterminate" });
    expect(await postDispatchFailure.approvals.readConnectorApproval(postDispatchFailure.locator))
      .toMatchObject({ status: "indeterminate" });
    expect(postDispatchFailure.request.mock.calls.filter(([, parameters]) =>
      (parameters as { tool?: string }).tool === "sync-confirmed-export")).toHaveLength(1);
    await expect(postDispatchFailure.action.execute(prepared)).resolves.toMatchObject({ outcome: "indeterminate" });
    expect(postDispatchFailure.request).toHaveBeenCalledTimes(4);
  });

  it("contains authorization snapshots under a real dataRoot and isolates user and installation paths", async () => {
    const { action, authorizations, locator, dataRoot } = await actionFixture();
    const descriptor = await action.prepare(locator);
    await expect(authorizations.read({ ...locator, userId: USER_TWO }, descriptor.authorizationFingerprint))
      .rejects.toMatchObject({ code: "CONNECTOR_AUTHORIZATION_NOT_FOUND" });
    await expect(new FileConnectorAuthorizationStore("other-lab", dataRoot).read(locator, descriptor.authorizationFingerprint))
      .rejects.toMatchObject({ code: "CONNECTOR_AUTHORIZATION_INSTALLATION_MISMATCH" });

    const userDirectory = path.join(dataRoot, "connectors", "authorizations", INSTALLATION_ID, USER_ONE);
    const outside = path.join(dataRoot, "outside");
    await mkdir(outside, { recursive: true, mode: 0o700 });
    await rm(userDirectory, { recursive: true, force: true });
    await symlink(outside, userDirectory);
    await expect(authorizations.read(locator, descriptor.authorizationFingerprint))
      .rejects.toMatchObject({ code: "CONNECTOR_AUTHORIZATION_PATH_UNSAFE" });
    await expect(action.prepare(locator))
      .rejects.toMatchObject({ code: "CONNECTOR_AUTHORIZATION_PATH_UNSAFE" });
  });
});

describe("installation action manifest secrets", () => {
  const manifest: CodexManagedAppActionConfig = {
    appId: "app-arnall-files", server: "arnall-erp", tool: "sync-confirmed-export", arguments: {}, correlationField: "executionId",
    readback: { server: "arnall-erp", tool: "read-sync-status", arguments: {}, correlationArgument: "executionId" },
  };
  const installation = (argumentsValue: Record<string, unknown>) => ({
    schemaVersion: 1, installationId: "example-lab", companyName: "Example", companySlug: "example-lab", publicUrl: "https://example.test",
    branding: { productName: "Example", logoPath: "/logo.svg", faviconPath: "/favicon.ico", accentColor: "#112233" },
    paths: { dataRoot: "/srv/example", companyContextRoot: "/srv/example/context", usersRoot: "/srv/example/users", sourceReadRoot: "/mnt/source", publishWriteRoot: "/mnt/publish", backupsRoot: "/srv/example/backups" },
    connectors: { codexManagedAppAction: { ...manifest, arguments: argumentsValue } },
  });

  it("rejects recursively normalized credential keys from static arguments", () => {
    for (const key of ["Authorization", "session_cookie", "db-password", "apiKey", "refresh_token", "nestedAccessToken"]) {
      expect(() => parseInstallationConfig(installation({ safe: { [key]: "redacted" } }))).toThrow(/credenciales/);
    }
  });
});
