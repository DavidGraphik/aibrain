import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AuthSession } from "@/auth/types";
import type { ChatStreamEvent } from "@/lib/chat-contract";
import type { RuntimeStatus } from "@/lib/runtime-status";
import type { WorkbenchProject, WorkbenchSnapshot } from "@/workbench/types";
import type { PersonalConnectorSettings } from "@/settings/connector-settings";
import { describe, expect, it } from "vitest";
import { assertUiContract, uiContract, uiContractErrors } from "../helpers/ui-contract";

type RouteCatalog = {
  schemaVersion: number;
  operations: Record<string, string>;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const apiRoot = path.join(repositoryRoot, "src", "app", "api");
const routeCatalog = JSON.parse(await readFile(
  path.join(repositoryRoot, "contracts", "aibrain", "v1", "http-routes.json"),
  "utf8",
)) as RouteCatalog;

async function routeFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? routeFiles(target) : Promise.resolve([target]);
  }));
  return nested.flat().filter((file) => file.endsWith(`${path.sep}route.ts`));
}

async function exportedOperations() {
  const operations: string[] = [];
  for (const file of await routeFiles(apiRoot)) {
    const source = await readFile(file, "utf8");
    const route = `/${path.relative(path.join(repositoryRoot, "src", "app"), path.dirname(file))
      .split(path.sep)
      .map((segment) => segment.replace(/^\[([^\]]+)\]$/u, "{$1}"))
      .join("/")}`;
    for (const match of source.matchAll(
      /export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE)\b/gu,
    )) {
      operations.push(`${match[1]} ${route}`);
    }
  }
  return operations.sort();
}

describe("versioned AiBrain UI/backend contract", () => {
  it("permits only safe support-session provenance and rejects credential fields", () => {
    const session = {
      provider: "local", user: { id: "employee", name: "Employee", email: "employee@example.test" },
      tenant: { id: "company", name: "Company" }, expiresAt: "2026-10-18T21:30:00.000Z",
      support: { actorEmail: "operator@example.test", expiresAt: "2026-10-18T21:30:00.000Z" },
    };
    expect(() => assertUiContract("AuthSessionResponse", { session })).not.toThrow();
    for (const field of ["code", "sessionId", "operatorSecret", "sessionIdHash"]) {
      expect(uiContractErrors("AuthSessionResponse", { session: { ...session, support: { ...session.support, [field]: "private" } } })).not.toBeNull();
    }
  });
  it("keeps company-mail settings responses free of credentials and provider references", () => {
    const connected = { status: "connected", accountEmail: "invoices@example.test", connectionVersion: 1 };
    expect(uiContractErrors("CompanyMailConnectionResponse", connected)).toBeNull();
    for (const field of ["password", "credentialRef", "proxy", "ciphertext"]) {
      expect(uiContractErrors("CompanyMailConnectionResponse", { ...connected, [field]: "secret" })).not.toBeNull();
    }
  });

  it("matches every real Next API method and route exactly", async () => {
    expect(routeCatalog.schemaVersion).toBe(1);
    expect(await exportedOperations()).toEqual(Object.keys(routeCatalog.operations).sort());
  });

  it("references only declared response schemas or explicit binary transports", () => {
    for (const [operation, response] of Object.entries(routeCatalog.operations)) {
      if (response.startsWith("binary:")) {
        expect(response.slice("binary:".length), operation).not.toHaveLength(0);
        continue;
      }
      const schemaName = response.startsWith("stream:")
        ? response.slice("stream:".length)
        : response;
      expect(Object.hasOwn(uiContract.$defs, schemaName), `${operation}: ${schemaName}`).toBe(true);
    }
  });

  it("compiles the bundle and validates every published example", () => {
    expect(uiContract["x-examples"].length).toBeGreaterThan(0);
    for (const example of uiContract["x-examples"]) {
      expect(() => assertUiContract(example.schema, example.value), example.schema).not.toThrow();
    }
  });

  it("publishes bounded passive provenance without exposing a path to the original", () => {
    const provenance = {
      policy: "values-only-v1", originalFileName: "fixture.xls", originalSha256: "a".repeat(64), originalSize: 9728,
      sheetCount: 1, cellCount: 9, formulaCount: 3, missingFormulaCaches: 3, undecodedFormulas: 0, omittedSheets: 0, omittedStreams: 1,
    };
    expect(() => assertUiContract("LegacyExcelProvenance", provenance)).not.toThrow();
    expect(uiContractErrors("LegacyExcelProvenance", { ...provenance, originalPath: "/private/source.xls" })).not.toBeNull();
    expect(uiContractErrors("LegacyExcelProvenance", { ...provenance, cellCount: 500001 })).not.toBeNull();
    expect(uiContractErrors("LegacyExcelProvenance", { ...provenance, policy: "active" })).not.toBeNull();
  });

  it("distinguishes unavailable review data from an empty list and requires source versions", () => {
    const examples = uiContract["x-examples"];
    const listed = structuredClone(examples.find((item) => item.schema === "KnowledgeReviewGetResponse" &&
      (item.value as { available?: boolean }).available === true)!.value) as {
        available: boolean; records: Array<{ citations: Array<Record<string, unknown>>; correction?: object }>;
        scopes: Array<{ scope: string; scopeId: string | null }>;
      };
    expect(uiContractErrors("KnowledgeReviewGetResponse", listed)).toBeNull();
    expect(uiContractErrors("KnowledgeReviewGetResponse", { ...listed, available: false })).not.toBeNull();
    expect(uiContractErrors("KnowledgeReviewGetResponse", { ...listed, scopes: [{ scope: "private", scopeId: null, label: "Private", canReview: false }] })).not.toBeNull();
    delete listed.records[0].citations[0].sha256;
    expect(uiContractErrors("KnowledgeReviewGetResponse", listed)).not.toBeNull();
    expect(uiContractErrors("KnowledgeReviewPostResponse", { available: true, connectionId: "arnall" })).not.toBeNull();
  });

  it("keeps employee weekly percentages private and distinguishes unknown from zero", () => {
    const examples = uiContract["x-examples"].filter((item) => item.schema === "WeeklyTokenBudgetResponse");
    const uninitialized = structuredClone(examples.find((item) =>
      (item.value as { budget: { initialized?: boolean } | null }).budget?.initialized === false)!.value) as {
        budget: { initialized: boolean; remainingPercent: number | null; threshold: number };
      };
    for (const schema of ["WeeklyTokenBudgetResponse", "EmployeePersonalUsageResponse", "EmployeeCompanyUsageResponse"]) {
      expect(uiContractErrors(schema, { budget: null })).toBeNull();
      expect(uiContractErrors(schema, uninitialized)).toBeNull();
      expect(uiContractErrors(schema, { budget: { ...uninitialized.budget, remainingPercent: 0 } })).not.toBeNull();
      expect(uiContractErrors(schema, { budget: { ...uninitialized.budget, initialized: true } })).not.toBeNull();
      expect(uiContractErrors(schema, { budget: { ...uninitialized.budget, initialized: true, remainingPercent: 0, threshold: 100 } })).toBeNull();
      for (const field of ["usedTokens", "limitTokens", "remainingTokens", "percent", "sharedSubscription", "internal", "members"]) {
        expect(uiContractErrors(schema, { budget: { ...uninitialized.budget, [field]: 12 } }), field).not.toBeNull();
      }
    }
  });

  it("keeps representative TypeScript contracts compatible with JSON Schema", () => {
    const session = {
      provider: "local",
      user: { id: "employee-1", name: "Employee", email: "employee@example.test", avatarUrl: null },
      tenant: { id: "installation-1", name: "Example Company" },
      expiresAt: "2026-08-28T10:00:00.000Z",
    } satisfies AuthSession;
    const workbench = {
      persistence: "filesystem",
      projects: [],
      threads: [],
    } satisfies WorkbenchSnapshot;
    const viewerProject = {
      id: "10000000-0000-4000-8000-000000000001",
      name: "Proyecto compartido",
      slug: "proyecto-compartido",
      status: "active",
      pinned: false,
      instructions: "",
      sources: [],
      memory: { enabled: true, notes: "", updatedAt: null },
      sharing: { visibility: "shared", members: [] },
      workspace: {
        id: "20000000-0000-4000-8000-000000000001",
        label: "Proyecto compartido",
        hostType: "managed",
        status: "ready",
        isPrimary: true,
      },
      access: { role: "viewer", canEdit: false, canManage: false },
      createdAt: "2026-08-28T10:00:00.000Z",
      updatedAt: "2026-08-28T10:00:00.000Z",
    } satisfies WorkbenchProject;
    const runtime = {
      tenantId: "installation-1",
      projectId: null,
      projectName: "Example Company",
      mode: "codex",
      codex: "unavailable",
      isolated: true,
      ready: false,
      authMode: null,
      planType: null,
      processWarm: false,
      rateLimit: null,
      usage: null,
      workspaceName: "Example Company / workspace",
      model: null,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      models: [],
      skills: [],
      capabilities: { webSearch: false, imageInput: false, imageGeneration: false },
    } satisfies RuntimeStatus;
    const events = [
      { type: "delta", value: "chunk" },
      { type: "done" },
    ] satisfies ChatStreamEvent[];

    assertUiContract("AuthSessionResponse", { session });
    assertUiContract("WorkbenchResponse", { workbench });
    assertUiContract("WorkbenchProject", viewerProject);
    assertUiContract("RuntimeStatus", runtime);
    assertUiContract("RuntimeStatus", { ...runtime, authenticationRequired: true });
    expect(uiContractErrors("RuntimeStatus", { ...runtime, authenticationRequired: "true" })).not.toBeNull();
    for (const event of events) assertUiContract("ChatStreamEvent", event);
  });

  it("models personal password connection settings without broadening the existing OAuth contract", () => {
    const settings = { id: "mail", label: "Correo Nominalia", status: "requires_login", statusCode: "MAIL_LOGIN_REQUIRED", statusDetail: "Conecta tu cuenta de correo.", accountEmail: "employee@example.test", scopes: ["mail.read", "mail.write", "mail.send"], connectUrl: "/api/connectors/mail/connect", disconnectUrl: null, connectionVersion: null, connectionMethod: "password" } satisfies PersonalConnectorSettings;
    assertUiContract("PersonalConnectorSettings", settings);
    const { connectionMethod: _method, ...oauthSettings } = settings;
    assertUiContract("PersonalConnectorSettings", oauthSettings);
    for (const method of ["oauth", "provider-password", true, null]) expect(uiContractErrors("PersonalConnectorSettings", { ...settings, connectionMethod: method })).not.toBeNull();
    expect(uiContractErrors("PersonalConnectorSettings", { ...settings, password: "must-never-be-published" })).not.toBeNull();
    expect(uiContractErrors("PersonalConnectorSettings", { ...settings, connectionVersion: 0 })).not.toBeNull();
  });

  it("accepts the three real mail response shapes and safe errors while rejecting secrets and incomplete success", () => {
    expect(routeCatalog.operations["GET /api/connectors/mail/capability"]).toBe("MailCapabilityResponse");
    expect(routeCatalog.operations["POST /api/connectors/mail/connect"]).toBe("MailConnectResponse");
    expect(routeCatalog.operations["POST /api/connectors/mail/disconnect"]).toBe("MailDisconnectResponse");
    expect(uiContractErrors("MailCapabilityResponse", null)).toBeNull();
    const capability = uiContract["x-examples"].find(example => example.schema === "MailCapabilityResponse" && (example.value as { status?: string } | null)?.status === "connected")!.value as Record<string, unknown>;
    assertUiContract("MailCapabilityResponse", capability);
    assertUiContract("MailConnectResponse", { connected: true, accountEmail: "employee@example.test", connectionVersion: 1 });
    assertUiContract("MailDisconnectResponse", { status: "revoked" });
    for (const schema of ["MailCapabilityResponse", "MailConnectResponse", "MailDisconnectResponse"]) {
      for (const code of ["AUTH_REQUIRED", "ORIGIN_REQUIRED", "MAIL_AUTH_FAILED", "MAIL_RATE_LIMITED", "MAIL_REQUEST_FAILED"]) {
        expect(uiContractErrors(schema, { code })).toBeNull();
        expect(uiContractErrors(schema, { code, error: "No se ha podido completar la operación." })).toBeNull();
        expect(uiContractErrors(schema, { code, password: "must-never-be-published" })).not.toBeNull();
      }
    }
    for (const key of ["password", "credentialRef", "credentials", "token"]) expect(uiContractErrors("MailCapabilityResponse", { ...capability, [key]: "private" }), key).not.toBeNull();
    expect(uiContractErrors("MailCapabilityResponse", { ...capability, approvalRequiredOperations: ["send"] })).not.toBeNull();
    expect(uiContractErrors("MailConnectResponse", { connected: true, connectionVersion: 1 })).not.toBeNull();
    expect(uiContractErrors("MailConnectResponse", { connected: true, accountEmail: "employee@example.test", connectionVersion: 0 })).not.toBeNull();
    expect(uiContractErrors("MailDisconnectResponse", { status: "connected" })).not.toBeNull();
  });

  it("rejects provider and persistence values forbidden by the product boundary", () => {
    expect(uiContractErrors("AuthSession", {
      provider: "supabase",
      user: { id: "employee-1", name: "Employee", email: "employee@example.test" },
      tenant: { id: "installation-1", name: "Example Company" },
      expiresAt: "2026-08-28T10:00:00.000Z",
    })).not.toBeNull();
    expect(uiContractErrors("WorkbenchResponse", {
      workbench: { persistence: "supabase", projects: [], threads: [] },
    })).not.toBeNull();
    expect(uiContractErrors("ProjectAccess", {
      role: "viewer",
      canEdit: true,
      canManage: false,
    })).not.toBeNull();
  });
});
