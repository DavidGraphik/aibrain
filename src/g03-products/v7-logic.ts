/** Rules transcribed from V7 cells and its bound script; checked against the 8 October export.
 * This does not execute arbitrary spreadsheet formulas or the installed Google trigger. */
import type { Dataset, Order } from './contracts';
const numeric = (n: number | null | undefined) => n ?? 0;
const dayText = (day: string | null) => day ? `${day.slice(8,10)}/${day.slice(5,7)}` : '';
const serial = (day: string | null | undefined) => day ? (Date.parse(`${day}T00:00:00Z`) - Date.UTC(1899,11,30)) / 86400000 : 999999;
export const v7FormulaFields = ['unitsPending','unitsAtG03','materialMissing','showInLoad','loadText','loadKey'] as const;
export function recalculateV7(order: Order): Order {
  const fields=new Set(order.formulaFields ?? []);
  const unitsPending = fields.has('unitsPending') ? numeric(order.units) - numeric(order.unitsDelivered) : order.unitsPending;
  const computed: Partial<Order> =
  { unitsPending, unitsAtG03: numeric(order.unitsReceivedTotal) - numeric(order.unitsDelivered),
    materialMissing: numeric(unitsPending) - numeric(order.unitsReceivedTotal),
    showInLoad: order.assignedMachine && order.workOrder ? 'SI' : '',
    loadText: order.workOrder ? `OF${order.workOrder} ${order.client ?? ''} ${order.sourceReferenceValue ?? order.reference ?? ''} ${order.description ?? ''} ${unitsPending == null ? '' : `${unitsPending}UT `}${order.deliveryDate ? `DLL${dayText(order.deliveryDate)}` : ''}` : '',
    loadKey: order.assignedMachine ? `${order.assignedMachine}|${Math.round(order.priority ?? 0).toString().padStart(4,'0')}|${order.rowNumber}` : '' };
  return {...order,...Object.fromEntries(Object.entries(computed).filter(([key])=>fields.has(key as typeof v7FormulaFields[number])))};
}
export function v7MachineQueue(data: Dataset, machine: string) {
  // FILTER tests F only for LLEST PER SERVIR. W is not an input to CARGA_HELPER.
  const orders = data.orders.filter(o => o.assignedMachine === machine && o.workOrder && o.productionStatus?.trim() !== 'LLEST PER SERVIR');
  const orderRows = orders.map(o => ({id:`of-${o.rowNumber}`,workOrder:o.workOrder,
    label:`OF${o.workOrder}${o.priority === null || o.priority === undefined ? '' : ` [P${o.priority}]`} ${o.client ?? ''} ${o.sourceReferenceValue ?? o.reference ?? ''} ${o.description ?? ''} ${o.unitsPending ?? numeric(o.units)-numeric(o.unitsDelivered)}UT ${o.deliveryDate ? `DLL${dayText(o.deliveryDate)}` : ''}`,
    priority:o.priority,state:o.productionStatus,kind:'OF',sortKey:o.priority ?? serial(o.deliveryDate)}));
  // Preserve phase assignments; manual parent work temporarily removes them from machine load.
  const phases = data.phases.filter(p => p.machine === machine && p.state && p.state !== 'ACABADA' && !v7ClearsMachine(data.orders.find(o => o.workOrder === p.workOrder)?.productionStatus ?? null));
  const phaseRows = phases.map(p => {
    // XLOOKUP uses the first matching OF, including duplicated identifiers.
    const o=data.orders.find(o => o.workOrder === p.workOrder);
    return {id:`phase-${p.rowNumber}`,workOrder:p.workOrder,
      label:`OF${p.workOrder ?? ''}${p.priority === null || p.priority === undefined ? '' : ` [P${p.priority}]`} F${p.phaseNumber ?? ''} ${o?.sourceReferenceValue ?? o?.reference ?? ''} ${o?.description ?? ''} ${o ? `${o.unitsPending ?? numeric(o.units)-numeric(o.unitsDelivered)}UT ` : ''}${o?.deliveryDate ? `DLL${dayText(o.deliveryDate)}` : ''} ${p.state}${p.observations ? ` - ${p.observations}` : ''}`,
      priority:p.priority,state:p.state,kind:'FASE',sortKey:p.priority ?? serial(o?.deliveryDate)};
  });
  // SORT is stable for equal priority: source orders, then source phases.
  return [...orderRows,...phaseRows].sort((a,b)=>a.sortKey-b.sortKey);
}
/** Source normalization, extended with Jordi’s manual-task states from 24 October. */
export const normalizeV7Text=(value:unknown)=>String(value ?? '').trim().replace(/\s+/g,' ').toUpperCase();
export function v7ClearsMachine(status:string|null){
 const normalized=String(status ?? '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\./g,'').replace(/[()]/g,'').replace(/\//g,'').replace(/\s+/g,' ');
 return ['LLEST PER SERVIR','PDT PROVA PRESSIO','PDT PROVA DE PRESSIO','PDT RENTAR','PDT RECTIFICAT','PER ENVIAR A TRACTAMENT','ENVIAT A TRACTAMENT PREVIM','ENVIAT A TRACTAMENT POSTM','PDT ENVIAR PINTURA','PDT ENVIAR A PINTURA','EXTERN','PDT LLIMAR','PDT OLI','PDT ROSCAR','PDT MUNTATGE HELICOIS','PDT OK CONTROL DE QUALITAT','PDT ENCAIXAR','PDT POSAR PASSADOR','PDT TORN MANUAL UF'].includes(normalized);
}
export function v7EditEffects(order:Order,patch:Partial<Order>):Order{
 const next={...order};
 if(Object.hasOwn(patch,'productionStatus') && v7ClearsMachine(next.productionStatus)){next.assignedMachine=null;next.priority=null;}
 if(Object.hasOwn(patch,'materialStatus')){
  const material=normalizeV7Text(next.materialStatus);
  if(material==='REBUT'||material==='PARCIAL'){next.productionStatus='NO COMENÇAT';if(material==='REBUT')next.materialEta=null;}
  else if(normalizeV7Text(next.productionStatus)==='NO COMENÇAT')next.productionStatus=null;
 }
 return recalculateV7(next);
}
