import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const state = vi.hoisted(() => ({ config: {} as Record<string, unknown>, allowed: true }));
vi.mock('@/config/installation', () => ({ loadInstallationConfig: async () => state.config }));
vi.mock('@/admin/policy-service', () => ({ workspacePolicyForIdentity: async () => ({ roleId: null }) }));
vi.mock('@/catalog/access-service', () => ({ catalogRuntimeEnforcer: async () => ({ allowsConnector: () => state.allowed }) }));
import { outlookCapabilityForSession, startOutlookOAuth } from './outlook-server-service';
import type { AuthSession } from '@/auth/types';
const session = { provider: 'local', tenant: { id: 'g03-production' }, user: { id: 'synthetic-user' } } as AuthSession;
beforeEach(() => { state.config = { installationId: 'g03-production', publicUrl: 'https://g03.example.test' }; state.allowed = true; vi.unstubAllEnvs(); });
describe('Outlook setup diagnosis without expanding access', () => {
  it('reports an authorized catalog tile with no OAuth setup as administrative setup', async () => {
    expect(await outlookCapabilityForSession(session)).toMatchObject({ status: 'not_configured', statusCode: 'OUTLOOK_NOT_ENABLED', connectUrl: null, effectiveOperations: [] });
    await expect(startOutlookOAuth(session)).rejects.toMatchObject({ code: 'OUTLOOK_NOT_ENABLED' });
  });
  it('distinguishes missing Entra tenant and secrets before creating state', async () => {
    state.config.connectors = { outlook: { enabled: true } };
    expect(await outlookCapabilityForSession(session)).toMatchObject({ statusCode: 'OUTLOOK_ENTRA_TENANT_NOT_CONFIGURED', connectUrl: null });
    state.config.connectors = { outlook: { enabled: true, tenantId: '11111111-1111-4111-8111-111111111111' } };
    vi.stubEnv('AIBRAIN_MICROSOFT_CLIENT_ID', ''); vi.stubEnv('AIBRAIN_MICROSOFT_CLIENT_SECRET', '');
    expect(await outlookCapabilityForSession(session)).toMatchObject({ statusCode: 'OUTLOOK_ENTRA_NOT_CONFIGURED', connectUrl: null });
  });
  it('does not turn a denied catalog or foreign session into a setup card', async () => {
    state.allowed = false;
    await expect(outlookCapabilityForSession(session)).rejects.toMatchObject({ code: 'OUTLOOK_CATALOG_DENIED' });
    state.allowed = true;
    await expect(outlookCapabilityForSession({ ...session, tenant: { id: 'foreign' } } as AuthSession)).rejects.toMatchObject({ code: 'OUTLOOK_TENANT_MISMATCH' });
  });
});
