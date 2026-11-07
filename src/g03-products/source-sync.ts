import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '@/storage';
import { grant, type ProductContext } from './access';
import { object, requireProduct, validateDataset, type Dataset, type ProductionState, type Order } from './contracts';
import {recalculateV7, v7EditEffects, v7FormulaFields, normalizeV7Text} from './v7-logic';

/** Source data never authorizes writes: callers supply the authenticated owner context. */
export type ProductionSource = { fileId: string; modifiedAt: string; version: string };
export type SourceSyncConflict = { collection: string; key: string; field: string; reason: string };
export type SourceSyncResolution = {collection:string;key:string;field:string;take:'source'|'local';expectedLocal:unknown;expectedSource:unknown;reason:string};
type SyncedState = ProductionState & { sourceSync?: { fileId: string; version: string; modifiedAt: string; baseline: string; checkedAt: string; pendingConflicts?:SourceSyncConflict[] } };
const json = (v: unknown): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const same = (a: unknown, b: unknown) => json(a) === json(b);
const digest = (v: unknown) => createHash('sha256').update(json(v)).digest('hex');
/** ZIP timestamps/capture time alone do not mean the source values changed. */
export function productionSourceSemanticVersion(dataset:Dataset) {
  const {sourceHash,capturedAt,...values}=dataset;void sourceHash;void capturedAt;return digest(values);
}
/** Preserve retired/unlinked source phases without admitting phantom live OFs. */
export function prepareProductionSourceDataset(raw:unknown,capturedAt?:string):Dataset {
  const value=structuredClone(object(raw));
  requireProduct(Array.isArray(value.orders)&&value.orders.length<=10000&&Array.isArray(value.phases)&&value.phases.length<=40000,'Origen de Producció massa gran.');
  const active=new Set(value.orders.map(row=>object(row).workOrder));
  const history=new Set((Array.isArray(value.deliveredHistory)?value.deliveredHistory:[]).map(row=>object(row).workOrder));
  const archived=value.phases.filter(row=>!active.has(object(row).workOrder));
  value.phases=value.phases.filter(row=>active.has(object(row).workOrder));
  value.sourcePhaseArchive=[...(Array.isArray(value.sourcePhaseArchive)?value.sourcePhaseArchive:[]),...archived];
  value.importIssues=[...(Array.isArray(value.importIssues)?value.importIssues:[]),...archived.map(row=>{
    const p=object(row);return `Fase original ${p.rowNumber}, OF ${p.workOrder}: conservada a l’arxiu de fases de la font; ${history.has(p.workOrder)?'consta a l’històric entregat i no té OF activa':'no hi ha cap OF activa vinculada'}.`;
  })];
  if(capturedAt)value.capturedAt=capturedAt;
  return validateDataset(value);
}
const cleanRow = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'rowNumber'));
const orderKey = (r: Record<string, unknown>) => json([r.workOrder ?? '', r.reference ?? '', r.client ?? '']);
const collectionKeys: Record<string, (r: Record<string, unknown>) => string> = {
  orders: orderKey, deliveredHistory: r => json(cleanRow(r)),
  phases: r => json([r.workOrder, r.phaseNumber, r.machine]), catalog: r => json([r.reference, r.client]),
  intake: r => json(cleanRow(r)), tasks: r => json([r.owner, r.description]),
};
function source(value: ProductionSource) {
  requireProduct(/^[A-Za-z0-9_-]{10,150}$/.test(value.fileId) && /^\d{4}-\d{2}-\d{2}T/.test(value.modifiedAt)
    && Number.isFinite(Date.parse(value.modifiedAt)) && /^[A-Za-z0-9._:-]{1,150}$/.test(value.version), 'Origen de Producció invàlid.');
  return value;
}
/** Three-way, field-level merge. Row positions are not identities; conflicts stop the entire update. */
export function reconcileProductionSource(current: ProductionState, baselineRaw: unknown, incomingRaw: unknown, resolutions:SourceSyncResolution[] = [], pending:SourceSyncConflict[] = []) {
  const baseline = validateDataset(baselineRaw), incoming = validateDataset(incomingRaw);
  requireProduct(baseline.sourceVersion === 'V7' && incoming.sourceVersion === 'V7' && current.sourceVersion === 'V7', 'Només es pot sincronitzar el format V7 verificat.');
  const conflicts: SourceSyncConflict[] = [];
  const resolved: SourceSyncConflict[] = [];
  requireProduct(Array.isArray(resolutions) && resolutions.length<=100 && resolutions.every(r=>r && typeof r.collection==='string' && typeof r.key==='string' && r.key.length<=4000 && typeof r.field==='string' && ['source','local'].includes(r.take) && typeof r.reason==='string' && r.reason.trim().length>0 && r.reason.length<=1000),'Conciliació explícita invàlida.');
  const merged: Dataset = structuredClone(incoming);
  for (const [collection, key] of Object.entries(collectionKeys)) {
    const get = (dataset: Dataset) => (dataset[collection as keyof Dataset] ?? []) as Record<string, unknown>[];
    const maps = [baseline, current, incoming].map(dataset => {
      const rows = get(dataset), result = new Map<string, Record<string, unknown>>();
      const occurrences = new Map<string, number>();
      for (const row of rows) {
        // A catalog deletion is an explicit local decision, including after the
        // source changes or removes/reintroduces that reference on a later poll.
        if(collection==='catalog'&&current.catalogDeletedReferences?.includes(normalizeV7Text(row.reference)))continue;
        let id = key(row);
        // Intake/history may legitimately contain repeated identical source
        // rows. Preserve their multiplicity; operational identities stay unique.
        if (collection === 'intake' || collection === 'deliveredHistory') {
          const occurrence = occurrences.get(id) ?? 0; occurrences.set(id, occurrence + 1); id = `${id}#${occurrence}`;
        }
        if (result.has(id)) conflicts.push({collection, key: id, field: '*', reason: 'Identitat duplicada: cal conciliar les línies.'}); else result.set(id, row);
      }
      return result;
    });
    const [before, local, remote] = maps;
    const result: Record<string, unknown>[] = [];
    let nextRow = Math.max(0, ...get(current).map(r => Number(r.rowNumber))) + 1;
    for (const id of new Set([...remote.keys(), ...local.keys(), ...before.keys()])) {
      const b = before.get(id), l = local.get(id), r = remote.get(id);
      const eq = (a: Record<string, unknown> | undefined, z: Record<string, unknown> | undefined) => {
        const derivedLoadKey = collection === 'orders' && [a,z].every(row=>Array.isArray(row?.formulaFields)&&row.formulaFields.includes('loadKey'));
        const comparable=(row:Record<string,unknown>|undefined)=>row&&Object.fromEntries(Object.entries(cleanRow(row)).filter(([field])=>!derivedLoadKey||field!=='loadKey'));
        return same(comparable(a),comparable(z));
      };
      let row: Record<string, unknown> | undefined;
      if (!b) {
        if (l && r && !eq(l, r)) conflicts.push({collection, key: id, field: '*', reason: 'Línia nova diferent a les dues fonts.'});
        row = l ?? r;
      } else if (!l || !r) {
        let blocked=false;
        const divergentRemoval=(!eq(l, b) && !eq(r, b) || pending.some(item=>item.collection===collection&&item.key===id&&item.field==='*')) && !eq(l, r);
        // A source removal with receipts/Sage must be reconciled explicitly.
        const protectedRemoval=l && !r && collection==='orders' && (l.sageKey || current.receipts.some(receipt=>receipt.workOrder===l.workOrder));
        const resolution=resolutions.find(item=>item.collection===collection&&item.key===id&&item.field==='*');
        if((divergentRemoval||protectedRemoval) && resolution && same(resolution.expectedLocal,l??null) && same(resolution.expectedSource,r??null) && !(protectedRemoval&&resolution.take==='source')) {
          // Null explicitly identifies an absent row. Sticky conflicts have no
          // original fingerprint, so even a reorder-only one needs exact review.
          row=resolution.take==='local'?l:r;
          resolved.push({collection,key:id,field:'*',reason:resolution.reason});
        } else {
          if(divergentRemoval){conflicts.push({collection,key:id,field:'*',reason:'Una font ha retirat una línia que l’altra ha modificat.'});blocked=true;}
          if(protectedRemoval){conflicts.push({collection,key:id,field:'*',reason:'Hi ha recepcions o moviments SAGE vinculats a una línia retirada.'});blocked=true;}
          row=blocked?l:undefined;
        }
      } else {
        row = {...l};
        const derived = collection === 'orders' ? new Set(v7FormulaFields.filter(field => [b,l,r].every(value => Array.isArray(value.formulaFields) && value.formulaFields.includes(field)))) : new Set<string>();
        for (const field of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
          if (field === 'rowNumber' || derived.has(field)) continue;
          const unresolved=pending.some(item=>item.collection===collection&&item.key===id&&item.field===field)&&!same(l[field],r[field]);
          if (!unresolved && same(l[field], b[field])) { if (Object.hasOwn(r, field)) row[field] = r[field]; else delete row[field]; }
          else if (unresolved || !same(r[field], b[field]) && !same(l[field], r[field])) {
            const resolution=resolutions.find(item=>item.collection===collection&&item.key===id&&item.field===field);
            if(resolution && same(resolution.expectedLocal,l[field]) && same(resolution.expectedSource,r[field])) {
              if(resolution.take==='source') {if(Object.hasOwn(r,field))row[field]=r[field];else delete row[field];}
              resolved.push({collection,key:id,field,reason:resolution.reason});
            } else conflicts.push({collection, key: id, field, reason: 'El mateix camp ha canviat a les dues fonts.'});
          }
        }
        if (collection === 'orders') {
          const order = row as Order;
          Object.assign(row, !same(order.productionStatus,l.productionStatus)
            ? v7EditEffects(order,{productionStatus:order.productionStatus}) : recalculateV7(order));
        }
      }
      if (row) result.push({...row, rowNumber: l?.rowNumber ?? nextRow++});
    }
    Object.assign(merged, {[collection]: result});
  }
  merged.lookups = {
    machines: [...new Set([...incoming.lookups.machines.filter(value=>!baseline.lookups.machines.includes(value)||current.lookups.machines.includes(value)), ...current.lookups.machines])],
    productionStatuses: [...new Set([...incoming.lookups.productionStatuses.filter(value=>!baseline.lookups.productionStatuses.includes(value)||current.lookups.productionStatuses.includes(value)), ...current.lookups.productionStatuses])],
  };
  merged.importIssues = [...new Set([...(incoming.importIssues ?? []), ...(current.importIssues ?? [])])];
  merged.sourcePhaseArchive = [...new Map([...(current.sourcePhaseArchive??[]),...(incoming.sourcePhaseArchive??[])].map(phase=>[json(phase),phase])).values()];
  // Full application validation remains mandatory after merging identities and fields.
  const dataset = validateDataset(merged);
  return {dataset, conflicts, resolved, sourceOrders: incoming.orders.length, currentOrders: current.orders.length,
    mergedOrders: dataset?.orders.length ?? null, baselineHash: digest(baseline), incomingHash: digest(incoming)};
}

export async function syncProductionSource(ctx: ProductContext, input: { source: ProductionSource; dataset: unknown; baseline?: unknown; revision: number; apply?: boolean; resolutions?:SourceSyncResolution[]; allowSafePartial?:boolean }) {
  grant(ctx, 'import'); source(input.source);
  requireProduct(Number.isSafeInteger(input.revision) && input.revision >= 0, 'Revisió invàlida.');
  const current = await ctx.store.read<SyncedState>('production');
  requireProduct(current && current.revision === input.revision, 'Producció ha canviat; torna a comparar la font.', 409);
  const prior = current.sourceSync;
  if (prior) {
    requireProduct(prior.fileId === input.source.fileId, 'La font és diferent de la font vinculada.', 409);
    requireProduct(Date.parse(input.source.modifiedAt) >= Date.parse(prior.modifiedAt), 'La font rebuda és més antiga que la sincronitzada.', 409);
  }
  let baseline = input.baseline;
  if (prior) {
    const file = path.join(ctx.store.root, 'source-sync', 'baselines', `${prior.baseline}.json`);
    const stat = await lstat(file);
    requireProduct(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size <= 32 * 1024 * 1024, 'Base de sincronització insegura.', 503);
    baseline = JSON.parse(await readFile(file, 'utf8'));
    requireProduct(digest(validateDataset(baseline)) === prior.baseline, 'La base de sincronització ha canviat.', 503);
  } else {
    requireProduct(baseline && validateDataset(baseline).sourceHash && validateDataset(baseline).sourceHash === current.sourceHash, 'Falta la còpia exacta de l’última importació per conciliar els canvis.', 409);
  }
  const plan = reconcileProductionSource(current, baseline, input.dataset,input.resolutions,prior?.pendingConflicts);
  if (!input.apply || plan.conflicts.length && !input.allowSafePartial) return {...plan, applied: false};
  if (prior?.version === input.source.version && !plan.resolved.length) return {...plan, applied: false, unchanged: true};
  const incoming = validateDataset(input.dataset);
  // Persist content-addressed source before the CAS commit. A crash can leave an
  // unreferenced source, never a state pointing to a missing baseline.
  await atomicWriteFile(path.join(ctx.store.root, 'source-sync', 'baselines', `${plan.incomingHash}.json`), json(incoming));
  await ctx.store.mutate<SyncedState, void>('production', () => current, state => {
    Object.assign(state, plan.dataset!);
    state.sourceSync = {...input.source, baseline: plan.incomingHash, checkedAt: new Date().toISOString(),pendingConflicts:plan.conflicts};
    state.audit.push({at: new Date().toISOString(), actor: ctx.actor, action: 'source.sync', target: input.source.fileId,
      before: {sourceHash: current.sourceHash, revision: current.revision}, after: {sourceHash: incoming.sourceHash, sourceVersion: input.source.version,resolutions:plan.resolved,pendingConflicts:plan.conflicts},
      reason: 'Sincronització de la font autoritzada amb conciliació de tres versions; recepcions, auditoria i canvis locals conservats.'});
  }, input.revision);
  return {...plan, applied: true, revision: input.revision + 1};
}
