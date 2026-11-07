import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadInstallationConfig } from '@/config/installation';
import type { InstallationConfig } from '@/config/installation-schema';
import type { AuthSession } from '@/auth/types';
import { g03ProductInstallation, requireProduct, type Grant, type ProductPolicy } from './contracts';
import { ProductStore } from './persistence';
export type ProductContext = { installationId: string; actor: string; grants: Grant[]; appRecordsWritable?: boolean; appDesigner?: boolean; syntheticPreview?: true; store: ProductStore };
export async function productContext(session: AuthSession, config?: Readonly<InstallationConfig>): Promise<ProductContext> {
  const installation = config ?? await loadInstallationConfig();
  requireProduct(g03ProductInstallation(installation.installationId) && session.provider === 'local' && session.tenant.id === installation.installationId, 'Accés no autoritzat.', 403);
  return productContextForIdentity(session.tenant.id, session.user.id, installation);
}
/** Only call after authenticating the turn identity; rechecks the product policy on every read. */
export async function productContextForIdentity(installationId: string, userId: string, installation: Readonly<InstallationConfig>): Promise<ProductContext> {
  requireProduct(g03ProductInstallation(installation.installationId) && installationId === installation.installationId, 'Accés no autoritzat.', 403);
  const policyPath = process.env.AIBRAIN_G03_PRODUCT_POLICY;
  requireProduct(policyPath && path.isAbsolute(policyPath), 'Producció pendent de configurar.', 503);
  let policy: ProductPolicy;
  try { policy = JSON.parse(await readFile(policyPath, 'utf8')); } catch { throw new Error('Política de producte no disponible.'); }
  requireProduct(policy.installationId === installation.installationId && Array.isArray(policy.users?.[userId]), 'Accés no autoritzat.', 403);
  const grants = policy.users[userId];
  requireProduct(grants.every(g => ['read','orders','machines','receipts','validate-receipts','import','apps'].includes(g)), 'Política invàlida.', 503);
  // An explicit writer list separates shared-app visibility from record edits.
  // Absent lists preserve existing installations; onboarding must supply this list.
  const hasWriters = Object.hasOwn(policy, 'appRecordWriters');
  const writers = policy.appRecordWriters;
  requireProduct(!hasWriters || Array.isArray(writers) && writers.length <= 5000 &&
    writers.every(id => typeof id === 'string' && Object.hasOwn(policy.users, id)) &&
    new Set(writers).size === writers.length, 'Política de dades d’aplicacions invàlida.', 503);
  const designers=policy.appDesigners;
  requireProduct(designers===undefined || Array.isArray(designers) && designers.length<=5000 && new Set(designers).size===designers.length && designers.every(id=>typeof id==='string' && Object.hasOwn(policy.users,id)), 'Política de disseny invàlida.',503);
  return { installationId: installation.installationId, actor: userId, grants, appDesigner:designers?.includes(userId)===true,
    appRecordsWritable: !hasWriters || writers!.includes(userId), store: new ProductStore(path.join(installation.paths.dataRoot, 'g03-products'), installation.installationId) };
}
export function grant(context: ProductContext, value: Grant) { requireProduct(context.grants.includes(value), 'No tens permís per a aquesta acció.', 403); }
