import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ context: vi.fn(), preview: vi.fn(), mutate: vi.fn() }));
vi.mock('./access', () => ({ productContext: mocks.context }));
vi.mock('./app-preview', () => ({ appPreviewContext: mocks.preview }));
vi.mock('./production', () => ({ readProduction: vi.fn(), summarizeProductionAudit: vi.fn(), mutateProduction: mocks.mutate }));
import { handleProductTool } from './chat-tools';
import { supportPreviewArguments, supportPreviewPolicy, type SupportPreviewBinding } from './support-preview-policy';
import { bindLocalServerSession } from '@/auth/server-session-binding';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const session = bindLocalServerSession({ provider: 'local' as const, user: { id: 'jordi', email: 'jordi@example.test', name: 'Jordi' },
  tenant: { id: 'g03-qa', name: 'QA' }, expiresAt: '2099-01-01T00:00:00Z',
  support: { actorEmail: 'support@example.test', expiresAt: '2099-01-01T00:00:00Z',preview:{threadId:other,appId:id} } }, 'a'.repeat(64));
const binding: SupportPreviewBinding = { installationId: 'g03-qa', userId: 'jordi', sessionHash: 'a'.repeat(64), supportActorEmail: 'support@example.test',
  supportExpiresAt: session.support!.expiresAt, runtimeThreadId: 'thread', runtimeTurnId: 'turn', previewAppId: id,previewWorkspaceId:other };
const call = { threadId: 'thread', turnId: 'turn', callId: 'call', namespace: 'aibrain_g03_production', tool: 'mutate',
  arguments: { input: { action: 'order.update', revision: 0, rowNumber: 1, reason: 'Synthetic test', patch: { observations: 'QA' } } } };
const ctx = { session, installation: { installationId: 'g03-qa' } as never, runtimeThreadId: 'thread', runtimeTurnId: 'turn',
  sourceMessage: 'Synthetic QA', supportPreview: binding };
const liveStore = { actor: 'jordi', marker: 'live' }, previewStore = { actor: 'jordi', marker: 'synthetic' };
beforeEach(() => { vi.clearAllMocks(); mocks.context.mockResolvedValue(liveStore); mocks.preview.mockResolvedValue(previewStore); mocks.mutate.mockResolvedValue({ revision: 1 }); });

it('forces the bound preview when the model omits it and writes only to the synthetic store', async () => {
  expect((await handleProductTool(call, ctx)).success).toBe(true);
  expect(mocks.preview).toHaveBeenCalledWith(liveStore, id, other);
  expect(mocks.mutate).toHaveBeenCalledWith(previewStore, call.arguments.input);
  expect(mocks.mutate).not.toHaveBeenCalledWith(liveStore, expect.anything());
});

it('rejects another preview, identity, turn, namespace and receiving before store access', async () => {
  for (const bad of [
    { ...call, arguments: { ...call.arguments, previewAppId: other } },
    { ...call, turnId: 'other' }, { ...call, threadId: 'other' },
    { ...call, namespace: 'aibrain_g03_apps' }, { ...call, tool: 'receiving' },
  ]) expect((await handleProductTool(bad, ctx)).success).toBe(false);
  for (const badSession of [
    { ...session, user: { ...session.user, id: 'other' } },
    { ...session, tenant: { ...session.tenant, id: 'other' } },
    { ...session, support: undefined },
    { ...session, support: { ...session.support!, actorEmail: 'other@example.test' } },
    { ...session, support: { ...session.support!, expiresAt: '2000-01-01T00:00:00Z' } },
    bindLocalServerSession({ ...session }, 'b'.repeat(64)),
  ]) expect((await handleProductTool(call, { ...ctx, session: badSession })).success).toBe(false);
  expect(mocks.context).not.toHaveBeenCalled(); expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.mutate).not.toHaveBeenCalled();
});

it('fails closed on malformed arguments and expired binding', () => {
  expect(() => supportPreviewArguments(binding, session, { ...call, arguments: null })).toThrow();
  const expired = { ...binding, supportExpiresAt: '2000-01-01T00:00:00Z' };
  expect(() => supportPreviewArguments(expired, bindLocalServerSession({ ...session, support: { ...session.support!, expiresAt: expired.supportExpiresAt } }, 'a'.repeat(64)), call)).toThrow();
});

it('does not alter ordinary authenticated production turns', async () => {
  const { supportPreview: _unused, ...normal } = ctx;
  expect((await handleProductTool(call, normal)).success).toBe(true);
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.mutate).toHaveBeenCalledWith(liveStore, call.arguments.input);
});

it('admits only the server-bound support session and its exact public QA thread',()=>{
 const qa=bindLocalServerSession({...session,support:{...session.support!,preview:{threadId:other,appId:id}}},'a'.repeat(64));
 expect(supportPreviewPolicy(qa,other)?.supportPreview).toMatchObject({publicThreadId:other,previewAppId:id,sessionHash:'a'.repeat(64)});
 expect(()=>supportPreviewPolicy(qa,id)).toThrow();
 expect(()=>supportPreviewPolicy({...qa},other)).toThrow(); // no server-only WeakMap session binding
 expect(supportPreviewPolicy({...session,support:undefined},'any')).toBeUndefined();
});
