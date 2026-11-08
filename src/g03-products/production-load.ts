import type { Dataset, LoadMarker, Order } from './contracts';

const normalized = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toUpperCase();
const phaseFinished = (state: string | null) => ['ACABADA', 'ENTREGAT', 'LLEST PER SERVIR'].includes(normalized(state));

/** Count control rows, including references whose OF has not yet been filled in. */
export function unassignedMachineCount(data: Pick<Dataset, 'orders' | 'phases'>) {
  const uniqueWorkOrders = new Map<string, number>();
  for (const order of data.orders) if (order.workOrder) uniqueWorkOrders.set(order.workOrder, (uniqueWorkOrders.get(order.workOrder) ?? 0) + 1);
  const assignedPhases = new Set(data.phases.filter(phase => phase.machine?.trim() && !phaseFinished(phase.state)).map(phase => phase.workOrder));
  return data.orders.filter(order => {
    if (!String(order.reference ?? '').trim() || order.assignedMachine?.trim() || !['', 'NO COMENCAT'].includes(normalized(order.productionStatus))) return false;
    // A duplicated OF cannot identify which reference its phase schedules.
    return !order.workOrder || uniqueWorkOrders.get(order.workOrder) !== 1 || !assignedPhases.has(order.workOrder);
  }).length;
}

/** Borders follow the visible row sequence; they never sort or regroup data. */
export function startsClientGroup(rows: readonly Pick<Order, 'client'>[], index: number) {
  return index > 0 && normalized(rows[index - 1]?.client) !== normalized(rows[index]?.client);
}

export const loadMarkerLabels: Record<LoadMarker, string> = {
  machining: 'En mecanitzat',
  'awaiting-material': 'Material pendent · màquina assignada',
  'partial-material': 'Material rebut parcialment',
};
export const loadMarkerColors: Record<LoadMarker, string> = { machining: '#FFDF00', 'awaiting-material': '#00A5DE', 'partial-material': '#FF8127' };

/** Explicit per-item choices take precedence over independently stored business states. */
export function machineLoadMarker(data: Pick<Dataset, 'orders' | 'phases'>, item: { id: string }): { marker: LoadMarker | null; manual: boolean } {
  const phase = item.id.startsWith('phase-') ? data.phases.find(row => `phase-${row.rowNumber}` === item.id) : undefined;
  const order = phase ? data.orders.find(row => row.workOrder === phase.workOrder) : data.orders.find(row => `of-${row.rowNumber}` === item.id);
  const manual = phase?.loadMarker ?? (!phase ? order?.loadMarker : null);
  if (manual) return { marker: manual, manual: true };
  if (['EN PROCES', 'EN PRODUCCIO'].includes(normalized(phase ? phase.state : order?.productionStatus))) return { marker: 'machining', manual: false };
  // Material belongs to the OF. A phase cannot borrow it from an ambiguous OF.
  const material = phase && data.orders.filter(row => row.workOrder === phase.workOrder).length !== 1 ? '' : normalized(order?.materialStatus);
  if (material === 'PARCIAL') return { marker: 'partial-material', manual: false };
  if (material === 'PENDENT') return { marker: 'awaiting-material', manual: false };
  return { marker: null, manual: false };
}
