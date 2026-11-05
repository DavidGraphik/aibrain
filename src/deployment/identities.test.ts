import { afterEach, describe, expect, it, vi } from 'vitest';
import { deploymentIdentity, deploymentErpOrigin } from './identities';
afterEach(() => vi.unstubAllEnvs());
describe('deployment identities', () => {
  it('ships synthetic defaults without requiring installation secrets', () => {
    vi.stubEnv('AIBRAIN_DEPLOYMENT_IDENTITIES', '');
    expect(deploymentIdentity('operator')).toBe('operator@example.invalid');
  });
  it('uses only a reviewed installation mapping, normalized for existing email checks', () => {
    vi.stubEnv('AIBRAIN_DEPLOYMENT_IDENTITIES', JSON.stringify({ operator: 'Owner@Deployment.Example', hostOwnerId: '22222222-2222-4222-8222-222222222222' }));
    expect(deploymentIdentity('operator')).toBe('owner@deployment.example');
    expect(deploymentIdentity('hostOwnerId')).toBe('22222222-2222-4222-8222-222222222222');
    expect(deploymentIdentity('sales')).toBe('sales@example.invalid');
  });
  it.each(['{', 'null', '[]', '{"unknown":"owner@example.invalid"}', '{"operator":"invalid"}', '{"hostOwnerId":"invalid"}'])('rejects malformed configuration: %s', raw => {
    vi.stubEnv('AIBRAIN_DEPLOYMENT_IDENTITIES', raw);
    expect(() => deploymentIdentity(raw.includes('hostOwnerId') ? 'hostOwnerId' : 'operator')).toThrow('DEPLOYMENT_IDENTITIES_INVALID');
  });
});

it('binds ERP proof identity to a reviewed HTTPS origin only', () => {
  vi.stubEnv('AIBRAIN_SIBEMA_ORIGIN', 'https://erp.deployment.example');
  expect(deploymentErpOrigin()).toBe('https://erp.deployment.example');
  for (const invalid of ['http://erp.deployment.example', 'https://user:password@erp.deployment.example', 'https://erp.deployment.example/private', 'https://erp.deployment.example/?token=private']) {
    vi.stubEnv('AIBRAIN_SIBEMA_ORIGIN', invalid);
    expect(deploymentErpOrigin).toThrow('DEPLOYMENT_ERP_ORIGIN_INVALID');
  }
});
