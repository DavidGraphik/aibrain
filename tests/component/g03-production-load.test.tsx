// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProductionWorkspace } from '@/g03-products/production-workspace';
import { defaultProductionView } from '@/g03-products/production-columns';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(grants = ['read', 'machines', 'orders']) {
  const state = { revision: 3, capturedAt: '2026-11-03', sourceVersion: 'V7', view: defaultProductionView(), grants, lookups: { machines: ['M1'], productionStatuses: ['NO COMENÇAT', 'EN PRODUCCIÓ'] }, orders: [{ rowNumber: 1, workOrder: '1/5', reference: 'A', client: 'Client A', productionStatus: 'NO COMENÇAT', materialStatus: 'PENDENT', assignedMachine: 'M1', priority: 7, loadMarker: null as string | null }, { rowNumber: 2, workOrder: '2/5', reference: 'B', client: 'Client A', productionStatus: null, assignedMachine: null }, { rowNumber: 3, workOrder: '3/5', reference: 'C', client: 'Client B', productionStatus: 'NO COMENÇAT', assignedMachine: null }, { rowNumber: 4, workOrder: '4/5', reference: 'D', client: 'Client B', productionStatus: 'EN PRODUCCIÓ', assignedMachine: null }], phases: [], receipts: [], audit: [] };
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
    if (init?.method === 'POST') { const input = JSON.parse(String(init.body)); writes.push(input); Object.assign(state.orders[0], input.patch); state.revision++; }
    return { ok: true, json: async () => structuredClone(state) };
  }));
  return { state, writes };
}

it('shows a compact pending-machine total and a full-row boundary only on visible client changes', async () => {
  setup(); render(<ProductionWorkspace />);
  const summary = await screen.findByLabelText('Resum de producció');
  expect(within(summary).getByText('Referències sense màquina').parentElement).toHaveTextContent('2');
  const rows = ['1/5', '2/5', '3/5', '4/5'].map(of => screen.getByLabelText(`Client OF ${of}`).closest('tr'));
  expect(rows[0]?.className).toBe(''); expect(rows[1]?.className).toBe(''); expect(rows[2]?.className).toContain('clientGroupStart'); expect(rows[3]?.className).toBe('');
  fireEvent.change(screen.getByLabelText('Buscar OF'), { target: { value: '3/5' } });
  expect(screen.getByLabelText('Client OF 3/5').closest('tr')?.className).toBe('');
});

it('changes the visual marker alone, renders persisted readback and restores automatic material indication', async () => {
  const { state, writes } = setup(); render(<ProductionWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: 'Càrrega maquinària' }));
  expect(screen.getByRole('img', { name: 'Material pendent · màquina assignada' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Indicador OF 1/5 fila 1'), { target: { value: 'machining' } });
  await screen.findByRole('img', { name: 'En mecanitzat · indicador manual' });
  expect(writes[0]).toMatchObject({ action: 'order.update', revision: 3, rowNumber: 1, patch: { loadMarker: 'machining' } });
  expect(Object.keys(writes[0].patch as object)).toEqual(['loadMarker']);
  expect(state.orders[0]).toMatchObject({ priority: 7, productionStatus: 'NO COMENÇAT', materialStatus: 'PENDENT' });
  fireEvent.change(screen.getByLabelText('Indicador OF 1/5 fila 1'), { target: { value: '' } });
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({ revision: 4, patch: { loadMarker: null } });
  await screen.findByRole('img', { name: 'Material pendent · màquina assignada' });
});

it('exposes the colors and text without mutation controls to readers', async () => {
  const { writes } = setup(['read']); render(<ProductionWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: 'Càrrega maquinària' }));
  expect(screen.getByLabelText('Llegenda de càrrega')).toHaveTextContent('Material rebut parcialment');
  expect(screen.queryByLabelText('Indicador OF 1/5 fila 1')).not.toBeInTheDocument();
  expect(writes).toEqual([]);
});
