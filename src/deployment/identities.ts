/**
 * Public source ships synthetic identities only. An installation may provide its
 * reviewed identity mapping through this server environment variable at startup.
 * These values never grant a provider permission or replace session/role checks.
 */
const sample = {
  operator: 'operator@example.invalid',
  cmsOwner: 'cms-owner@example.invalid',
  manager: 'manager@example.invalid',
  sales: 'sales@example.invalid',
  administration: 'administration@example.invalid',
  quality: 'quality@example.invalid',
  production: 'production@example.invalid',
  office: 'office@example.invalid',
  hostOwnerId: '11111111-1111-4111-8111-111111111111',
} as const;
export type DeploymentIdentity = keyof typeof sample;

export function deploymentIdentity(key: DeploymentIdentity): string {
  const raw = process.env.AIBRAIN_DEPLOYMENT_IDENTITIES;
  if (!raw) return sample[key];
  let mapping: unknown;
  try { mapping = JSON.parse(raw); } catch { throw Error('DEPLOYMENT_IDENTITIES_INVALID'); }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
      Object.keys(mapping).some(name => !Object.hasOwn(sample, name))) throw Error('DEPLOYMENT_IDENTITIES_INVALID');
  const value = (mapping as Record<string, unknown>)[key];
  if (value === undefined) return sample[key];
  if (typeof value !== 'string' || value.length > 254 ||
      (key === 'hostOwnerId' ? !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value) : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) throw Error('DEPLOYMENT_IDENTITIES_INVALID');
  return key === 'hostOwnerId' ? value : value.toLowerCase();
}

/** Deployment-specific ERP endpoint; never commit the real customer origin. */
export function deploymentErpOrigin(): string {
  const raw = process.env.AIBRAIN_SIBEMA_ORIGIN ?? 'https://erp.example.invalid';
  let url: URL;
  try { url = new URL(raw); } catch { throw Error('DEPLOYMENT_ERP_ORIGIN_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('DEPLOYMENT_ERP_ORIGIN_INVALID');
  return url.origin;
}
