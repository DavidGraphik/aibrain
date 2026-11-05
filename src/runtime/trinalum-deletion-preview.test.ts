import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalConnectorJson, connectorFingerprint } from '@/connectors/canonical';
import { FileApprovalStore } from './approval-store';
import { TrinalumChatActions } from './trinalum-chat-actions';
import { handleTrinalumTool, type TrinalumBridgeContext } from './trinalum-dynamic-tools';
vi.mock('server-only', () => ({}));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actorEmail = 'administration@example.invalid', userId = '11111111-1111-4111-8111-111111111111';
const key = Buffer.alloc(32, 41), snapshot = '3'.repeat(64);
const integration = connectorFingerprint({ provider: 'SIBEMA', origin: 'https://erp.example.invalid', contractor_id: 1 });
const resultBody = (value: Awaited<ReturnType<typeof handleTrinalumTool>>) => JSON.parse((value.contentItems[0] as { text: string }).text);
function preview(kind: 'offer' | 'tariff', patch: Record<string, unknown> = {}) {
  const issuedAt = Date.now();
  const payload = { version: 1, integration, actor: 'Nerea', kind, customerId: 1206, targetId: 122, snapshotSha256: snapshot, issuedAt, expiresAt: issuedAt + 300000, ...patch };
  const encoded = Buffer.from(canonicalConnectorJson(payload)).toString('base64url');
  const proof = 'v1.' + encoded + '.' + createHmac('sha256', key).update(encoded).digest('base64url');
  return { customer_id: 1206, ...(kind === 'offer' ? { offer_id: 122, description: 'Synthetic internal offer', line_count: 1, file_count: 0 }
    : { tariff_id: 122, reference: 'Synthetic grade', product_id: 1, price: 0.98, remarks: 'Synthetic unit basis EUR/kg' }),
    expectedSnapshotSha256: snapshot, expiresAt: new Date(Number(payload.expiresAt)).toISOString(), proof, independent_readback: true,
    warning: 'Only this exact unlinked snapshot may be deleted. No child-delete fallback; original files block offer deletion.' };
}
async function fixture(kind: 'offer' | 'tariff' = 'offer') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'trinalum-delete-preview-'))); roots.push(root);
  const configPath = path.join(root, 'bridge.json'), usersRoot = path.join(root, 'users');
  await mkdir(path.join(usersRoot, userId), { recursive: true, mode: 0o700 });
  const config = { installationId: 'trinalum-production', url: 'http://127.0.0.1:18931/read', users: { [userId]: { token: 'a'.repeat(64), status: 'active' } } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const deletionKeyFile = path.join(root, 'synthetic-key'); await writeFile(deletionKeyFile, key, { mode: 0o600 });
  const native = await import(/* @vite-ignore */ pathToFileURL(path.resolve('deployments/trinalum/host/sibema/lib/guarded-deletes.mjs')).href);
  let currentPreview = preview(kind);
  native.assertDeletionProof({host:'https://erp.example.invalid',deletionKeyFile},kind,{customerId:1206,[kind==='offer'?'offerId':'tariffId']:122,body:{expectedSnapshotSha256:snapshot,proof:currentPreview.proof}},'Nerea');
  const calls: Array<{ url: string; body: Record<string, any>; authorization: string }> = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body, authorization: (init?.headers as Record<string, string>).Authorization });
    if (body.operation === 'sibema_api') return Response.json({ source: 'Trinalum connector broker', data: { source: 'SIBEMA', method: 'GET', path: body.input.path, data: currentPreview, integrationProjection: true, untrustedSourceContent: true } });
    expect(body.phase).toBe('prepare');
    try { native.assertDeletionProof({ host: 'https://erp.example.invalid', deletionKeyFile }, kind, body.input.request, 'Nerea'); }
    catch(error) { if(body.input.request.body?.proof === currentPreview.proof) throw error; return Response.json({ error: 'SIBEMA_API_INVALID_ARGUMENTS' }, { status: 502 }); }
    return Response.json({ data: { status: 'prepared', action: { requestedBy: 'Nerea', type: body.input.type, request: body.input.request } } });
  });
  const approvalStore = new FileApprovalStore({ installationId: config.installationId, userId, usersRoot });
  const context: TrinalumBridgeContext = { installationId: config.installationId, userId, runtimeThreadId: 'runtime', runtimeTurnId: 'turn',
    configPath, approvalStore, fetcher, canMutate: true, permissionFingerprint: 'b'.repeat(64), authenticatedEmail: actorEmail,
    sourceMessageId: 'human', sourceTurnId: 'assistant', sourceMessage: 'Prepara la eliminación de este registro interno y no la ejecutes.', revalidateWrite: async () => true };
  const input = { type: kind === 'offer' ? 'delete_offer' : 'delete_customer_tariff', request: { customerId: 1206, [kind === 'offer' ? 'offerId' : 'tariffId']: 122 } };
  const call = (value: unknown = input, patch: Partial<TrinalumBridgeContext> = {}) => handleTrinalumTool({ namespace: 'trinalum_business', tool: 'sibema_action', threadId: 'runtime', turnId: 'turn', callId: 'delete-prepare', arguments: value as never }, { ...context, ...patch });
  return { root, calls, fetcher, context, call, input, config, configPath, get preview() { return currentPreview; }, setPreview(value: any) { currentPreview = value; } };
}

describe('typed guarded deletion preview transport', () => {
  it.each(['offer', 'tariff'] as const)('prepares %s from IDs using exact native proof bytes, with no model copy or execution', async kind => {
    const f = await fixture(kind); const original = f.preview.proof;
    // Actual failure class: truncating five signature characters makes38, not43.
    const alteredCopy = original.slice(0, -5); expect(alteredCopy.split('.').at(-1)).toHaveLength(38);
    const result = await f.call(); expect(resultBody(result)).toMatchObject({outcome:'prepared'}); expect(result.success).toBe(true); const out = resultBody(result);
    expect(out).toMatchObject({ outcome: 'prepared', providerData: { safeTarget: { kind, customerId: 1206, [kind === 'offer' ? 'offerId' : 'tariffId']: 122 } } });
    expect(f.calls.map(x => x.body.phase ?? 'read')).toEqual(['read', 'prepare']);
    expect(f.calls[0]).toMatchObject({ url: 'http://127.0.0.1:18931/read', authorization: `Bearer ${'a'.repeat(64)}`, body: { operation: 'sibema_api', input: { command: 'read', method: 'GET', path: `/customers/1206/${kind === 'offer' ? 'offers' : 'tariffs'}/122/deletion-preview` } } });
    expect(f.calls[1].body.input.request.body).toEqual({ expectedSnapshotSha256: snapshot, proof: original });
    expect(f.calls[1].body.input.request.body.proof).not.toEqual(alteredCopy);
    const saved = await new TrinalumChatActions(f.context.approvalStore!.userRoot, { installationId: f.context.installationId, userId, threadId: 'runtime' }).read(out.actionId);
    expect((saved!.input.request as any).body.proof).toBe(original); expect(saved!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(original); expect(JSON.stringify(result)).not.toContain('proof');
    expect(f.calls.some(x => x.body.phase === 'execute')).toBe(false);
  });
  it.each(['target', 'customer', 'actor', 'kind', 'integration', 'hash', 'expired', 'future', 'lifetime', 'signature', 'extra', 'file', 'path', 'envelope', 'previewTarget', 'previewCustomer', 'snapshotFormat', 'expiryText', 'independentReadback'] as const)('refuses %s preview before native preparation', async mode => {
    const f = await fixture();
    if (mode === 'target') f.setPreview(preview('offer', { targetId: 123 }));
    if (mode === 'customer') f.setPreview(preview('offer', { customerId: 1207 }));
    if (mode === 'actor') f.setPreview(preview('offer', { actor: 'Trini' }));
    if (mode === 'kind') f.setPreview(preview('offer', { kind: 'tariff' }));
    if (mode === 'integration') f.setPreview(preview('offer', { integration: 'f'.repeat(64) }));
    if (mode === 'hash') f.setPreview({ ...f.preview, expectedSnapshotSha256: 'f'.repeat(64) });
    if (mode === 'expired') f.setPreview(preview('offer', { issuedAt: Date.now() - 400000, expiresAt: Date.now() - 100000 }));
    if (mode === 'future') f.setPreview(preview('offer', { issuedAt: Date.now() + 10000, expiresAt: Date.now() + 310000 }));
    if (mode === 'lifetime') f.setPreview(preview('offer', { expiresAt: Date.now() + 600000 }));
    if (mode === 'signature') f.setPreview({ ...f.preview, proof: f.preview.proof.slice(0, -5) });
    if (mode === 'extra') f.setPreview({ ...f.preview, actorOverride: 'Trini' });
    if (mode === 'file') f.setPreview({ ...f.preview, file_count: 1 });
    if (mode === 'previewTarget') f.setPreview({ ...f.preview, offer_id: 123 });
    if (mode === 'previewCustomer') f.setPreview({ ...f.preview, customer_id: 1207 });
    if (mode === 'snapshotFormat') f.setPreview({ ...f.preview, expectedSnapshotSha256: 'bad' });
    if (mode === 'expiryText') f.setPreview({ ...f.preview, expiresAt: new Date(Date.now() + 600000).toISOString() });
    if (mode === 'independentReadback') f.setPreview({ ...f.preview, independent_readback: false });
    if (mode === 'path' || mode === 'envelope') f.fetcher.mockImplementationOnce(async () => Response.json({ source: mode === 'envelope' ? 'Other service' : 'Trinalum connector broker', data: { source: 'SIBEMA', method: 'GET', path: '/customers/1206/offers/123/deletion-preview', integrationProjection: true, data: f.preview } }));
    const result = await f.call(); expect(result.success).toBe(false); expect(resultBody(result).error).toBe('SIBEMA_DELETE_PREVIEW_INVALID');
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.calls.filter(x => x.body.phase === 'prepare')).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(f.preview.proof);
  });
  it('refuses a changed credential binding after preview and does not prepare', async () => {
    const f = await fixture(); const fetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementationOnce(async (...args) => { const result = await fetch(...args); f.config.users[userId].token = 'c'.repeat(64); await writeFile(f.configPath, JSON.stringify(f.config)); return result; });
    expect(resultBody(await f.call()).error).toBe('SIBEMA_DELETE_PREVIEW_ACCESS_CHANGED'); expect(f.calls).toHaveLength(1);
  });
  it('refuses revoked grants after the preview without preparing', async () => {
    const f = await fixture(); let checks = 0;
    expect(resultBody(await f.call(undefined, {revalidateWrite:async()=>++checks===1})).error).toBe('SIBEMA_DELETE_PREVIEW_ACCESS_CHANGED');
    expect(f.calls).toHaveLength(1); expect(f.calls[0].body.operation).toBe('sibema_api');
  });
  it.each([{ authenticatedEmail: 'operator@example.invalid' }, { authenticatedEmail: undefined }, { canMutate: false }, { runtimeTurnId: 'foreign' }, { revalidateWrite: async () => false }])('refuses unavailable actor/grants before any preview call', async patch => {
    const f = await fixture(); expect((await f.call(undefined, patch)).success).toBe(false); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([{ customerId: 1206, offerId: 0 }, { customerId: '1206', offerId: 122 }, { customerId: 1206, offerId: 122, actor: 'Nerea' }, null])('rejects invalid IDs-only shape before network', async request => {
    const f = await fixture(); expect((await f.call({ type: 'delete_offer', request })).success).toBe(false); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('leaves a supplied altered legacy proof unchanged for strict native rejection, without refresh or execute', async () => {
    const f = await fixture(); const proof = f.preview.proof.slice(0, -5);
    const result = await f.call({ ...f.input, request: { ...f.input.request, body: { expectedSnapshotSha256: snapshot, proof } } });
    expect(result.success).toBe(false); expect(resultBody(result).error).toBe('SIBEMA_API_INVALID_ARGUMENTS');
    expect(f.calls.map(x => x.body.phase)).toEqual(['prepare']); expect(f.calls[0].body.input.request.body.proof).toBe(proof);
  });
  it('retains the valid legacy request without an extra preview read', async () => {
    const f = await fixture(); const input = { ...f.input, request: { ...f.input.request, body: { expectedSnapshotSha256: snapshot, proof: f.preview.proof } } };
    expect((await f.call(input)).success).toBe(true); expect(f.calls.map(x => x.body.phase)).toEqual(['prepare']); expect(f.calls[0].body.input).toEqual(input);
  });
  it('does not retry a rejected preview transport or call native preparation', async () => {
    const f = await fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ error: 'SIBEMA_API_INVALID_ARGUMENTS' }, { status: 502 }));
    const result = await f.call(); expect(resultBody(result).error).toBe('SIBEMA_DELETE_PREVIEW_UNAVAILABLE'); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.calls).toHaveLength(0);
  });
  it('guides models to IDs-only preparation while retaining immutable/review-only and native fencing limits', async () => {
    const guide = await readFile(path.resolve('src/runtime/trinalum-tool-contract.ts'), 'utf8');
    expect(guide).toContain('request:{customerId,offerId}, without body'); expect(guide).toContain('Do not copy or reconstruct HMAC tokens');
    expect(guide).toContain('execution never refreshes a proof'); expect(guide).toContain('A rejected, uncertain or already-dispatched deletion is fenced by resource');
  });
});
