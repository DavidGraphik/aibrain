vi.mock("server-only", () => ({}));
import { expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { assertInteractiveChatAuthorization, createInteractiveChatAuthorization } from "./interactive-chat-authorization";
const identity = { installationId: "modtime", userId: "actor", threadId: "thread", turnId: "turn" };
const session = { provider: "local", tenant: { id: "modtime" }, user: { id: "actor" }, expiresAt: new Date(Date.now() + 3600000).toISOString() } as AuthSession;
const chatPermissions = { installationId: "modtime", userId: "actor", turnId: "local-turn", fingerprint: "a".repeat(64), rules: [{ ruleId: "tools.execute", action: "execute" as const, effect: "allow" as const, instruction: "Execute authorized tools", sourceScope: "installation" as const, sourcePolicyVersion: 1, precedence: 0 }] };
const input = () => ({ ...identity, session, userMessageId: "message", message: "Replace the homepage logo", signal: new AbortController().signal, backgroundExecution: false, mode: "agent" as const, localTurnId: "local-turn", permissions: chatPermissions });
it("accepts only a live process-local current-user/current-turn authority, never copied/model fields", () => {
  const authority = createInteractiveChatAuthorization(input())!;
  expect(assertInteractiveChatAuthorization(authority, identity)).toBe(authority);
  expect(authority.requestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(authority).not.toHaveProperty("message");
  expect(() => assertInteractiveChatAuthorization({ ...authority }, identity)).toThrow("INTERACTIVE_CHAT_REQUIRED");
  for (const patch of [{ userId: "foreign" }, { threadId: "foreign" }, { turnId: "foreign" }, { installationId: "foreign" }])
    expect(() => assertInteractiveChatAuthorization(authority, { ...identity, ...patch })).toThrow("INTERACTIVE_CHAT_REQUIRED");
});
it("rejects background, missing/expired/foreign sessions, empty direct requests and cancellation", () => {
  for (const patch of [{ backgroundExecution: true }, { session: undefined }, { session: { ...session, expiresAt: "invalid" } }, { session: { ...session, expiresAt: "2020-01-01" } }, { userId: "foreign" }, { message: " " }])
    expect(createInteractiveChatAuthorization({ ...input(), ...patch })).toBeNull();
  const controller = new AbortController(), authority = createInteractiveChatAuthorization({ ...input(), signal: controller.signal })!;
  controller.abort();
  expect(() => assertInteractiveChatAuthorization(authority, identity)).toThrow("INTERACTIVE_CHAT_REQUIRED");
  expect(createInteractiveChatAuthorization({ ...input(), signal: controller.signal })).toBeNull();
});

it("does not allow chat consent to override ask/plan mode or a denied turn execution policy", () => {
  expect(createInteractiveChatAuthorization({ ...input(), mode: "ask" })).toBeNull();
  expect(createInteractiveChatAuthorization({ ...input(), mode: "plan" })).toBeNull();
  expect(createInteractiveChatAuthorization({ ...input(), permissions: { ...chatPermissions, rules: [] } })).toBeNull();
  expect(createInteractiveChatAuthorization({ ...input(), permissions: { ...chatPermissions, rules: [...chatPermissions.rules, { ...chatPermissions.rules[0], effect: "deny" }] } })).toBeNull();
  expect(createInteractiveChatAuthorization({ ...input(), permissions: { ...chatPermissions, userId: "foreign" } })).toBeNull();
  expect(createInteractiveChatAuthorization({ ...input(), permissions: { ...chatPermissions, turnId: "foreign" } })).toBeNull();
});

it("supports any installation with its own authenticated identity and permission snapshot", () => {
  const company = "another-company";
  const authority = createInteractiveChatAuthorization({ ...input(), installationId: company,
    session: { ...session, tenant: { ...session.tenant, id: company } },
    permissions: { ...chatPermissions, installationId: company } });
  expect(authority).not.toBeNull();
  expect(assertInteractiveChatAuthorization(authority!, { ...identity, installationId: company })).toBe(authority);
});
