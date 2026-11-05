import { beforeEach, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import { createInteractiveChatAuthorization } from "./interactive-chat-authorization";
import { handleOutlookDesktopDynamicToolCall, OUTLOOK_DESKTOP_DYNAMIC_TOOLS } from "./outlook-desktop-dynamic-tools";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ status: vi.fn(), execute: vi.fn(), read: vi.fn(), chunk: vi.fn() }));
vi.mock("@/connectors/outlook-desktop-service", () => ({ readOutlookDesktopStatusForIdentity: mocks.status, executeOutlookDesktopOperation: mocks.execute, readOutlookDesktopOperation: mocks.read }));
vi.mock("./outlook-desktop-files", () => ({ acceptOutlookDesktopChunk: mocks.chunk }));
const config = { installationId: "g03-production" } as InstallationConfig;
const context = { config, installationId: config.installationId, userId: "11111111-1111-4111-8111-111111111111", runtimeThreadId: "thread", runtimeTurnId: "turn", mailSelected: true,
  fileContext: { installation: config, storageOwnerId: "11111111-1111-4111-8111-111111111111", threadId: "local-thread", messageId: "message", projectId: "project" } };
const params = (tool: string, args: unknown = {}): DynamicToolCallParams => ({ namespace: "aibrain_outlook_desktop", tool, threadId: "thread", turnId: "turn", callId: "call", arguments: args as never });
const value = (result: Awaited<ReturnType<typeof handleOutlookDesktopDynamicToolCall>>) => JSON.parse((result.contentItems[0] as { text: string }).text);
function authorization() {
  return createInteractiveChatAuthorization({ session: { provider: "local", user: { id: context.userId, email: "user@g03.example", name: "User" }, tenant: { id: context.installationId, name: "G03" }, expiresAt: new Date(Date.now() + 60_000).toISOString() }, installationId: context.installationId, userId: context.userId, threadId: context.runtimeThreadId, turnId: context.runtimeTurnId, userMessageId: "human", message: "Save my draft", signal: new AbortController().signal, backgroundExecution: false, mode: "agent", localTurnId: "local", permissions: { installationId: context.installationId, userId: context.userId, turnId: "local", fingerprint: "a".repeat(64), rules: [{ ruleId: "tools.execute", action: "execute", effect: "allow", instruction: "Execute", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 0 }] } })!;
}
beforeEach(() => { vi.clearAllMocks(); mocks.status.mockResolvedValue({ status: "unpaired" }); mocks.execute.mockResolvedValue({ status: "succeeded", result: {} }); });
it("binds connector, tenant, current turn and private file owner before any service call", async () => {
  for (const patch of [{ mailSelected: false }, { installationId: "modtime" }, { runtimeTurnId: "foreign" }, { runtimeThreadId: "foreign" }, { fileContext: { ...context.fileContext, storageOwnerId: "foreign" } }]) expect((await handleOutlookDesktopDynamicToolCall(params("status"), { ...context, ...patch })).success).toBe(false);
  expect(mocks.status).not.toHaveBeenCalled();
  expect(value(await handleOutlookDesktopDynamicToolCall(params("status"), context))).toMatchObject({ status: "unpaired" });
});
it("refuses forged/background write authority and raw model-supplied binary before enqueue", async () => {
  for (const operation of ["mail.draft", "mail.send", "mail.organize", "folders.mutate", "contacts.mutate", "calendar.mutate"]) expect((await handleOutlookDesktopDynamicToolCall(params("execute", { operation, args: {} }), { ...context, chatAuthorization: {} as never })).success).toBe(false);
  const resolveAttachment = vi.fn();
  const result = await handleOutlookDesktopDynamicToolCall(params("execute", { operation: "mail.draft", args: { attachments: [{ filename: "fake.pdf", dataBase64: "ZmFrZQ==" }] } }), { ...context, chatAuthorization: authorization(), resolveAttachment });
  expect(result.success).toBe(false); expect(resolveAttachment).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
});
it("resolves only authorized original artifact/upload references and does not echo binary job arguments", async () => {
  const original = { filename: "original.pdf", contentType: "application/pdf", dataBase64: "cHJpdmF0ZS1vcmlnaW5hbA==" };
  const resolveAttachment = vi.fn(async () => original);
  mocks.execute.mockResolvedValue({ operation: "mail.draft", operationId: "job", status: "succeeded", args: { attachments: [original] }, result: { entryId: "draft", fingerprint: "a".repeat(64) } });
  const result = await handleOutlookDesktopDynamicToolCall(params("execute", { operation: "mail.draft", args: { attachments: [{ artifactId: "verified" }] } }), { ...context, chatAuthorization: authorization(), resolveAttachment });
  expect(result.success).toBe(true); expect(resolveAttachment).toHaveBeenCalledExactlyOnceWith({ artifactId: "verified" }); expect(JSON.stringify(result)).not.toContain(original.dataBase64);
  expect(mocks.execute.mock.calls[0][2]).toEqual({ attachments: [original] });
});
it("materializes pending attachment outcomes without binary in model text and never redispatches operation_status", async () => {
  const args = { storeId: "S", entryId: "E", index: 1, offset: 0 };
  mocks.read.mockResolvedValue({ operationId: "job", operation: "attachments.read", args, status: "succeeded", result: { dataBase64: "secret-original" } });
  mocks.chunk.mockResolvedValue({ complete: true, artifact: { id: "artifact" } });
  const onArtifact = vi.fn(async () => ({ relativePath: "outlook-originals/artifact/original.pdf" }));
  const result = await handleOutlookDesktopDynamicToolCall(params("operation_status", { operationId: "job" }), { ...context, onArtifact });
  expect(result.success).toBe(true); expect(mocks.chunk).toHaveBeenCalledWith(args, { dataBase64: "secret-original" }, context.fileContext); expect(onArtifact).toHaveBeenCalledOnce(); expect(mocks.execute).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("secret-original");
});
it("keeps unknown mutations explicit and sanitizes provider exceptions", async () => {
  mocks.read.mockResolvedValue({ status: "unknown", error: "OUTLOOK_DESKTOP_OUTCOME_UNKNOWN_DO_NOT_RETRY" });
  expect((await handleOutlookDesktopDynamicToolCall(params("operation_status", { operationId: "job" }), context)).success).toBe(false);
  mocks.status.mockRejectedValue(Error("private/token/email/body")); const result = await handleOutlookDesktopDynamicToolCall(params("status"), context); expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain("private/token");
  const descriptions = JSON.stringify(OUTLOOK_DESKTOP_DYNAMIC_TOOLS); expect(descriptions).toContain("before sending in David's name".replace("before", "Before")); expect(descriptions).toContain("never evidence that local history is absent");
});

it("keeps the advertised namespace within the app-server's 1024-character limit", () => {
  const namespace = OUTLOOK_DESKTOP_DYNAMIC_TOOLS[0];
  expect(namespace.type).toBe("namespace");
  if (namespace.type !== "namespace") throw Error("Expected Outlook namespace");
  // app-server rejects thread/start before any tool can run if this limit is exceeded.
  expect(namespace.description?.length).toBeGreaterThan(0);
  expect(namespace.description?.length).toBeLessThanOrEqual(1024);
});
