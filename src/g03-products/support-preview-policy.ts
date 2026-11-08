import type { AuthSession } from '@/auth/types';
import { localServerSessionHash } from '@/auth/server-session-binding';
import type { DynamicToolCallParams } from '../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams';
import { object, requireProduct } from './contracts';
import type { HostAnalysisPolicy } from '@/runtime/host-analysis-policy';

/**
 * Server-owned binding for one support turn. This is NOT a complete test mode:
 * the chat admission and central tool gate must independently enforce it.
 */
export type SupportPreviewBinding = Readonly<{
  installationId: string;
  userId: string;
  sessionHash: string;
  supportActorEmail: string;
  supportExpiresAt: string;
  runtimeThreadId: string;
  runtimeTurnId: string;
  previewAppId: string;
  previewWorkspaceId: string;
}>;

/** A support preview is a server-issued session restriction, never user/model text. */
export function supportPreviewPolicy(session:AuthSession, publicThreadId:string):HostAnalysisPolicy|undefined {
  const preview=session.support?.preview;
  if (!preview) return undefined;
  const sessionHash=localServerSessionHash(session);
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  requireProduct(session.provider==='local' && ['g03-production','g03-qa'].includes(session.tenant.id) &&
    uuid.test(preview.threadId) && uuid.test(preview.appId) && preview.threadId===publicThreadId && typeof sessionHash==='string' && /^[a-f0-9]{64}$/.test(sessionHash) &&
    Number.isFinite(Date.parse(session.support!.expiresAt)) && Date.parse(session.support!.expiresAt)>Date.now(),
    'Context de prova no autoritzat.',403);
  return {businessReads:false,webSearch:false,supportPreview:{installationId:session.tenant.id,userId:session.user.id,sessionHash,
    supportActorEmail:session.support!.actorEmail,supportExpiresAt:session.support!.expiresAt,publicThreadId,previewAppId:preview.appId}};
}

/** Reject everything except Production read/write, forcing the server's preview.
 * The model's arguments are never an authority to choose a different store. */
export function supportPreviewArguments(binding: SupportPreviewBinding, session: AuthSession,
  params: DynamicToolCallParams, now = Date.now()): Record<string, unknown> {
  requireProduct(session.provider === 'local' && !!session.support &&
    session.tenant.id === binding.installationId && session.user.id === binding.userId &&
    /^[a-f0-9]{64}$/.test(binding.sessionHash) && localServerSessionHash(session) === binding.sessionHash &&
    session.support.actorEmail === binding.supportActorEmail &&
    session.support.expiresAt === binding.supportExpiresAt &&
    Number.isFinite(Date.parse(binding.supportExpiresAt)) && Date.parse(binding.supportExpiresAt) > now &&
    params.threadId === binding.runtimeThreadId && params.turnId === binding.runtimeTurnId &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(binding.previewAppId) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(binding.previewWorkspaceId) &&
    session.support.preview?.threadId===binding.previewWorkspaceId && session.support.preview.appId===binding.previewAppId,
    'Context de prova no autoritzat.', 403);
  requireProduct(params.namespace === 'aibrain_g03_production' &&
    (params.tool === 'read' || params.tool === 'mutate'), 'Eina no disponible en la prova.', 403);
  const args = object(params.arguments);
  requireProduct(args.previewAppId === undefined || args.previewAppId === binding.previewAppId,
    'Espai de prova no autoritzat.', 403);
  return { ...args, previewAppId: binding.previewAppId };
}
