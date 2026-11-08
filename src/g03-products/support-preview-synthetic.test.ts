import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('server-only', () => ({}));
const mocked = vi.hoisted(() => ({ productContext: vi.fn() }));
vi.mock('./access', async (load) => ({ ...(await load<typeof import('./access')>()), productContext: mocked.productContext }));
import { ProductStore } from './persistence';
import type { ProductContext } from './access';
import { mutateApp } from './apps';
import { appPreviewContext } from './app-preview';
import { mutateProduction, readProduction } from './production';
import { handleProductTool } from './chat-tools';
import { bindLocalServerSession } from '@/auth/server-session-binding';

let root: string, product: ProductContext;
const workspaceId='30000000-0000-4000-8000-000000000001';
let session:ReturnType<typeof bindLocalServerSession>;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'g03-preview-chat-'));
  product = { installationId: 'g03-qa', actor: 'jordi', appDesigner: true, appRecordsWritable: true,
    grants: ['read', 'apps', 'orders', 'machines'], store: new ProductStore(root, 'g03-qa') };
  mocked.productContext.mockResolvedValue(product);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });

it('uses the bound synthetic Production store and preserves working Production bytes', async () => {
  const app = await mutateApp(product, { action: 'create', title: 'Synthetic preview', html: '<h1>QA</h1>', fields: [], instruction: 'QA synthetic preview' }) as { id: string };
  session=bindLocalServerSession({provider:'local',user:{id:'jordi',email:'jordi@example.test',name:'Jordi'},tenant:{id:'g03-qa',name:'QA'},expiresAt:'2099-01-01',
    support:{actorEmail:'support@example.test',expiresAt:'2099-01-01T00:00:00Z',preview:{threadId:workspaceId,appId:app.id}}},'a'.repeat(64));
  await mutateProduction(product, { action: 'order.create', revision: 0, reason: 'Synthetic working fixture', patch: { workOrder: 'WORKING', units: 25 } });
  const before = await readFile(path.join(root, 'production.json'));
  const binding = { installationId: 'g03-qa', userId: 'jordi', sessionHash: 'a'.repeat(64), supportActorEmail: session.support!.actorEmail,
    supportExpiresAt: session.support!.expiresAt, runtimeThreadId: 'thread', runtimeTurnId: 'turn', previewAppId: app.id,previewWorkspaceId:workspaceId };
  const revision = (await readProduction(await appPreviewContext(product, app.id,workspaceId))).revision;
  const input = { action: 'order.create', revision, reason: 'Synthetic preview order', patch: { workOrder: 'TEST', units: 3 } };
  const result = await handleProductTool({ threadId: 'thread', turnId: 'turn', callId: 'call', namespace: 'aibrain_g03_production', tool: 'mutate', arguments: { input } },
    { session, installation: { installationId: 'g03-qa' } as never, runtimeThreadId: 'thread', runtimeTurnId: 'turn', sourceMessage: 'Create synthetic order', supportPreview: binding });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect((await readProduction(await appPreviewContext(product, app.id,workspaceId))).orders.map(order => order.workOrder)).toEqual(['TEST']);
  expect((await readProduction(await appPreviewContext(product, app.id))).orders).toEqual([]);
  expect(await readFile(path.join(root, 'production.json'))).toEqual(before);
  expect((await readProduction(product)).orders.map(order => order.workOrder)).toEqual(['WORKING']);
});
