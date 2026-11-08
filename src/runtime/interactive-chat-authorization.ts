import "server-only";
import { createHash } from "node:crypto";
import type { ResolvedPermissions } from "@/permissions";
import type { AuthSession } from "@/auth/types";

/** Process-local authority from the authenticated interactive runner. Never a
 * tool argument, model boolean or session-wide grant. The model interprets the
 * direct user request; retrieved content and attachments cannot grant consent. */
export type InteractiveChatAuthorization = Readonly<{
  installationId: string; userId: string; threadId: string; turnId: string;
  userMessageId: string; requestHash: string; permissionFingerprint: string; signal: AbortSignal; expiresAt: number;
}>;
const issued = new WeakSet<object>();
export function createInteractiveChatAuthorization(input: {
  session?: AuthSession; installationId: string; userId: string; threadId: string;
  turnId: string; userMessageId: string; message: string; signal: AbortSignal;
  backgroundExecution: boolean; mode: "agent" | "plan" | "ask"; localTurnId: string;
  permissions: Pick<ResolvedPermissions, "installationId" | "userId" | "turnId" | "fingerprint" | "rules">;
}): InteractiveChatAuthorization | null {
  const { session, permissions } = input;
  const executionRules = permissions.rules.filter(rule => rule.ruleId === "tools.execute" && rule.action === "execute");
  if (input.mode !== "agent" || permissions.installationId !== input.installationId || permissions.userId !== input.userId ||
      permissions.turnId !== input.localTurnId || !/^[a-f0-9]{64}$/.test(permissions.fingerprint) ||
      executionRules.some(rule => rule.effect === "deny") || !executionRules.some(rule => rule.effect === "allow") ||
      input.backgroundExecution || input.signal.aborted || !input.installationId ||
      !session || session.tenant.id !== input.installationId || session.user.id !== input.userId ||
      !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now() ||
      !input.threadId || !input.turnId || !input.userMessageId || !input.message.trim()) return null;
  const authority = Object.freeze({ installationId: input.installationId, userId: input.userId,
    threadId: input.threadId, turnId: input.turnId, userMessageId: input.userMessageId,
    requestHash: createHash("sha256").update(input.message).digest("hex"),
    permissionFingerprint: permissions.fingerprint, signal: input.signal, expiresAt: Date.parse(session.expiresAt) });
  issued.add(authority);
  return authority;
}
export function assertInteractiveChatAuthorization(value: InteractiveChatAuthorization | undefined,
  identity: { installationId: string; userId: string; threadId: string; turnId: string }) {
  if (!value || !issued.has(value) || value.signal.aborted || value.expiresAt <= Date.now() ||
      (["installationId", "userId", "threadId", "turnId"] as const).some(key => value[key] !== identity[key])) {
    throw new Error("INTERACTIVE_CHAT_REQUIRED");
  }
  return value;
}
