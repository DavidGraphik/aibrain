import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
vi.mock('server-only', () => ({}));
import { type Dataset, type Order, type Phase, machineQueue } from './contracts';
import { unassignedMachineCount, startsClientGroup, machineLoadMarker } from './production-load';
import { mutateProduction, previewImport, readProduction } from './production';
import { ProductStore } from './persistence';
import type { ProductContext } from './access';
import { v7FormulaFields } from './v7-logic';

const order = (patch: Partial<Order>): Order => ({ rowNumber: 1, client: 'A', reference: 'REF', description: 'Peça', readyStock: null, productionStatus: null, statusComment: null, deliveryDate: null, salesOrder: null, workOrder: '1/5', units: 10, unitsDelivered: 0, unitsPending: 10, materialEta: null, materialStatus: null, unitsReceivedTotal: 0, unitsAtG03: 0, materialMissing: 10, assignedMachine: null, priority: 7, showInLoad: null, loadText: null, loadKey: null, legacyFlag: null, formulaFields: [...v7FormulaFields], ...patch });
const phase = (patch: Partial<Phase>): Phase => ({ rowNumber: 1, workOrder: '1/5', phaseNumber: 1, machine: 'M1', state: 'EN ESPERA', priority: 3, observations: null, ...patch });

it('counts only pending reference rows with neither direct nor unambiguous active phase assignment', () => {
  const orders = [order({ rowNumber: 1 }), order({ rowNumber: 2, workOrder: '2/5', productionStatus: ' NO COMENÇAT ' }), order({ rowNumber: 3, workOrder: '3/5', assignedMachine: 'M1' }), order({ rowNumber: 4, workOrder: '4/5', productionStatus: 'EN PRODUCCIÓ' }), order({ rowNumber: 5, workOrder: '5/5', productionStatus: 'ENTREGAT' }), order({ rowNumber: 6, workOrder: null, reference: 'NEW' }), order({ rowNumber: 7, workOrder: '7/5' }), order({ rowNumber: 8, workOrder: '8/5' }), order({ rowNumber: 9, workOrder: '9/5', reference: null })];
  const data = { orders, phases: [phase({ workOrder: '7/5' }), phase({ rowNumber: 2, workOrder: '8/5', state: 'ACABADA' })] };
  const before = structuredClone(data);
  expect(unassignedMachineCount(data)).toBe(4);
  expect(data).toEqual(before);
  expect(unassignedMachineCount({ orders: [order({}), order({ rowNumber: 2, reference: 'OTHER' })], phases: [phase({})] })).toBe(2);
});

it('marks only visible client transitions and leaves order/grouping untouched', () => {
  const rows = [{ client: 'Client A' }, { client: ' client a ' }, { client: 'B' }, { client: null }, { client: null }, { client: 'A' }];
  expect(rows.map((_, index) => startsClientGroup(rows, index))).toEqual([false, false, true, true, false, true]);
  expect(rows[2].client).toBe('B');
});

it('keeps manual markers independent of status and uses only explicit business signals for automatic markers', () => {
  const data = { orders: [order({ productionStatus: 'NO COMENÇAT', materialStatus: 'PENDENT', assignedMachine: 'M1', loadMarker: 'machining' })], phases: [phase({ state: 'EN PROCÉS' })] };
  expect(machineLoadMarker(data, { id: 'of-1' })).toEqual({ marker: 'machining', manual: true });
  data.orders[0].loadMarker = null;
  expect(machineLoadMarker(data, { id: 'of-1' })).toEqual({ marker: 'awaiting-material', manual: false });
  data.orders[0].materialStatus = 'PARCIAL';
  expect(machineLoadMarker(data, { id: 'of-1' }).marker).toBe('partial-material');
  expect(machineLoadMarker(data, { id: 'phase-1' })).toEqual({ marker: 'machining', manual: false });
  data.phases[0].loadMarker = 'awaiting-material';
  expect(machineLoadMarker(data, { id: 'phase-1' })).toEqual({ marker: 'awaiting-material', manual: true });
  data.phases[0].loadMarker = null; data.phases[0].state = 'EN ESPERA'; data.orders.push(order({ rowNumber: 2 }));
  expect(machineLoadMarker(data, { id: 'phase-1' }).marker).toBeNull();
});

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
it('persists order and phase markers with scheduling permissions, audit, stale-write rejection and unchanged priority/state', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'g03-load-'));
  const ctx: ProductContext = { installationId: 'g03-qa', actor: 'jordi', grants: ['read', 'orders', 'machines', 'import'], store: new ProductStore(root, 'g03-qa') };
  const data: Dataset = { sourceVersion: 'V7', capturedAt: '2026-11-03', lookups: { machines: ['M1'], productionStatuses: ['NO COMENÇAT'] }, orders: [order({ assignedMachine: 'M1', productionStatus: 'NO COMENÇAT' })], phases: [phase({})] };
  const preview = previewImport(data);
  await mutateProduction(ctx, { action: 'import.commit', revision: 0, dataset: data, sha256: preview.sha256, reason: 'Synthetic isolated fixture' });
  const original = await readProduction(ctx), queue = machineQueue(original, 'M1').map(row => row.id);
  // A highlighting edit must not run ordinary business edit rules.
  const design = { revision: 0, versions: [{version: 1, at: '2026-11-03', actor: 'jordi', instruction: 'Synthetic scheduling rule', tabs: [], rules: [{id: 'ordinary-priority-rule', set: {priority: 1}}]}], audit: [] };
  await ctx.store.mutate('production-design', () => design, () => ({saved: true}), 0);
  await expect(mutateProduction({ ...ctx, grants: ['read', 'orders'] }, { action: 'order.update', revision: 1, rowNumber: 1, patch: { loadMarker: 'machining' }, reason: 'No scheduling grant' })).rejects.toMatchObject({ status: 403 });
  await expect(mutateProduction(ctx, { action: 'order.update', revision: 1, rowNumber: 1, patch: { loadMarker: 'unknown' }, reason: 'Invalid marker' })).rejects.toMatchObject({ status: 400 });
  await mutateProduction(ctx, { action: 'order.update', revision: 1, rowNumber: 1, patch: { loadMarker: 'machining' }, reason: 'Requested yellow highlight' });
  await mutateProduction(ctx, { action: 'phase.update', revision: 2, rowNumber: 1, patch: { loadMarker: 'partial-material' }, reason: 'Requested orange phase highlight' });
  const saved = await readProduction({ ...ctx, store: new ProductStore(root, 'g03-qa') });
  expect(saved.orders[0]).toEqual({ ...original.orders[0], loadMarker: 'machining' });
  expect(saved.phases[0]).toEqual({ ...original.phases[0], loadMarker: 'partial-material' });
  expect(machineQueue(saved, 'M1').map(row => row.id)).toEqual(queue);
  expect(saved.audit.at(-1)).toMatchObject({ action: 'phase.update', actor: 'jordi', after: { loadMarker: 'partial-material', priority: 3 } });
  await expect(mutateProduction(ctx, { action: 'order.update', revision: 1, rowNumber: 1, patch: { loadMarker: null }, reason: 'Stale request' })).rejects.toMatchObject({ status: 409 });
  await mutateProduction(ctx, { action: 'order.update', revision: 3, rowNumber: 1, patch: { loadMarker: null }, reason: 'Return to automatic' });
  expect((await readProduction(ctx)).orders[0].loadMarker).toBeNull();
});
