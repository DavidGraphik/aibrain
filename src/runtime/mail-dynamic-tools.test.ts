import { beforeEach, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import { handleMailDynamicToolCall, MAIL_DYNAMIC_TOOLS } from "./mail-dynamic-tools";
import { createInteractiveChatAuthorization } from "./interactive-chat-authorization";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), prepare: vi.fn(), send: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/connectors/mail-server-service", () => ({ executeMailOperation: mocks.execute, prepareMailSend: mocks.prepare, sendPreparedMail: mocks.send }));
const config = { installationId: "company-qa" } as InstallationConfig;
const context = { config, installationId: "company-qa", userId: "11111111-1111-4111-8111-111111111111", runtimeThreadId: "thread", runtimeTurnId: "turn", mailSelected: true, humanMessage: "Read my mail" };
const params: DynamicToolCallParams = { namespace: "aibrain_mail", tool: "list", threadId: "thread", turnId: "turn", callId: "call", arguments: {} };
beforeEach(() => { vi.clearAllMocks(); mocks.execute.mockResolvedValue({ messages: [] }); });
it("denies unavailable, foreign tenant/thread/turn and unknown tools before the connector runs", async () => {
  for (const ctx of [{ ...context, mailSelected: false }, { ...context, installationId: "foreign" }, { ...context, runtimeThreadId: "foreign" }, { ...context, runtimeTurnId: "foreign" }]) expect((await handleMailDynamicToolCall(params, ctx)).success).toBe(false);
  expect((await handleMailDynamicToolCall({ ...params, tool: "delete" }, context)).success).toBe(false); expect(mocks.execute).not.toHaveBeenCalled();
});
it("does not let tool booleans replace a legitimate current interactive identity for a mutation", async () => {
  for (const name of ["draft", "prepare_send", "send", "flags", "move"]) {
    expect((await handleMailDynamicToolCall({ ...params, tool: name, arguments: { confirm: true } }, context)).success).toBe(false);
    expect((await handleMailDynamicToolCall({ ...params, tool: name, arguments: {} }, { ...context, chatAuthorization: {} as never })).success).toBe(false);
  }
  expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
it("lets verified read calls use only the authenticated identity and does not leak a provider exception", async () => {
  expect((await handleMailDynamicToolCall(params, context)).success).toBe(true);
  expect(mocks.execute).toHaveBeenCalledWith({ config, userId: context.userId }, "list", {}, undefined, undefined);
  mocks.execute.mockRejectedValue(new Error("synthetic-private-secret"));
  const failure = await handleMailDynamicToolCall(params, context); expect(failure.success).toBe(false); expect(JSON.stringify(failure)).not.toContain("synthetic-private-secret");
});
it("dispatches a frozen message from the normal interactive task without a special human phrase or a model confirmation flag", async () => {
  const chatAuthorization = createInteractiveChatAuthorization({ session: { provider: "local", user: { id: context.userId, email: "employee@example.test", name: "Employee" }, tenant: { id: context.installationId, name: "Company" }, expiresAt: new Date(Date.now() + 60000).toISOString() }, installationId: context.installationId, userId: context.userId, threadId: context.runtimeThreadId, turnId: context.runtimeTurnId, userMessageId: "human-message", message: "Send this email to the client", signal: new AbortController().signal, backgroundExecution: false, mode: "agent", localTurnId: "local-turn", permissions: { installationId: context.installationId, userId: context.userId, turnId: "local-turn", fingerprint: "a".repeat(64), rules: [{ ruleId: "tools.execute", action: "execute", effect: "allow", instruction: "Execute tasks", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 0 }] } })!;
  const args = { previewId: "a".repeat(32), fingerprint: "b".repeat(64) };
  mocks.send.mockResolvedValue({ sent: true });
  expect((await handleMailDynamicToolCall({ ...params, tool: "send", arguments: args }, { ...context, humanMessage: undefined, chatAuthorization })).success).toBe(true);
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith(chatAuthorization, args.previewId, args.fingerprint, undefined);
  expect((await handleMailDynamicToolCall({ ...params, tool: "send", arguments: { ...args, confirm: true } }, { ...context, chatAuthorization })).success).toBe(false);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  const instructions = JSON.stringify(MAIL_DYNAMIC_TOOLS);
  expect(instructions).not.toContain("Enviar CODE"); expect(instructions).not.toContain("confirmation code");
  expect(instructions).toContain("before sending in David's name");
});


it("keeps the mail namespace within the app-server thread/start description limit", () => {
  const namespace = MAIL_DYNAMIC_TOOLS.find(tool => tool.type === "namespace");
  expect(namespace).toBeDefined();
  expect(namespace!.description.length).toBeLessThanOrEqual(1024);
  expect(namespace!.description).toContain("coverage.interrupted");
  for (const name of ["search", "list"]) {
    const tool = namespace!.tools.find(candidate => candidate.name === name);
    expect(tool?.description).toContain("coverage.interrupted");
    expect(tool?.description).toContain("stop automatic retries");
  }
});
