import { v7MachineQueue, v7FormulaFields } from './v7-logic';
export const g03ProductInstallation = (id: string) => ['g03-production', 'g03-qa', 'g03-development'].includes(id);
export class ProductError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status=status; } }
export function requireProduct(value: unknown, message: string, status = 400): asserts value { if (!value) throw new ProductError(status, message); }
export function object(value: unknown): Record<string, unknown> { requireProduct(value && typeof value === 'object' && !Array.isArray(value), 'Objecte invàlid.'); return value as Record<string, unknown>; }
export function text(value: unknown, max = 500, empty = false): string { requireProduct(typeof value === 'string' && value.length <= max && (empty || value.trim()), 'Text invàlid.'); return value.trim(); }
function sourceText(value: unknown, max: number, empty = false): string { text(value, max, empty); return value as string; }
export function number(value: unknown, min = 0): number { requireProduct(typeof value === 'number' && Number.isFinite(value) && value >= min, 'Quantitat invàlida.'); return value; }
export function date(value: unknown): string { const s = text(value, 10); requireProduct(/^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Data invàlida.'); return s; }
export const loadMarkers = ['machining', 'awaiting-material', 'partial-material'] as const;
export type LoadMarker = typeof loadMarkers[number];
export function loadMarker(value: unknown): LoadMarker | null { requireProduct(value === null || typeof value === 'string' && (loadMarkers as readonly string[]).includes(value), 'Indicador de càrrega desconegut.'); return value as LoadMarker | null; }
export type Order = { loadMarker?: LoadMarker | null; sourceReferenceValue?: string | null; formulaFields?: (typeof v7FormulaFields[number])[]; sourceCells?: Record<string, string | null>; rowNumber: number; client: string | null; reference: string | number | null; description: string | null; readyStock: number | null; productionStatus: string | null; statusComment: string | null; deliveryDate: string | null; salesOrder: string | null; workOrder: string | null; units: number | null; unitsDelivered: number | null; unitsPending: number | null; materialEta: string | null; materialStatus: string | null; unitsReceivedTotal: number | null; unitsAtG03: number | null; materialMissing: number | null; assignedMachine: string | null; priority: number | null; showInLoad: string | null; loadText: string | null; loadKey: string | null; legacyFlag: number | null; materialRequired?: number | null; materialUnit?: string | null; materialReference?: string | null; printStatus?: string | null; sageKey?: string | null };
export type Phase = { loadMarker?: LoadMarker | null; rowNumber: number; workOrder: string | null; phaseNumber: number | null; machine: string | null; state: string | null; priority: number | null; observations: string | null };
export type CatalogItem = { rowNumber: number; reference: string; client: string | null; description: string | null };
export type ProductionTask = { rowNumber: number; owner: string; description: string; done: boolean };
export type IntakeRow = {rowNumber:number;reference:string;client:string|null;description:string|null;status:string|null};
export type SourceSheet = {name:string;dimension:string;cells:Record<string,{value:string|number|boolean|null;formula:string|null;format:string}>};
export type Dataset = { sourcePhaseArchive?: Phase[]; sheets?: SourceSheet[]; intake?: IntakeRow[]; catalog?: CatalogItem[]; deliveredHistory?: Order[]; tasks?: ProductionTask[]; importIssues?: string[]; sourceHash?: string; capturedAt: string; spreadsheet?: { title: string }; sourceVersion: string; lookups: { machines: string[]; productionStatuses: string[] }; orders: Order[]; phases: Phase[] };
export type Receipt = { id: string; workOrder: string; purchaseOrder: string; reference: string; quantity: number; unit: string; actor: string; status: 'pending' | 'validated'; validator?: string };
export type Audit = { at: string; actor: string; action: string; target: string; before: unknown; after: unknown; reason: string };
export type ProductionConfiguration = { productionStatuses?: string[]; materialStatuses?: string[]; phaseStatuses?: string[]; cellColors?: Record<string, Record<string, string>>; dropdownLabels?: Record<string, Record<string,string>>; deliveryColors?: Partial<Record<'overdue'|'week'|'currentMonth'|'futureMonth',string>> };
export type ProductionState = Dataset & { sourceSync?: { fileId: string; version: string; modifiedAt: string; baseline: string; checkedAt: string; pendingConflicts?: { collection: string; key: string; field: string; reason: string }[] }; revision: number; configuration?: ProductionConfiguration; catalogDeletedReferences?: string[]; receipts: Receipt[]; sageKeys: string[]; audit: Audit[] };
export type Grant = 'read' | 'orders' | 'machines' | 'receipts' | 'validate-receipts' | 'import' | 'apps';
export type ProductPolicy = { installationId: string; users: Record<string, Grant[]>; appRecordWriters?: string[]; appDesigners?: string[] };
export type Field = { name: string; type: 'text' | 'number' | 'boolean' | 'date'; required?: boolean };
export type AppVersion = { version: number; at: string; actor: string; html: string; fields: Field[]; instruction: string };
export type MiniApp = { id: string; owner: string; title: string; revision: number; versions: AppVersion[]; publishedVersion: number | null; shared: boolean; productionManaged?: boolean; deletedRows?: { id:string;revision:number;values:Record<string,unknown> }[]; rows: { id: string; revision: number; values: Record<string, unknown> }[]; audit: Audit[] };
export const completedProductionStatuses: readonly string[] = ['ENTREGAT', 'ENTREGAT AL CLIENT', 'PEÇA ACABADA', 'ESTOC FET', 'LLEST PER SERVIR'];
export const completed = (status: string | null) => completedProductionStatuses.includes(status?.trim() ?? '');
/** The Production dashboard counts rows, including blank statuses and duplicate OFs. */
export function productionOrderCounts(orders: readonly Pick<Order, 'productionStatus'>[]) {
  const openRows = orders.filter(order => !completed(order.productionStatus)).length;
  return { scope: 'all-production-order-rows' as const, totalRows: orders.length, openRows, completedRows: orders.length - openRows, completedStatuses: [...completedProductionStatuses] };
}
/** Both the live chat and Production use Madrid's calendar day, not UTC. */
export function productionMadridDay(at: Date = new Date()): string {
  return at.toLocaleDateString('sv-SE', {timeZone:'Europe/Madrid'});
}
/** A due date equal to today is not overdue; completed rows are never overdue. */
export function productionOrderOverdue(order: Pick<Order, 'deliveryDate' | 'productionStatus'>, referenceDate: string): boolean {
  return Boolean(order.deliveryDate && order.deliveryDate < referenceDate && !completed(order.productionStatus));
}
export function productionOverdueCounts(orders: readonly Pick<Order, 'deliveryDate' | 'productionStatus'>[], referenceDate: string) {
  return {scope:'all-production-order-rows' as const, referenceDate, timeZone:'Europe/Madrid' as const,
    overdueRows:orders.filter(order=>productionOrderOverdue(order,referenceDate)).length,
    definition:'deliveryDate before referenceDate and productionStatus not completed' as const};
}
export function machineQueue(data: Dataset, machine: string) {
  if (data.sourceVersion === 'V7') return v7MachineQueue(data, machine);
  const orders = data.orders.filter(o => o.assignedMachine === machine && !completed(o.productionStatus) && o.showInLoad !== 'NO').map(o => ({ id: `of-${o.rowNumber}`, workOrder: o.workOrder, label: `${o.client ?? ''} · ${o.reference ?? ''} · ${o.description ?? ''}`, priority: o.priority, state: o.productionStatus, kind: 'OF' }));
  const phases = data.phases.filter(p => p.machine === machine && !completed(p.state) && p.state !== 'ACABADA' && !completed(data.orders.find(o => o.workOrder === p.workOrder)?.productionStatus ?? null)).map(p => ({ id: `phase-${p.rowNumber}`, workOrder: p.workOrder, label: `Fase ${p.phaseNumber ?? ''} · ${p.observations ?? ''}`, priority: p.priority, state: p.state, kind: 'FASE' }));
  return [...orders, ...phases].sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}
export const orderNumbers = ['readyStock', 'units', 'unitsDelivered', 'unitsReceivedTotal', 'unitsAtG03', 'materialMissing', 'priority', 'materialRequired'] as const;
export const orderTexts = ['client', 'reference', 'description', 'productionStatus', 'statusComment', 'salesOrder', 'workOrder', 'materialStatus', 'assignedMachine', 'showInLoad', 'materialReference', 'materialUnit', 'printStatus'] as const;
export const orderDates = ['deliveryDate', 'materialEta'] as const;
/** Imported item identity is protected from ordinary editors; designers have an explicit exception. */
export const productionSourceFields = ['client', 'reference', 'description'] as const;
export function orderPatch(raw: unknown, lookups: Dataset['lookups']): Partial<Order> {
  const patch = object(raw); requireProduct(Object.keys(patch).length > 0, 'Canvi buit.'); const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'loadMarker') result[key] = loadMarker(value);
    else if ((orderNumbers as readonly string[]).includes(key)) result[key] = value === null ? null : number(value);
    else if ((orderDates as readonly string[]).includes(key)) result[key] = value === null || value === '' ? null : date(value);
    else if ((orderTexts as readonly string[]).includes(key)) result[key] = value === null ? null : text(value, key === 'statusComment' ? 2000 : 500, true) || null;
    else throw new ProductError(400, `Camp no editable: ${key}`);
  }
  if (result.assignedMachine) requireProduct(lookups.machines.includes(String(result.assignedMachine)), 'Màquina desconeguda.');
  if (result.productionStatus) requireProduct(lookups.productionStatuses.includes(String(result.productionStatus)), 'Estat desconegut.');
  return result;
}
export function validateDataset(raw: unknown): Dataset {
  const d = object(raw), lookups = object(d.lookups);
  requireProduct(Array.isArray(d.orders) && d.orders.length <= 10000 && Array.isArray(d.phases) && d.phases.length <= 40000, 'Límit de files excedit.');
  requireProduct(Array.isArray(lookups.machines) && lookups.machines.length <= 100 && Array.isArray(lookups.productionStatuses) && lookups.productionStatuses.length <= 100, 'Llistes invàlides.');
  const lists = { machines: lookups.machines.map(s => text(s, 100)), productionStatuses: lookups.productionStatuses.map(s => text(s, 100)) };
  const rows = new Set<number>(); const ofs = new Set<string>();
  const orders = d.orders.map(value => {
    const o = object(value); requireProduct(Number.isSafeInteger(o.rowNumber) && number(o.rowNumber, 1) && !rows.has(o.rowNumber as number), 'Fila duplicada o invàlida.'); rows.add(o.rowNumber as number);
    const input = Object.fromEntries(Object.entries(o).filter(([k]) => [...orderNumbers, ...orderTexts, ...orderDates, 'loadMarker'].includes(k as never)));
    if (typeof input.reference === 'number') input.reference = String(input.reference);
    const signed = Object.fromEntries((d.sourceVersion === 'V7' ? ['unitsAtG03','materialMissing'] : []).filter(k => typeof input[k] === 'number' && (input[k] as number) < 0).map(k => [k, number(input[k],-Number.MAX_VALUE)]));
    for (const key of Object.keys(signed)) input[key] = 0;
    const p = { ...orderPatch(input, lists), ...signed };
    if (d.sourceVersion === 'V7') for (const key of orderTexts) if (typeof input[key] === 'string') Object.assign(p,{[key]:input[key]});
    if (o.sourceReferenceValue !== undefined && o.sourceReferenceValue !== null) text(o.sourceReferenceValue,500,true); requireProduct((p.workOrder || d.sourceVersion === 'V7' && p.reference) && (d.sourceVersion === 'V7' || !ofs.has(p.workOrder!)), 'OF buida o duplicada.'); if (p.workOrder) ofs.add(p.workOrder);
    const delivered = p.unitsDelivered ?? 0, units = p.units ?? 0; requireProduct(delivered <= units, 'Les entregues superen les unitats.');
    const formulaFields=o.formulaFields === undefined ? undefined : o.formulaFields;
    requireProduct(formulaFields === undefined || Array.isArray(formulaFields) && formulaFields.every(k=>v7FormulaFields.includes(k as never)), 'Fórmules desconegudes.');
    return { ...o, ...p, formulaFields, unitsPending: d.sourceVersion === 'V7' && typeof o.unitsPending === 'number' ? number(o.unitsPending,-Number.MAX_VALUE) : units - delivered } as Order;
  });
  const phaseRows = new Set<number>();
  const phases = d.phases.map(value => { const p = object(value); requireProduct(Number.isSafeInteger(p.rowNumber) && number(p.rowNumber, 1) && !phaseRows.has(p.rowNumber as number), 'Fase duplicada.'); phaseRows.add(p.rowNumber as number); const wo = text(p.workOrder, 100); requireProduct(ofs.has(wo), 'Fase sense OF.'); const machine = p.machine === null ? null : text(p.machine, 100); requireProduct(!machine || lists.machines.includes(machine), 'Màquina desconeguda.'); return { ...(Object.hasOwn(p,'loadMarker')?{loadMarker:loadMarker(p.loadMarker)}:{}), rowNumber: p.rowNumber as number, workOrder: wo, phaseNumber: p.phaseNumber === null ? null : number(p.phaseNumber, 1), machine, state: p.state === null ? null : text(p.state, 100), priority: p.priority === null ? null : number(p.priority), observations: p.observations === null ? null : text(p.observations, 2000, true) }; });
  requireProduct(d.sourcePhaseArchive === undefined || Array.isArray(d.sourcePhaseArchive) && d.sourcePhaseArchive.length <= 40000, 'Arxiu de fases invàlid.');
  const sourcePhaseArchive = (Array.isArray(d.sourcePhaseArchive) ? d.sourcePhaseArchive : []).map(value => {
    const p=object(value); requireProduct(Number.isSafeInteger(p.rowNumber) && number(p.rowNumber,1), 'Fase arxivada invàlida.');
    return {...(Object.hasOwn(p,'loadMarker')?{loadMarker:loadMarker(p.loadMarker)}:{}),rowNumber:p.rowNumber as number,workOrder:text(p.workOrder,100),phaseNumber:p.phaseNumber===null?null:number(p.phaseNumber,1),machine:p.machine===null?null:text(p.machine,100),state:p.state===null?null:text(p.state,100),priority:p.priority===null?null:number(p.priority),observations:p.observations===null?null:text(p.observations,2000,true)};
  });
  const catalog = (Array.isArray(d.catalog) ? d.catalog : []).map(value => { const v=object(value); return { rowNumber:number(v.rowNumber,1), reference:text(v.reference,500), client:v.client===null?null:text(v.client,500,true), description:v.description===null?null:text(v.description,2000,true) }; });
  const taskRows=new Set<number>();
  const tasks = (Array.isArray(d.tasks) ? d.tasks : []).map(value => { const v=object(value),rowNumber=number(v.rowNumber,1); requireProduct(Number.isSafeInteger(rowNumber)&&!taskRows.has(rowNumber),'Fila de tasca duplicada o invàlida.');taskRows.add(rowNumber);return { rowNumber, owner:text(v.owner,500,true), description:text(v.description,4000), done:v.done===true }; });
  requireProduct(catalog.length<=10000 && tasks.length<=10000, 'Massa registres.');
  const deliveredHistory = Array.isArray(d.deliveredHistory) ? d.deliveredHistory.map(value => { const v=object(value); requireProduct(Number.isSafeInteger(v.rowNumber) && number(v.rowNumber,1), 'Històric invàlid.'); const out: Record<string,unknown>={rowNumber:v.rowNumber,...(Object.hasOwn(v,'loadMarker')?{loadMarker:loadMarker(v.loadMarker)}:{})}; for(const k of [...orderTexts,...orderDates,'loadText','loadKey']) if(v[k]!==undefined) out[k]=v[k]===null?null:text(String(v[k]),4000,true); for(const k of [...orderNumbers,'unitsPending','legacyFlag']) if(v[k]!==undefined) out[k]=v[k]===null?null:number(v[k],-Number.MAX_VALUE); if(v.sourceCells){const cells=object(v.sourceCells); requireProduct(Object.keys(cells).length<=100,'Massa columnes.'); out.sourceCells=Object.fromEntries(Object.entries(cells).map(([k,value])=>{requireProduct(/^[A-Z]{1,3}$/.test(k),'Columna invàlida.'); return [k,value===null?null:text(value,10000,true)];}));} return out as Order; }) : [];
  requireProduct(deliveredHistory.length<=10000,'Històric massa gran.');
  const importIssues = (Array.isArray(d.importIssues)?d.importIssues:[]).map(v=>text(v,2000));
  const intake=(Array.isArray(d.intake)?d.intake:[]).map(value=>{const r=object(value);return {rowNumber:number(r.rowNumber,1),reference:text(r.reference,500),client:r.client===null?null:text(r.client,500,true),description:r.description===null?null:text(r.description,2000,true),status:r.status===null?null:text(r.status,100,true)};});
  requireProduct(intake.length<=10000,'Massa entrades.');
  const sheets=(Array.isArray(d.sheets)?d.sheets:[]).map(value=>{const s=object(value),cells=object(s.cells);requireProduct(Object.keys(cells).length<=150000,'Full massa gran.');return {name:sourceText(s.name,200),dimension:text(s.dimension,50),cells:Object.fromEntries(Object.entries(cells).map(([coordinate,value])=>{requireProduct(/^[A-Z]{1,3}[1-9][0-9]{0,5}$/.test(coordinate),'Cel·la invàlida.');const c=object(value);requireProduct(c.value===null || typeof c.value==='boolean' || typeof c.value==='string' && c.value.length<=20000 || typeof c.value==='number' && Number.isFinite(c.value),'Valor invàlid.');return [coordinate,{value:c.value as string|number|boolean|null,formula:c.formula===null?null:sourceText(c.formula,20000,true),format:sourceText(c.format,500,true)}];}))};});
  requireProduct(sheets.length<=10 && new Set(sheets.map(s=>s.name)).size===sheets.length,'Fulls duplicats.');
  return { sourcePhaseArchive, sheets, intake, catalog, tasks, deliveredHistory, importIssues, sourceHash: d.sourceHash ? text(d.sourceHash,64) : undefined, capturedAt: text(d.capturedAt, 50), sourceVersion: text(d.sourceVersion, 100), spreadsheet: { title: text(object(d.spreadsheet ?? { title: d.sourceVersion }).title, 200) }, lookups: lists, orders, phases };
}
