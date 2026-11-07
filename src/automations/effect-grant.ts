import 'server-only';
import { createHash } from 'node:crypto';
import type { AuthSession } from '@/auth/types';
import { DEFAULT_AUTOMATION_EXECUTION_CONTEXT, isAutomationExecutionContext, type AutomationAllowedEffect, type AutomationExecutionContext, type AutomationTaskInput } from './contracts';

const issued = new WeakSet<object>();
export const automationEffectHash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Called only by the authenticated chat creation handler, never from JSON APIs. */
export function grantAutomationEffects(input: { session: AuthSession; input: AutomationTaskInput; allowedEffects: AutomationAllowedEffect[]; sourceThreadId: string; sourceTurnId: string; sourceMessage: string }): AutomationExecutionContext {
  if (input.session.provider !== 'local' || input.session.tenant.id !== 'trinalum-production' || (!Number.isFinite(Date.parse(input.session.expiresAt)) || Date.parse(input.session.expiresAt) <= Date.now()) || !input.allowedEffects.length) throw Error('AUTOMATION_EFFECT_GRANT_DENIED');
  const sourceMessage = input.sourceMessage.slice(0,20_000);
  const context = { ...DEFAULT_AUTOMATION_EXECUTION_CONTEXT, allowedEffects: [...input.allowedEffects], effectGrant: {
    schemaVersion: 1 as const, installationId: input.session.tenant.id, userId: input.session.user.id, projectId: input.input.projectId,
    sourceThreadId: input.sourceThreadId, sourceTurnId: input.sourceTurnId, sourceMessage,
    requestHash: automationEffectHash(sourceMessage), actionPromptHash: automationEffectHash(input.input.prompt),
  }};
  if (!isAutomationExecutionContext(context)) throw Error('AUTOMATION_EFFECT_GRANT_INVALID');
  issued.add(context.effectGrant);
  return context;
}

export function assertNewAutomationEffectGrant(context?: AutomationExecutionContext, identity?: { installationId: string; userId: string; projectId: string; prompt: string }) {
  if (context?.allowedEffects?.length && (!context.effectGrant || !issued.has(context.effectGrant) || identity && (context.effectGrant.installationId !== identity.installationId || context.effectGrant.userId !== identity.userId || context.effectGrant.projectId !== identity.projectId || context.effectGrant.actionPromptHash !== automationEffectHash(identity.prompt)))) throw Error('AUTOMATION_EFFECT_GRANT_REQUIRED');
}
