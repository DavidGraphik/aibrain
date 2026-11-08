import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, realpath, rm, readFile, mkdir } from "node:fs/promises";
import { createInteractiveChatAuthorization } from "@/runtime/interactive-chat-authorization";
import { themeHash } from "./shopify-theme-edit";
import { createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ config: vi.fn(), workspace: vi.fn(), catalog: vi.fn() }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.config }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: mocks.workspace }));
vi.mock("@/catalog/access-service", () => ({ catalogRuntimeEnforcer: mocks.catalog }));
import { FileLocalSessionStore } from "@/auth/local-session-store";
import { FileApprovalStore, waitForConnectorApproval } from "@/runtime/approval-store";
import { approvalResolutionForItem, isApprovalItem } from "@/lib/chat-contract";
import { POST as resolveApproval } from "@/app/api/runtime/approvals/route";
import { startThemeOAuth, completeThemeOAuth, readThemes, planThemeTitle, planThemeFile, prepareTitleApproval, executeThemeTitle, executeChatThemeEdit, THEMES_START, THEMES_CALLBACK } from "./shopify-themes-service";
import type { InstallationConfig } from "@/config/installation-schema";
import type { AuthSession } from "@/auth/types";
const actor = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222", secret = "test-theme-secret", clientId = "0123456789abcdef0123456789abcdef", origin = "https://brain.example";
const chatPermissions = { installationId: "modtime", userId: actor, turnId: "local-turn", fingerprint: "a".repeat(64), rules: [{ ruleId: "tools.execute", action: "execute" as const, effect: "allow" as const, instruction: "Execute authorized tools", sourceScope: "installation" as const, sourcePolicyVersion: 1, precedence: 0 }] };
let root: string, config: InstallationConfig, sessionId: string, content: string, writes: number, filename: string;
let returnedScopes: string[];
const session: AuthSession = { provider: "local", tenant: { id: "modtime", name: "MODTIME" }, user: { id: actor, name: "Test", email: "test@example.test" }, expiresAt: new Date(Date.now() + 86400000).toISOString() };
vi.mock("@/auth/session", () => ({ getSession: async () => session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: async () => true }));
vi.mock("@/operations/server-logger", () => ({ operationalLogger: { warn: vi.fn() } }));
const locator = { installationId: "modtime", userId: actor, threadId: "thread", turnId: "turn", itemId: "tool", approvalId: "theme-title:tool" };
const provider = vi.fn(async (url: unknown, options?: RequestInit) => {
  if (String(url).endsWith("access_token")) return Response.json({ access_token: "synthetic-theme-access", refresh_token: "synthetic-theme-refresh", scope: returnedScopes.join(","), expires_in: 3600, refresh_token_expires_in: 800000 });
  const { query, variables } = JSON.parse(options?.body as string);
  if (query.includes("currentAppInstallation")) return Response.json({ data: { shop: { myshopifyDomain: "c7f82c-f0.myshopify.com" }, currentAppInstallation: { accessScopes: returnedScopes.map(handle => ({ handle })) }, a: { id: "gid://shopify/OnlineStoreTheme/162490319097", name: "A", role: "UNPUBLISHED" }, b: { id: "gid://shopify/OnlineStoreTheme/188630040825", name: "B", role: "UNPUBLISHED" } } });
  if (query.startsWith("mutation")) { writes++; content = variables.files[0].body.value; return Response.json({ data: { themeFilesUpsert: { userErrors: [], upsertedThemeFiles: [{ filename }], job: null } } }); }
  return Response.json({ data: { theme: { id: variables.id, role: "UNPUBLISHED", files: { nodes: [{ filename, body: { content } }], pageInfo: { hasNextPage: false } } } } });
});
beforeEach(async () => {
  vi.clearAllMocks(); root = await realpath(await mkdtemp(path.join(os.tmpdir(), "themes-service-")));
  config = { installationId: "modtime", publicUrl: origin, paths: { dataRoot: root, usersRoot: path.join(root, "users") } } as InstallationConfig;
  await mkdir(path.join(config.paths.usersRoot, actor), { recursive: true, mode: 0o700 });
  mocks.config.mockResolvedValue(config); mocks.workspace.mockResolvedValue({ roleId: "admin", role: { canManageWorkspace: true }, policy: { capabilities: { execute: true } } }); mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => true });
  sessionId = (await new FileLocalSessionStore({ rootDirectory: path.join(root, "sessions") }).create("modtime", actor)).sessionId;
  for (const [key, value] of Object.entries({ MODTIME_SHOPIFY_THEMES_ENABLED: "1", MODTIME_SHOPIFY_THEME_USER_IDS: `${actor},${other}`, MODTIME_SHOPIFY_THEME_CLIENT_ID: clientId, MODTIME_SHOPIFY_THEME_CLIENT_SECRET: secret, MODTIME_SHOPIFY_THEME_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64") })) vi.stubEnv(key, value);
  filename = "layout/theme.liquid"; content = '<title>{{ page_title }}</title><h1>Visible title</h1>'; writes = 0;
  returnedScopes = ["read_themes", "write_themes"];
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function connect() {
  const started = new URL(await startThemeOAuth(session, sessionId, origin + THEMES_START));
  expect(started.searchParams.get("scope")).toBe("read_themes,write_themes"); expect(started.searchParams.get("client_id")).toBe(clientId);
  const p = new URLSearchParams({ shop: "c7f82c-f0.myshopify.com", state: started.searchParams.get("state")!, code: "synthetic-code", timestamp: String(Math.floor(Date.now() / 1000)) });
  p.set("hmac", createHmac("sha256", secret).update(new URLSearchParams([...p].sort(([a], [b]) => a.localeCompare(b))).toString().replace(/\+/g, "%20")).digest("hex"));
  const callback = origin + THEMES_CALLBACK + "?" + p;
  expect(await completeThemeOAuth(session, sessionId, callback, provider)).toMatchObject({ connected: true, writeVerified: false });
  await expect(completeThemeOAuth(session, sessionId, callback, provider)).rejects.toThrow("STATE_INVALID");
}
it("uses independent merchant OAuth, encrypts only the theme grant and binds real session/admin/catalog", async () => {
  await expect(startThemeOAuth(session, "invalid-session", origin + THEMES_START)).rejects.toThrow();
  mocks.workspace.mockResolvedValue({ role: { canManageWorkspace: false }, policy: { capabilities: { execute: true } } }); await expect(connect()).rejects.toThrow("ADMIN_REQUIRED");
  mocks.workspace.mockResolvedValue({ role: { canManageWorkspace: true }, policy: { capabilities: { execute: true } } }); await connect();
  const encrypted = await readFile(path.join(root, "connectors/shopify-themes/token.json"), "utf8"); expect(encrypted).not.toContain("synthetic-theme-access");
  await expect(readFile(path.join(root, "connectors/shopify-orders/token.json"))).rejects.toThrow();
});
it("reads a selected draft summary without a filename, then reads the actual homepage; malformed selectors do not reach Shopify", async () => {
  await connect();
  await expect(readThemes("modtime", actor, { themeId: "188630040825" }, provider)).resolves.toMatchObject({ themes: [{ id: "188630040825", name: "B", role: "UNPUBLISHED" }] });
  await expect(readThemes("modtime", actor, {}, provider)).resolves.toMatchObject({ themes: [{ id: "162490319097" }, { id: "188630040825" }] });
  await expect(readThemes("modtime", actor, { themeId: "188630040825", filename }, provider)).resolves.toMatchObject({ content, hash: themeHash(content) });
  provider.mockClear();
  for (const input of [{ filename }, { themeId: "162192523513" }, { themeId: "188630040825", extra: true }]) await expect(readThemes("modtime", actor, input, provider)).rejects.toThrow();
  expect(provider).not.toHaveBeenCalled(); expect(writes).toBe(0);
});
it("requires a durable human approval, verifies the exact title change and approved rollback", async () => {
  // Shopify can omit the implicit read scope from both token and installation grants.
  returnedScopes = ["write_themes"];
  await connect(); const original = content;
  const plan = await planThemeTitle("modtime", actor, "thread", { themeId: "162490319097", kind: "homepage_seo_title", filename: "layout/theme.liquid", expected: "{{ page_title }}", title: "New SEO" }, provider);
  const prepared = await prepareTitleApproval(locator, plan.planId, false);
  await expect(executeThemeTitle(locator, plan.planId, false, prepared.fingerprint, provider)).rejects.toThrow("APPROVAL_REQUIRED"); expect(writes).toBe(0);
  const approvals = new FileApprovalStore({ installationId: "modtime", userId: actor, usersRoot: config.paths.usersRoot });
  await approvals.approveConnectorApprovalByLocator(locator, prepared.fingerprint);
  expect(await executeThemeTitle(locator, plan.planId, false, prepared.fingerprint, provider)).toMatchObject({ status: "applied" }); expect(writes).toBe(1); expect(content).toContain("<h1>Visible title</h1>");
  const restoreLocator = { ...locator, turnId: "restore-turn", itemId: "restore-tool", approvalId: "restore-title:tool" };
  const restore = await prepareTitleApproval(restoreLocator, plan.planId, true); await approvals.approveConnectorApprovalByLocator(restoreLocator, restore.fingerprint);
  expect(await executeThemeTitle(restoreLocator, plan.planId, true, restore.fingerprint, provider)).toMatchObject({ status: "rolled_back" }); expect(content).toBe(original); expect(writes).toBe(2);
});
it.each([["read_themes"], ["write_themes", "write_orders"], ["write_themes", "write_themes"]])("rejects incomplete, broader or duplicate theme grants %j without saving credentials", async (...scopes) => {
  returnedScopes = scopes;
  await expect(connect()).rejects.toThrow("TOKEN_INVALID");
  await expect(readFile(path.join(root, "connectors/shopify-themes/token.json"))).rejects.toThrow();
  expect(writes).toBe(0);
});
it("denies wrong tenant/user/catalog and revoked execution before using the provider", async () => {
  for (const [tenant, user] of [["foreign", actor], ["modtime", "33333333-3333-4333-8333-333333333333"]]) await expect(readThemes(tenant, user, {}, provider)).rejects.toThrow("ACTOR_DENIED");
  mocks.catalog.mockResolvedValue({ allowsConnector: () => false, allowsConnectorWrite: () => false }); await expect(readThemes("modtime", actor, {}, provider)).rejects.toThrow("CATALOG_DENIED"); expect(provider).not.toHaveBeenCalled();
  mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => false });
  await expect(planThemeTitle("modtime", actor, "thread", { themeId: "162490319097", kind: "homepage_seo_title", filename: "layout/theme.liquid", expected: "{{ page_title }}", title: "New" }, provider)).rejects.toThrow("CATALOG_DENIED"); expect(provider).not.toHaveBeenCalled();
  mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => true }); mocks.workspace.mockResolvedValue({ roleId: "reader", role: {}, policy: { capabilities: { execute: false } } });
  await expect(planThemeTitle("modtime", actor, "thread", { themeId: "162490319097", kind: "homepage_seo_title", filename: "layout/theme.liquid", expected: "{{ page_title }}", title: "New" }, provider)).rejects.toThrow("EXECUTE_DENIED"); expect(provider).not.toHaveBeenCalled();
});

it("never turns a session-wide or cancelled card decision into a Shopify write", async () => {
  await connect();
  const plan = await planThemeTitle("modtime", actor, "thread", { themeId: "162490319097", kind: "homepage_seo_title", filename, expected: "{{ page_title }}", title: "Test" }, provider);
  const prepared = await prepareTitleApproval(locator, plan.planId, false);
  const approvals = new FileApprovalStore({ installationId: "modtime", userId: actor, usersRoot: config.paths.usersRoot });
  const response = await resolveApproval(new Request(origin + "/api/runtime/approvals", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(approvalResolutionForItem(prepared.item, "acceptForSession")) }));
  expect(response.status).toBe(200);
  expect(await waitForConnectorApproval(approvals, locator, prepared.fingerprint, new AbortController().signal)).toBe("decline");
  await expect(executeThemeTitle(locator, plan.planId, false, prepared.fingerprint, provider)).rejects.toThrow("APPROVAL_REQUIRED");
  const cancelled = { ...locator, approvalId: "cancelled", itemId: "cancelled" };
  const cancel = await prepareTitleApproval(cancelled, plan.planId, false), controller = new AbortController(); controller.abort();
  expect(await waitForConnectorApproval(approvals, cancelled, cancel.fingerprint, controller.signal)).toBe("cancel");
  await expect(executeThemeTitle(cancelled, plan.planId, false, cancel.fingerprint, provider)).rejects.toThrow("APPROVAL_REQUIRED");
  expect(writes).toBe(0);
});

it("binds the complete website-file review to human approval, saves video and restores the original", async () => {
  await connect(); filename = "templates/index.json";
  content = '{"sections":{"hero":{"type":"mariowatches-home","settings":{"hero_video":"shopify://files/videos/old.mp4"}}},"order":["hero"]}';
  const original = content, changes = [{ expected: "old.mp4", replacement: "new.mp4" }];
  const readback = await readThemes("modtime", actor, { themeId: "188630040825", filename }, provider);
  expect(readback).toMatchObject({ hash: themeHash(original) });
  const plan = await planThemeFile("modtime", actor, "thread", { themeId: "188630040825", filename, kind: "theme_file", beforeHash: themeHash(original), summary: "Replace the homepage video", changes }, provider);
  const prepared = await prepareTitleApproval(locator, plan.planId, false);
  expect(prepared.item.fileReview).toEqual({ filename, changes: [{ before: "old.mp4", after: "new.mp4" }] });
  await expect(executeThemeTitle(locator, plan.planId, false, prepared.fingerprint, provider)).rejects.toThrow("APPROVAL_REQUIRED");
  expect(writes).toBe(0);
  const approvals = new FileApprovalStore({ installationId: "modtime", userId: actor, usersRoot: config.paths.usersRoot });
  expect(isApprovalItem(prepared.item)).toBe(true);
  const waiting = waitForConnectorApproval(approvals, locator, prepared.fingerprint, new AbortController().signal);
  const request = (body: unknown) => new Request(origin + "/api/runtime/approvals", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // The real browser body and authenticated route must resolve the exact durable
  // connector record the runtime waits on; direct generic .resolve hid this bug.
  const body = approvalResolutionForItem(prepared.item, "accept");
  const missingFingerprint = { ...body } as Record<string, unknown>; delete missingFingerprint.authorizationFingerprint;
  expect((await resolveApproval(request(missingFingerprint))).status).toBe(403);
  expect((await resolveApproval(request(body))).status).toBe(200);
  expect(await waiting).toBe("accept");
  expect(await executeThemeTitle(locator, plan.planId, false, prepared.fingerprint, provider)).toMatchObject({ status: "applied" });
  expect(content).toBe(original.replace("old.mp4", "new.mp4"));
  const undo = { ...locator, approvalId: "undo", itemId: "undo", turnId: "undo" };
  const restore = await prepareTitleApproval(undo, plan.planId, true);
  expect(restore.item.fileReview?.changes).toEqual([{ before: "new.mp4", after: "old.mp4" }]);
  expect((await resolveApproval(request(approvalResolutionForItem(restore.item, "accept")))).status).toBe(200);
  expect(await executeThemeTitle(undo, plan.planId, true, restore.fingerprint, provider)).toMatchObject({ status: "rolled_back" });
  expect(content).toBe(original); expect(writes).toBe(2);
});

it("saves and undoes from an authenticated chat message without a card, keeps durable replay binding and never reapplies an undone edit", async () => {
  await connect(); vi.stubGlobal("fetch", provider);
  const { handleModtimeTool } = await import("@/runtime/modtime-dynamic-tools");
  const original = content, plan = await planThemeFile("modtime", actor, "async-thread", { themeId: "188630040825", filename, kind: "theme_file", beforeHash: themeHash(original), summary: "Change the heading", changes: [{ expected: "Visible title", replacement: "Test heading" }] }, provider);
  const controller = new AbortController();
  const authority = (turnId: string, message: string) => createInteractiveChatAuthorization({ session, installationId: "modtime", userId: actor, threadId: "async-thread", turnId, userMessageId: `message-${turnId}`, message, signal: controller.signal, backgroundExecution: false, mode: "agent", localTurnId: "local-turn", permissions: chatPermissions })!;
  const emitApproval = vi.fn();
  const ctx = { installationId: "modtime", userId: actor, runtimeThreadId: "async-thread", runtimeTurnId: "async-turn", selectedIds: ["modtime-shopify-themes"], chatAuthorization: authority("async-turn", "Change the website heading to Test heading"), signal: controller.signal, emitApproval };
  const call = { namespace: "modtime_business", tool: "shopify_theme_apply", threadId: ctx.runtimeThreadId, turnId: ctx.runtimeTurnId, callId: "async-call", arguments: { planId: plan.planId } };
  const response = await handleModtimeTool(call, ctx);
  expect(response.success).toBe(true);
  expect(JSON.parse(response.contentItems[0].type === "inputText" ? response.contentItems[0].text : "{}")).toMatchObject({ status: "applied", saved: true });
  expect(writes).toBe(1); expect(emitApproval).not.toHaveBeenCalled(); expect(content).toBe(original.replace("Visible title", "Test heading"));
  expect((await handleModtimeTool(call, ctx)).success).toBe(true); expect(writes).toBe(1);
  const otherPlan = await planThemeFile("modtime", actor, "async-thread", { themeId: "188630040825", filename, kind: "theme_file", beforeHash: themeHash(content), summary: "Another change", changes: [{ expected: "Test heading", replacement: "Another heading" }] }, provider);
  expect((await handleModtimeTool({ ...call, arguments: { planId: otherPlan.planId } }, ctx)).success).toBe(false); expect(writes).toBe(1);
  const undo = await handleModtimeTool({ ...call, tool: "shopify_theme_rollback", turnId: "undo-turn", callId: "undo-call" }, { ...ctx, runtimeTurnId: "undo-turn", chatAuthorization: authority("undo-turn", "Undo that change") });
  expect(undo.success).toBe(true); expect(content).toBe(original); expect(writes).toBe(2);
  expect((await handleModtimeTool(call, ctx)).success).toBe(false); expect(content).toBe(original); expect(writes).toBe(2);
  controller.abort();
  expect((await handleModtimeTool(call, ctx)).success).toBe(false); expect(writes).toBe(2);
});

it("chat execution still rejects forged authority, foreign plans, changed source, stale plans and revoked permissions", async () => {
  await connect();
  const plan = await planThemeTitle("modtime", actor, "thread", { themeId: "188630040825", kind: "homepage_seo_title", filename, expected: "{{ page_title }}", title: "New" }, provider);
  const authority = (overrides = {}) => createInteractiveChatAuthorization({ session, installationId: "modtime", userId: actor, threadId: "thread", turnId: "turn", userMessageId: "message", message: "Change homepage title to New", signal: new AbortController().signal, backgroundExecution: false, mode: "agent", localTurnId: "local-turn", permissions: chatPermissions, ...overrides })!;
  const authorized = authority();
  await expect(executeChatThemeEdit({ ...authorized }, "forged", plan.planId, false, provider)).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
  await expect(executeChatThemeEdit(authority({ threadId: "foreign" }), "foreign", plan.planId, false, provider)).rejects.toThrow("PLAN_DENIED");
  mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => false });
  await expect(executeChatThemeEdit(authorized, "revoked", plan.planId, false, provider)).rejects.toThrow("CATALOG_DENIED");
  mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => true });
  content += "merchant edit";
  await expect(executeChatThemeEdit(authorized, "conflict", plan.planId, false, provider)).rejects.toThrow("THEME_CHANGED_CONFLICT");
  content = content.replace("merchant edit", "");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 301000);
  await expect(executeChatThemeEdit(authorized, "expired", plan.planId, false, provider)).rejects.toThrow("PLAN_STALE");
  expect(writes).toBe(0);
});

it("never executes a declined asynchronous card or a mismatched fingerprint", async () => {
  await connect(); vi.stubGlobal("fetch", provider);
  const plan = await planThemeTitle("modtime", actor, "thread", { themeId: "162490319097", kind: "homepage_seo_title", filename, expected: "{{ page_title }}", title: "Test" }, provider);
  const loc = { ...locator, approvalId: "shopify-edit:denied" }, card = await prepareTitleApproval(loc, plan.planId, false);
  const request = (body: unknown) => new Request(origin + "/api/runtime/approvals", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await resolveApproval(request({ ...approvalResolutionForItem(card.item, "accept"), authorizationFingerprint: "b".repeat(64) }))).status).toBe(403);
  expect((await resolveApproval(request(approvalResolutionForItem(card.item, "decline")))).status).toBe(200);
  expect((await resolveApproval(request(approvalResolutionForItem(card.item, "accept")))).status).toBe(403); expect(writes).toBe(0);
});
