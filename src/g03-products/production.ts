import { changeProductionTask } from './production-tasks';
import { applyProductionRules,validateProductionRules } from './production-rules';
import type { ProductionDesign } from './production-design-contract';
import { readProductionDesign } from './production-design';
import { recalculateV7, v7FormulaFields, v7EditEffects, v7ClearsMachine, normalizeV7Text } from './v7-logic';
import { randomUUID, createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { readRegularFileWithin } from '@/security/safe-file';
import { grant, type ProductContext } from './access';
import { date, number, object, orderPatch, orderTexts, orderDates, orderNumbers, productionSourceFields, requireProduct, text, loadMarker, validateDataset, type Audit, type Dataset, type Order, type ProductionState } from './contracts';
import { readProductionView, mutateProductionView } from './production-view';
const empty = (): ProductionState => ({ revision: 0, capturedAt: new Date().toISOString(), sourceVersion: 'Sense importar', lookups: { machines: [], productionStatuses: [] }, orders: [], phases: [], receipts: [], sageKeys: [], audit: [] });
const nextCatalogRow=(state:ProductionState)=>Math.max(0,...(state.catalog??[]).map(row=>row.rowNumber),...state.audit.filter(entry=>entry.action.startsWith('catalog.')).map(entry=>Number(entry.target)).filter(Number.isSafeInteger))+1;
async function sourceImportPaused(ctx:ProductContext):Promise<boolean|null> {
  try {
    const file=path.join(ctx.store.root,'source-sync','config.json'),metadata=await lstat(file);
    if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.nlink!==1||(metadata.mode&0o077)!==0)return null;
    const settings=JSON.parse((await readRegularFileWithin(ctx.store.root,'source-sync/config.json',65536)).toString('utf8'));
    return settings.schemaVersion===1&&settings.installationId===ctx.installationId&&typeof settings.apply==='boolean'?!settings.apply:null;
  } catch { return null; }
}
export async function readProduction(ctx: ProductContext) { grant(ctx, 'read'); const state=await ctx.store.read<ProductionState>('production') ?? empty(); return { ...state, lookups:{...state.lookups,productionStatuses:state.configuration?.productionStatuses??state.lookups.productionStatuses}, grants: ctx.grants, design:await readProductionDesign(ctx), view:await readProductionView(ctx),sourceImportPaused:await sourceImportPaused(ctx) }; }
/** Keep complete snapshots on disk; avoid resending all original cells in normal views. */
export function summarizeProductionAudit(entries: Audit[]): Audit[] {
  const snapshot=(value:unknown)=>{
    if (!value || typeof value!=='object' || !Object.hasOwn(value,'sheets')) return value;
    const {sheets,...rest}=value as Record<string,unknown>;
    return {...rest,sourceSheets:Array.isArray(sheets)?sheets.map(s=>({name:s.name,dimension:s.dimension})):[]};
  };
  return entries.map(entry=>entry.action==='import.commit'?{...entry,before:snapshot(entry.before),after:snapshot(entry.after)}:entry);
}
const audit = (ctx: ProductContext, state: ProductionState, action: string, target: string, before: unknown, after: unknown, reason: string) => state.audit.push({ at: new Date().toISOString(), actor: ctx.actor, action, target, before, after, reason } satisfies Audit);
export function previewImport(raw: unknown) { const dataset = validateDataset(raw); return { dataset, sha256: createHash('sha256').update(JSON.stringify(dataset)).digest('hex'), orders: dataset.orders.length, phases: dataset.phases.length }; }
export async function mutateProduction(ctx: ProductContext, input: unknown) {
  const b = object(input), action = text(b.action, 40);
  if (action === 'view.update') return mutateProductionView(ctx,b);
  if (action === 'import.preview') { grant(ctx, 'import'); return previewImport(b.dataset); }
  const allowed: Record<string, Parameters<typeof grant>[1]> = { 'catalog.create':'orders', 'catalog.update':'orders', 'catalog.delete':'orders', 'catalog.restore':'orders', 'configuration.update':'orders', 'task.create':'machines', 'task.update':'machines', 'task.delete':'machines', 'task.restore':'machines', 'order.create': 'orders', 'order.update': 'read', 'phase.create': 'machines', 'phase.update': 'machines', 'phase.delete':'machines', 'receipt.submit': 'receipts', 'receipt.validate': 'validate-receipts', 'import.commit': 'import', 'sage.import': 'import' };
  requireProduct(allowed[action], 'Acció desconeguda.'); grant(ctx, allowed[action]);
  const expected = number(b.revision); requireProduct(Number.isSafeInteger(expected), 'Revisió invàlida.');
  const reason = text(b.reason, 1000);
  const design=(action==='order.create'||action==='order.update')?await ctx.store.read<ProductionDesign>('production-design'):null;
  const rules=validateProductionRules(design?.versions.at(-1)?.rules??[]);
  return ctx.store.mutate<ProductionState, unknown>('production', empty, state => {
    let result: unknown;
    if (action === 'import.commit') {
      const p = previewImport(b.dataset); requireProduct(b.sha256 === p.sha256, 'Importació diferent de la revisada.', 409);
      requireProduct(state.receipts.length === 0 && state.sageKeys.length === 0, 'Hi ha moviments operatius. Cal conciliar-los abans de substituir el full.', 409);
      const before: Dataset = { capturedAt: state.capturedAt, sourceVersion: state.sourceVersion, lookups: state.lookups, orders: state.orders, phases: state.phases, catalog:state.catalog, deliveredHistory:state.deliveredHistory, tasks:state.tasks, intake:state.intake, sheets:state.sheets, spreadsheet:state.spreadsheet };
      Object.assign(state, p.dataset); audit(ctx, state, action, 'dataset', before, p.dataset, reason); result = { imported: p.orders, phases: p.phases, sourceVersion: p.dataset.sourceVersion };
    } else if (action==='catalog.restore') {
      const rowNumber=number(b.rowNumber,1);
      requireProduct(Number.isSafeInteger(rowNumber),'Fila de referència invàlida.');
      const last=[...state.audit].reverse().find(entry=>entry.action.startsWith('catalog.')&&entry.target===String(rowNumber));
      requireProduct(last?.action==='catalog.delete'&&last.before,'Referència retirada no trobada.',404);
      const saved=object(last.before);
      requireProduct(saved.rowNumber===rowNumber,'Històric de referència invàlid.',409);
      const restored={rowNumber,reference:text(saved.reference,500),client:saved.client===null?null:text(saved.client,500,true),description:saved.description===null?null:text(saved.description,2000,true)};
      const catalog=state.catalog??=[];
      requireProduct(!catalog.some(item=>item.rowNumber===rowNumber||normalizeV7Text(item.reference)===normalizeV7Text(restored.reference)),'La referència ja existeix al catàleg. No s’ha sobreescrit.',409);
      catalog.push(restored);
      state.catalogDeletedReferences=(state.catalogDeletedReferences??[]).filter(ref=>ref!==normalizeV7Text(restored.reference));
      audit(ctx,state,action,String(rowNumber),null,restored,reason);result=restored;
    } else if (action.startsWith('catalog.')) {
      const catalog=state.catalog ??= [];
      const index=action==='catalog.create'?-1:catalog.findIndex(item=>item.rowNumber===number(b.rowNumber,1));
      requireProduct(action==='catalog.create'||index>=0,'Referència no trobada.',404);
      const before=index<0?null:structuredClone(catalog[index]);
      if(action==='catalog.delete') {
        catalog.splice(index,1);
        state.catalogDeletedReferences=[...new Set([...(state.catalogDeletedReferences??[]),normalizeV7Text(before!.reference)])];
        audit(ctx,state,action,String(before!.rowNumber),before,null,reason);result={deleted:true,rowNumber:before!.rowNumber};
      } else {
        const patch=object(b.patch);
        requireProduct(Object.keys(patch).length>0&&Object.keys(patch).every(k=>['reference','client','description'].includes(k)),'Camp de referència desconegut.');
        const next={rowNumber:before?.rowNumber??nextCatalogRow(state),reference:before?.reference??'',client:before?.client??null,description:before?.description??null};
        if(Object.hasOwn(patch,'reference'))next.reference=text(patch.reference,500);
        for(const key of ['client','description'] as const)if(Object.hasOwn(patch,key))next[key]=patch[key]===null?null:text(patch[key],key==='description'?2000:500,true)||null;
        requireProduct(next.reference,'Indica la referència.');
        requireProduct(!catalog.some(item=>item.rowNumber!==next.rowNumber&&normalizeV7Text(item.reference)===normalizeV7Text(next.reference)),'Referència duplicada.',409);
        if(before&&normalizeV7Text(before.reference)!==normalizeV7Text(next.reference))state.catalogDeletedReferences=[...new Set([...(state.catalogDeletedReferences??[]),normalizeV7Text(before.reference)])];
        state.catalogDeletedReferences=(state.catalogDeletedReferences??[]).filter(ref=>ref!==normalizeV7Text(next.reference));
        if(index<0)catalog.push(next);else catalog[index]=next;
        audit(ctx,state,action,String(next.rowNumber),before,next,reason);result=next;
      }
    } else if (action==='configuration.update') {
      grant(ctx,'machines');
      const patch=object(b.patch), keys=Object.keys(patch);
      requireProduct(keys.length>0&&keys.every(k=>['machines','productionStatuses','materialStatuses','phaseStatuses','cellColors','deliveryColors','dropdownLabels'].includes(k)),'Configuració desconeguda.');
      const before=structuredClone({lookups:state.lookups,configuration:state.configuration??{}});
      const configuration=state.configuration??={};
      for(const key of ['machines','productionStatuses','materialStatuses','phaseStatuses'] as const)if(Object.hasOwn(patch,key)) {
        const raw=patch[key];requireProduct(Array.isArray(raw)&&raw.length<=100,'Desplegable invàlid.');
        const list=raw.map(value=>text(value,100));requireProduct(new Set(list).size===list.length,'Opcions duplicades.');
        if(key==='machines'){const used=[...state.orders.map(row=>row.assignedMachine),...state.phases.map(row=>row.machine)];requireProduct(used.every(value=>!value||list.includes(value)),'Hi ha opcions utilitzades en ordres o fases. Conserva-les o reassigna-les abans de retirar-les.',409);}
        if(key==='productionStatuses') {
          // Active choices are separate from stored historical values. Keeping
          // those values valid prevents retirement from rewriting old orders
          // or breaking a later three-way source reconciliation.
          const historical=[...new Set([...list,...state.orders.map(row=>row.productionStatus).filter((value):value is string=>!!value)])];
          requireProduct(historical.length<=100,'La llista i els estats encara utilitzats superen el límit de 100 opcions.');
          configuration.productionStatuses=list;
          state.lookups.productionStatuses=historical;
        } else if(key==='machines')state.lookups.machines=list;else configuration[key]=list;
      }
      const color=(value:unknown)=>{requireProduct(typeof value==='string'&&/^#[0-9a-fA-F]{6}$/.test(value),'Color invàlid: usa #RRGGBB.');return value;};
      if(Object.hasOwn(patch,'deliveryColors')) {
        const values=object(patch.deliveryColors);requireProduct(Object.keys(values).every(key=>['overdue','week','currentMonth','futureMonth'].includes(key)),'Regla de data desconeguda.');
        configuration.deliveryColors={...configuration.deliveryColors,...Object.fromEntries(Object.entries(values).map(([key,value])=>[key,color(value)]))};
      }
      if(Object.hasOwn(patch,'dropdownLabels')) {
        const fields=object(patch.dropdownLabels);configuration.dropdownLabels??={};
        requireProduct(Object.keys(fields).every(field=>['assignedMachine','productionStatus','materialStatus','phaseState'].includes(field)),'Desplegable desconegut.');
        for(const [field,raw] of Object.entries(fields)) {
          const labels=object(raw);requireProduct(Object.keys(labels).length<=100,'Massa etiquetes.');
          const target=configuration.dropdownLabels[field]??={};
          const options=field==='assignedMachine'?state.lookups.machines:field==='productionStatus'?state.lookups.productionStatuses:field==='materialStatus'?configuration.materialStatuses??['PENDENT','PARCIAL','REBUT','NO DEMANAT','PDT.COMPTAR']:configuration.phaseStatuses??['EN ESPERA','PREPARADA','EN PROCÉS','ACABADA'];
          for(const [value,label] of Object.entries(labels)){requireProduct(options.includes(value),'Opció desconeguda.');if(label===null)delete target[value];else target[value]=text(label,100);}
        }
      }
      if(Object.hasOwn(patch,'cellColors')) {
        const fields=object(patch.cellColors);requireProduct(Object.keys(fields).length<=40,'Massa columnes.');
        configuration.cellColors??={};
        for(const [field,raw] of Object.entries(fields)) {
          requireProduct([...orderTexts,...orderDates,...orderNumbers,'unitsPending'].includes(field as never),'Columna desconeguda.');
          const values=object(raw);requireProduct(Object.keys(values).length<=150,'Massa colors.');
          const target=configuration.cellColors[field]??={};
          const options=field==='assignedMachine'?state.lookups.machines:field==='productionStatus'?state.lookups.productionStatuses:field==='materialStatus'?configuration.materialStatuses??['PENDENT','PARCIAL','REBUT','NO DEMANAT','PDT.COMPTAR']:null;
          // Cell colors bind to stable dropdown values, not an edited display label.
          // Include values still used by historical rows without rewriting those rows.
          const known=options?[...new Set([...options,...state.orders.map(row=>row[field as keyof Order])].filter((value):value is string=>typeof value==='string'&&!!value.trim()).map(value=>value.trim()))]:null;
          const resolve=(value:string)=>{
            if(!known)return value;
            if(!value.trim())return '';
            const normalized=normalizeV7Text(value);
            const matches=known.filter(option=>normalizeV7Text(option)===normalized || normalizeV7Text(configuration.dropdownLabels?.[field]?.[option]??'')===normalized);
            return matches.length===1?matches[0]:null;
          };
          const normalized=new Map<string,string|null>();
          for(const [value,tint] of Object.entries(values)) {
            text(value,2000,true);
            const key=resolve(value)??(tint===null&&Object.hasOwn(target,value)?value:null);
            requireProduct(key!==null,'Valor de desplegable desconegut o ambigu per al color.');
            const next=tint===null?null:color(tint);
            requireProduct(!normalized.has(key)||(normalized.get(key)?.toUpperCase()??null)===(next?.toUpperCase()??null),'Colors contradictoris per a la mateixa opció.');
            normalized.set(key,next);
          }
          for(const [key,tint] of normalized) {
            // Retire only equivalent legacy aliases of the edited option; audit
            // preserves their original spelling and every unrelated override.
            if(known)for(const existing of Object.keys(target))if(resolve(existing)===key)delete target[existing];
            if(tint===null)delete target[key];else target[key]=tint;
          }
        }
      }
      const after={lookups:state.lookups,configuration};audit(ctx,state,action,'configuration',before,after,reason);result=after;
    } else if (action.startsWith('task.')) {
      const change=changeProductionTask(state,action,b);
      audit(ctx,state,action,change.target,change.before,change.after,reason);result=change.result;
    } else if (action.startsWith('order.')) {
      const requested=object(b.patch),previous=action==='order.update'?state.orders.find(row=>row.rowNumber===b.rowNumber)??{}:{};
      const markerOnly=action==='order.update'&&Object.keys(requested).length===1&&Object.hasOwn(requested,'loadMarker');
      const customized=markerOnly?{patch:requested,applied:[]}:applyProductionRules(rules,previous,requested);
      if(customized.applied.length)audit(ctx,state,'design.rules.apply',String(b.rowNumber??'new'),{designVersion:design?.versions.at(-1)?.version},{rules:customized.applied,patch:customized.patch},reason);
      let patch = orderPatch(customized.patch, {...state.lookups,productionStatuses:state.configuration?.productionStatuses??state.lookups.productionStatuses});
      let newCatalog: ProductionState['catalog'] = [];
      if (action === 'order.create' && state.sourceVersion === 'V7') {
        requireProduct(patch.reference, 'Indica la referència.');
        const matches=(state.catalog ?? []).filter(r=>normalizeV7Text(r.reference) === normalizeV7Text(patch.reference));
        if (b.referenceMode === 'catalog') {
          requireProduct(matches.length === 1, 'Referència absent o ambigua: revisa la base de dades.', 409);
          const item=matches[0];
          requireProduct((patch.client == null || patch.client === item.client) && (patch.description == null || patch.description === item.description), 'Client o descripció diferents del catàleg.', 409);
          patch={...patch,client:item.client,description:item.description};
        } else {
          requireProduct(b.referenceMode === 'new' && matches.length === 0, 'Selecciona una referència del catàleg o registra’n una de nova.', 409);
          requireProduct(patch.client && patch.description, 'La nova referència necessita client i descripció.');
          newCatalog=[{rowNumber:nextCatalogRow(state),reference:String(patch.reference),client:patch.client,description:patch.description}];
        }
      }
      requireProduct(!Object.keys(patch).some(k=>['unitsAtG03','materialMissing'].includes(k)), 'Els saldos de material es calculen a partir de les unitats rebudes i entregades.');
      if (Object.hasOwn(patch,'unitsReceivedTotal')) {
        const order = state.orders.find(o=>o.rowNumber===b.rowNumber);
        requireProduct(action==='order.update' && state.sourceVersion==='V7' && order && !order.sageKey &&
          !state.receipts.some(r=>r.workOrder===order.workOrder && r.status==='validated'),
          'Hi ha recepcions validades o dades SAGE: cal conciliar el material abans de canviar el total rebut.',409);
      }
      const machineFields = new Set(['assignedMachine', 'priority', 'showInLoad', 'loadMarker']);
      for (const k of Object.keys(patch)) grant(ctx, machineFields.has(k) ? 'machines' : 'orders');
      requireProduct(ctx.appDesigner===true || action !== 'order.update' || !productionSourceFields.some(key=>Object.hasOwn(patch,key)), 'Client, Referència i Descripció provenen de la introducció de comandes o del full d’origen i són de només lectura a Producció.');
      if (action === 'order.create') {
        requireProduct((patch.workOrder && !state.orders.some(o => o.workOrder === patch.workOrder &&
          (state.sourceVersion !== 'V7' || normalizeV7Text(o.reference)===normalizeV7Text(patch.reference)))) || state.sourceVersion === 'V7' && b.referenceOnly === true && !patch.workOrder, 'OF i referència buides o duplicades.');
        const rowNumber = Math.max(0, ...state.orders.map(o => o.rowNumber)) + 1;
        const order: Order = { rowNumber, client: null, reference: null, description: null, readyStock: null, productionStatus: null, statusComment: null, deliveryDate: null, salesOrder: null, workOrder: null, units: 0, unitsDelivered: 0, unitsPending: 0, materialEta: null, materialStatus: null, unitsReceivedTotal: null, unitsAtG03: null, materialMissing: null, assignedMachine: null, priority: null, showInLoad: null, loadText: null, loadKey: null, legacyFlag: null, ...patch };
        requireProduct((order.unitsDelivered ?? 0) <= (order.units ?? 0), 'Entrega superior al total.'); order.unitsPending = (order.units ?? 0) - (order.unitsDelivered ?? 0);
        if (state.sourceVersion === 'V7') Object.assign(order,recalculateV7({...order,formulaFields:[...v7FormulaFields]}));
        if (newCatalog.length) { state.catalog=[...(state.catalog ?? []),...newCatalog]; state.catalogDeletedReferences=(state.catalogDeletedReferences??[]).filter(ref=>ref!==normalizeV7Text(newCatalog[0].reference)); audit(ctx,state,'catalog.create',String(newCatalog[0].rowNumber),null,newCatalog[0],reason); }
        if (state.sourceVersion === 'V7') {
          const same=state.orders.filter(o=>normalizeV7Text(o.client)===normalizeV7Text(order.client));
          const lastRef=same.filter(o=>normalizeV7Text(o.reference)===normalizeV7Text(order.reference)).at(-1);
          const after=lastRef ?? same.at(-1);
          const position=after ? state.orders.indexOf(after)+1 : state.orders.findIndex(o=>normalizeV7Text(o.client)>normalizeV7Text(order.client));
          state.orders.splice(position<0?state.orders.length:position,0,order);
          state.intake ??= [];
          state.intake.push({rowNumber:Math.max(1,...state.intake.map(r=>r.rowNumber))+1,reference:String(order.reference),client:order.client,description:order.description,status:'AFEGIT AL CONTROL'});
        } else state.orders.push(order); audit(ctx, state, action, String(rowNumber), null, order, reason); result = order;
      } else {
        const rowNumber = number(b.rowNumber, 1), index = state.orders.findIndex(o => o.rowNumber === rowNumber); requireProduct(index >= 0, 'OF no trobada.', 404);
        const before = state.orders[index], next = { ...before, ...patch };
        requireProduct((next.workOrder || state.sourceVersion === 'V7' && next.reference) &&
          !state.orders.some(o=>o.rowNumber!==rowNumber && o.workOrder===next.workOrder &&
            (state.sourceVersion!=='V7' || next.workOrder && normalizeV7Text(o.reference)===normalizeV7Text(next.reference))), 'OF i referència buides o duplicades.');
        requireProduct((next.unitsDelivered ?? 0) <= (next.units ?? 0), 'Entrega superior al total.');
        if (next.workOrder !== before.workOrder) requireProduct(!state.phases.some(p => p.workOrder === before.workOrder) && !state.receipts.some(r => r.workOrder === before.workOrder) && !before.sageKey, 'OF amb fases o recepcions: conserva l’identificador.');
        if ((before.unitsAtG03 ?? 0) > 0) {
          for (const k of ['materialReference','materialUnit'] as const) requireProduct(!before[k] || next[k] === before[k], 'Material amb saldo existent: cal conciliar abans de canviar referència o unitat.');
        }
        if (state.sourceVersion !== 'V7' && Object.hasOwn(patch,'materialRequired') && typeof next.materialRequired === 'number' && next.materialUnit && next.materialReference) {
          next.materialMissing = Math.max(0,next.materialRequired-(next.unitsAtG03 ?? 0));
          next.materialStatus = next.materialMissing === 0 ? 'REBUT' : (next.unitsAtG03 ?? 0)>0 ? 'PARCIAL' : 'PENDENT';
        }
        if (state.sourceVersion === 'V7') requireProduct(before.formulaFields || !Object.keys(patch).some(k=>['units','unitsDelivered','unitsReceivedTotal','assignedMachine','priority','client','reference','description','deliveryDate','workOrder'].includes(k)), 'Cal revisar les fórmules originals de la V7 abans de canviar aquests camps.', 409);
        else if(!markerOnly) next.unitsPending = (next.units ?? 0) - (next.unitsDelivered ?? 0);
        if (state.sourceVersion === 'V7'&&!markerOnly) {
          if (Object.hasOwn(patch,'productionStatus') && v7ClearsMachine(next.productionStatus) && (before.assignedMachine || before.priority != null)) grant(ctx,'machines');
          Object.assign(next,v7EditEffects(next,patch));
        }
        state.orders[index] = next;
        audit(ctx, state, action, String(rowNumber), before, next, reason);
        if (state.sourceVersion === 'V7' && Object.hasOwn(patch,'productionStatus') && normalizeV7Text(next.productionStatus)==='ENTREGAT') {
          const historic={...next,sourceOrderRowNumber:rowNumber,rowNumber:Math.max(1,...(state.deliveredHistory ?? []).map(o=>o.rowNumber))+1,deliveredAt:new Date().toISOString()};
          state.deliveredHistory=[...(state.deliveredHistory ?? []),historic];state.orders.splice(index,1);
          const intake=state.intake ?? [];
          const ref=normalizeV7Text(next.reference),client=normalizeV7Text(next.client);
          const match=intake.findLastIndex(r=>normalizeV7Text(r.reference)===ref && normalizeV7Text(r.client)===client);
          const target=match>=0?match:intake.findLastIndex(r=>normalizeV7Text(r.reference)===ref);
          if(target>=0)intake.splice(target,1);
          audit(ctx,state,'order.archive',String(rowNumber),next,historic,reason);
        }
        result = next;
      }
    } else if (action==='phase.delete') {
      const rowNumber=number(b.rowNumber,1);requireProduct(Number.isSafeInteger(rowNumber),'Fila de fase invàlida.');
      const index=state.phases.findIndex(phase=>phase.rowNumber===rowNumber);requireProduct(index>=0,'Fase no trobada.',404);
      const [removed]=state.phases.splice(index,1);
      audit(ctx,state,action,String(rowNumber),removed,null,reason);result={deleted:true,rowNumber,workOrder:removed.workOrder};
    } else if (action.startsWith('phase.')) {
      const patch = object(b.patch); requireProduct(Object.keys(patch).every(k => ['workOrder','phaseNumber','machine','state','priority','observations','loadMarker'].includes(k)), 'Camp de fase desconegut.');
      const rowNumber = action === 'phase.create' ? Math.max(0, ...state.phases.map(p => p.rowNumber), ...state.audit.filter(entry=>entry.action.startsWith('phase.')).map(entry=>Number(entry.target)).filter(Number.isSafeInteger)) + 1 : number(b.rowNumber, 1);
      const old = state.phases.find(p => p.rowNumber === rowNumber);
      requireProduct(action === 'phase.create' || old, 'Fase no trobada.', 404);
      const v = { workOrder: null, phaseNumber: null, machine: null, state: null, priority: null, observations: null, ...old, ...patch, rowNumber };
      requireProduct(state.orders.some(o => o.workOrder === v.workOrder), 'OF desconeguda.');
      requireProduct(v.machine === null || state.lookups.machines.includes(String(v.machine)), 'Màquina desconeguda.');
      for (const k of ['phaseNumber','priority'] as const) if (v[k] !== null) number(v[k], k === 'phaseNumber' ? 1 : 0);
      for (const k of ['workOrder','machine','state','observations'] as const) if (v[k] !== null) text(v[k], 2000, true);
      if (Object.hasOwn(v,'loadMarker')) loadMarker(v.loadMarker);
      const next = v as unknown as ProductionState['phases'][number];
      if (old) state.phases[state.phases.indexOf(old)] = next; else state.phases.push(next);
      audit(ctx, state, action, String(rowNumber), old ?? null, next, reason); result = next;
    } else if (action === 'receipt.submit') {
      const receipt = { id: randomUUID(), workOrder: text(b.workOrder, 100), purchaseOrder: text(b.purchaseOrder, 100), reference: text(b.reference, 100), quantity: number(b.quantity, Number.EPSILON), unit: text(b.unit, 50), actor: ctx.actor, status: 'pending' as const };
      requireProduct(state.orders.filter(o => o.workOrder === receipt.workOrder).length === 1, 'OF desconeguda o repetida: cal conciliar la referència abans de rebre material.'); state.receipts.push(receipt); audit(ctx, state, action, receipt.id, null, receipt, reason); result = receipt;
    } else if (action === 'receipt.validate') {
      const receipt = state.receipts.find(r => r.id === b.id); requireProduct(receipt, 'Recepció desconeguda.', 404); requireProduct(receipt.status === 'pending', 'Recepció ja validada.', 409);
      const order = state.orders.find(o => o.workOrder === receipt.workOrder); requireProduct(order, 'OF desconeguda.');
      requireProduct(order.materialReference === receipt.reference && order.materialUnit === receipt.unit && typeof order.materialRequired === 'number', 'Defineix la referència, unitat i quantitat de material requerida a l’OF abans de validar.');
      if (state.sourceVersion === 'V7') requireProduct(order.formulaFields && order.materialUnit === 'unitats' && order.materialRequired === order.units, 'La V7 calcula el material en unitats de peça. Cal validar la conversió abans de registrar kg o metres.');
      const before = structuredClone({ receipt, order }); receipt.status = 'validated'; receipt.validator = ctx.actor;
      order.unitsReceivedTotal = (order.unitsReceivedTotal ?? 0) + receipt.quantity;
      if (state.sourceVersion === 'V7') Object.assign(order,recalculateV7(order));
      else { order.unitsAtG03 = (order.unitsAtG03 ?? 0) + receipt.quantity; order.materialMissing = Math.max(0, order.materialRequired - order.unitsAtG03); }
      order.materialStatus = (order.materialMissing ?? 0) <= 0 ? 'REBUT' : 'PARCIAL';
      if (state.sourceVersion === 'V7') Object.assign(order,v7EditEffects(order,{materialStatus:order.materialStatus}));
      audit(ctx, state, action, receipt.id, before, { receipt, order }, reason); result = { receipt, order, sageSync: 'no enviat a SAGE: escriptura al proveïdor encara no implementada' };
    } else if (action === 'sage.import') {
      requireProduct(Array.isArray(b.rows) && b.rows.length > 0 && b.rows.length <= 1000, 'Exportació SAGE invàlida.');
      const batch = new Set<string>(); let imported = 0, skipped = 0;
      for (const raw of b.rows) {
        const line = object(raw); const key = JSON.stringify([text(line.salesOrder,100),text(line.line,100),text(line.reference,100)]);
        requireProduct(!batch.has(key), 'Línia duplicada a l’exportació.'); batch.add(key);
        if (state.sageKeys.includes(key)) { skipped++; continue; }
        const wo = text(line.workOrder,100); requireProduct(!state.orders.some(o => o.workOrder === wo), 'La correspondència SAGE→OF entra en conflicte.');
        const p = orderPatch({ workOrder: wo, salesOrder: line.salesOrder, reference: line.reference, client: text(line.client), units: number(line.units, Number.EPSILON), deliveryDate: date(line.deliveryDate) }, state.lookups);
        const next = { rowNumber: Math.max(0,...state.orders.map(o => o.rowNumber))+1, ...p, unitsDelivered: 0, unitsPending: p.units, sageKey: key } as Order;
        state.orders.push(next); state.sageKeys.push(key); audit(ctx,state,action,key,null,next,reason); imported++;
      } result = { imported, skipped, source: 'exportació validada; no connexió live' };
    }
    requireProduct(state.audit.length <= 100000 && state.orders.length <= 10000 && (state.catalog?.length??0)<=10000 && (state.tasks?.length??0)<=10000 && state.phases.length <= 40000, 'Límit operatiu assolit.', 409);
    return { result, revision: state.revision + 1 };
  }, expected);
}
