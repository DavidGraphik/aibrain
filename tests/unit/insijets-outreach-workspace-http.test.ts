import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/auth/types';
import { handleOutreachWorkspaceRequest, type OutreachWorkspaceDependencies } from '@/insijets/outreach-workspace-http';
const campaignId = '11111111-1111-4111-8111-111111111111';
const now = Date.parse('2026-10-15T10:00:00.000Z');
const session: AuthSession = { provider: 'local', user: { id: 'david-user', email: 'operator@example.invalid', name: 'David' }, tenant: { id: 'insijets-demo', name: 'InsiJets' }, expiresAt: '2026-10-16T10:00:00.000Z' };
function dependencies(): OutreachWorkspaceDependencies {
  return { session: vi.fn(async () => session), admin: vi.fn(async () => true), configuration: vi.fn(async () => ({ enabled: true, installationId: 'insijets-demo' })), now: () => now,
    read: vi.fn(async (_user, operation) => operation === 'campaign' ? { campaign: { id: campaignId, name: 'Actual provider campaign', status: 1 }, sequences: [{ steps: [{ type: 'email', delay: 0, variants: [{ subject: 'Hello', body: 'Body' }] }] }] } : operation === 'metrics' ? { metrics: { emails_sent_count: 12, reply_count: 0 } } : { items: [], nextCursor: null }) };
}
const request = (query = '') => new Request(`https://brain.test/api/insijets/outreach/workspace${query}`);
describe('Outreach request-only workspace', () => {
  it.each(['anonymous', 'foreign-tenant', 'demo', 'foreign-email', 'expired', 'not-admin'] as const)('does not access configuration, connectors or data when %s', async kind => {
    const deps = dependencies();
    if (kind === 'anonymous') deps.session = vi.fn(async () => null);
    if (kind === 'foreign-tenant') deps.session = vi.fn(async () => ({ ...session, tenant: { id: 'other', name: 'Other' } }));
    if (kind === 'demo') deps.session = vi.fn(async () => ({ ...session, provider: 'demo' as const }));
    if (kind === 'foreign-email') deps.session = vi.fn(async () => ({ ...session, user: { ...session.user, email: 'other@example.invalid' } }));
    if (kind === 'expired') deps.session = vi.fn(async () => ({ ...session, expiresAt: new Date(now).toISOString() }));
    if (kind === 'not-admin') deps.admin = vi.fn(async () => false);
    expect((await handleOutreachWorkspaceRequest(request(), deps)).status).toBe(kind === 'anonymous' ? 401 : 403);
    expect(deps.configuration).not.toHaveBeenCalled(); expect(deps.read).not.toHaveBeenCalled();
  });
  it('checks flags and installation before connector access', async () => {
    const deps = dependencies(); deps.configuration = vi.fn(async () => ({ enabled: false, installationId: 'insijets-demo' }));
    expect((await handleOutreachWorkspaceRequest(request(), deps)).status).toBe(404); expect(deps.read).not.toHaveBeenCalled();
  });
  it.each(['?section=replies', '?section=campaign&campaignId=bad', '?limit=51', '?section=overview&campaignId='+campaignId, '?section=overview&section=campaign', '?url=https://evil.test'])('rejects unsupported/unbounded input %s', async query => {
    const deps = dependencies(); expect((await handleOutreachWorkspaceRequest(request(query), deps)).status).toBe(400); expect(deps.read).not.toHaveBeenCalled();
  });
  it('returns actual bounded overview values and keeps empty/zero separate from unavailable', async () => {
    const deps = dependencies(); const response = await handleOutreachWorkspaceRequest(request('?limit=10&cursor=next'), deps); const result = await response.json();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(result).toMatchObject({ status: 'connected', readOnly: true, source: 'Instantly', campaigns: { items: [] }, accounts: { items: [] }, metrics: { emails_sent_count: 12, reply_count: 0 }, campaign: null, replies: null });
    expect(deps.read).toHaveBeenCalledWith('david-user', 'campaigns', { limit: 10, cursor: 'next' });
    expect(deps.read).toHaveBeenCalledTimes(3);
  });
  it('reports missing credentials explicitly without demo campaigns or invented metrics', async () => {
    const deps = dependencies(); deps.read = vi.fn(async () => { throw Object.assign(new Error('private-key'), { code: 'INSTANTLY_CREDENTIAL_NOT_CONFIGURED' }); });
    const result = await (await handleOutreachWorkspaceRequest(request(), deps)).json();
    expect(result).toMatchObject({ status: 'not_configured', campaigns: null, accounts: null, metrics: null });
    expect(result.errors).toHaveLength(3); expect(JSON.stringify(result)).not.toContain('private-key');
  });
  it('preserves successful partial results while clearly degrading a failed section', async () => {
    const deps = dependencies(); const read = deps.read; deps.read = vi.fn(async (user, operation, args) => { if (operation === 'metrics') throw Object.assign(new Error('sensitive'), { code: 'INSTANTLY_HTTP_429' }); return read(user, operation, args); });
    const result = await (await handleOutreachWorkspaceRequest(request(), deps)).json();
    expect(result).toMatchObject({ status: 'degraded', campaigns: { items: [] }, metrics: null, errors: [{ section: 'metrics', code: 'INSTANTLY_HTTP_429' }] });
  });
  it('loads selected copy and nested lead/metrics only after checking campaign ownership', async () => {
    const deps = dependencies(); const result = await (await handleOutreachWorkspaceRequest(request(`?section=campaign&campaignId=${campaignId}&limit=3`), deps)).json();
    expect(result.campaign).toMatchObject({ details: { id: campaignId }, sequences: [{ steps: [{ variants: [{ subject: 'Hello', body: 'Body' }] }] }], leads: { items: [] }, metrics: { emails_sent_count: 12 } });
    expect(vi.mocked(deps.read).mock.calls[0]).toEqual(['david-user', 'campaign', { campaignId }]);
    expect(deps.read).toHaveBeenCalledWith('david-user', 'leads', { campaignId, limit: 3 });
  });
  it('never requests contacts/replies if campaign ownership fails', async () => {
    const deps = dependencies(); deps.read = vi.fn(async () => { throw Object.assign(new Error('sensitive'), { code: 'INSTANTLY_WORKSPACE_MISMATCH' }); });
    const result = await (await handleOutreachWorkspaceRequest(request(`?section=replies&campaignId=${campaignId}`), deps)).json();
    expect(result).toMatchObject({ status: 'degraded', campaign: null, replies: null }); expect(deps.read).toHaveBeenCalledTimes(1);
  });
  it('fetches replies only for the verified selected campaign and disallows all effects', async () => {
    const deps = dependencies(); const result = await (await handleOutreachWorkspaceRequest(request(`?section=replies&campaignId=${campaignId}&cursor=reply-page`), deps)).json();
    expect(result.replies).toEqual({ items: [], nextCursor: null }); expect(deps.read).toHaveBeenLastCalledWith('david-user', 'replies', { campaignId, limit: 25, cursor: 'reply-page' });
    const denied = dependencies(); expect((await handleOutreachWorkspaceRequest(new Request(request().url, { method: 'POST' }), denied)).status).toBe(405); expect(denied.session).not.toHaveBeenCalled(); expect(denied.read).not.toHaveBeenCalled();
  });
});
