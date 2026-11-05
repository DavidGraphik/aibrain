import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/connectors/server-service", () => ({ codexManagedAppActionForSession: vi.fn() }));
import type { AuthSession } from "@/auth/types";
import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import { codexManagedAppActionForSession } from "@/connectors/server-service";
import { createInteractiveChatAuthorization } from "./interactive-chat-authorization";
import { CONNECTED_ACTION_NAMESPACE, handleConnectedActionDynamicToolCall } from "./connected-action-dynamic-tools";

function fixture() {
  const identity = { installationId: "another-company", userId: "actor", threadId: "thread", turnId: "turn" };
  const session = { tenant: { id: identity.installationId }, user: { id: identity.userId },
    expiresAt: new Date(Date.now() + 3600000).toISOString() } as AuthSession;
  const fingerprint = "a".repeat(64);
  const context = { ...identity, session, userMessageId: "message", message: "Run the configured action",
    runtimeThreadId: identity.threadId, runtimeTurnId: identity.turnId, permissionFingerprint: fingerprint,
    backgroundExecution: false };
  const authorization = createInteractiveChatAuthorization({ ...context, signal: new AbortController().signal,
    mode: "agent", localTurnId: "local-turn", permissions: { ...identity, turnId: "local-turn", fingerprint,
      rules: [{ ruleId: "tools.execute", action: "execute", effect: "allow", instruction: "Execute tools",
        sourceScope: "installation", sourcePolicyVersion: 1, precedence: 0 }] } })!;
  const params = { namespace: CONNECTED_ACTION_NAMESPACE, tool: "execute", threadId: identity.threadId,
    turnId: identity.turnId, callId: "call", arguments: {} } as DynamicToolCallParams;
  return { context: { ...context, authorization }, params };
}

it("uses only the fixed action and current authenticated chat authority for any installation", async () => {
  const { context, params } = fixture();
  const executeFromChat = vi.fn().mockResolvedValue({ outcome: "executed", value: { correlation: "verified" } });
  vi.mocked(codexManagedAppActionForSession).mockResolvedValue({ executeFromChat } as never);
  const result = await handleConnectedActionDynamicToolCall(params, context);
  expect(result).toMatchObject({ success: true });
  expect(result.contentItems[0]).toMatchObject({ text: expect.stringContaining("provider-readback-matched") });
  expect(codexManagedAppActionForSession).toHaveBeenLastCalledWith(context.session, { permissionFingerprint: context.permissionFingerprint });
  expect(executeFromChat).toHaveBeenLastCalledWith({ authorization: context.authorization, threadId: "thread", turnId: "turn", userMessageId: "message", message: context.message });
});

it("rejects model approval flags, arbitrary arguments, foreign requests and unavailable human authority before construction", async () => {
  const { context, params } = fixture();
  vi.mocked(codexManagedAppActionForSession).mockClear();
  for (const patch of [{ arguments: { approved: true } }, { arguments: { tool: "send" } }, { threadId: "foreign" },
    { turnId: "foreign" }, { namespace: "foreign" }, { tool: "foreign" }, { arguments: [] }]) {
    await expect(handleConnectedActionDynamicToolCall({ ...params, ...patch }, context)).rejects.toThrow();
  }
  for (const patch of [{ session: undefined }, { backgroundExecution: true }, { authorization: null },
    { authorization: { ...context.authorization } }, { permissionFingerprint: "b".repeat(64) }, { userId: "foreign" }]) {
    await expect(handleConnectedActionDynamicToolCall(params, { ...context, ...patch })).rejects.toThrow();
  }
  expect(codexManagedAppActionForSession).not.toHaveBeenCalled();
});

it("returns indeterminate provider readback as failure without advertising success or replaying", async () => {
  const { context, params } = fixture();
  const executeFromChat = vi.fn().mockResolvedValue({ outcome: "indeterminate" });
  vi.mocked(codexManagedAppActionForSession).mockResolvedValue({ executeFromChat } as never);
  const result = await handleConnectedActionDynamicToolCall(params, context);
  expect(result.success).toBe(false);
  expect(result.contentItems[0]).toMatchObject({ text: expect.stringContaining("not verified as successful") });
  expect(executeFromChat).toHaveBeenCalledTimes(1);
});
