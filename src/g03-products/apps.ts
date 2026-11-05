import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { grant, type ProductContext } from './access';
import { date, number, object, requireProduct, text, type Field, type MiniApp } from './contracts';
export function fields(raw: unknown): Field[] {
  requireProduct(Array.isArray(raw) && raw.length <= 30, 'Esquema invàlid.');
  const names = new Set<string>();
  return raw.map(value => { const f = object(value); const name = text(f.name, 50); requireProduct(/^[a-z][a-z0-9_]*$/.test(name) && !['__proto__','constructor','prototype'].includes(name) && !names.has(name), 'Nom de camp invàlid.'); names.add(name); requireProduct(['text','number','boolean','date'].includes(String(f.type)) && (f.required === undefined || typeof f.required === 'boolean'), 'Tipus invàlid.'); return { name, type: f.type as Field['type'], required: f.required === true }; });
}
function values(raw: unknown, schema: Field[]) {
  const v = object(raw); requireProduct(Object.keys(v).every(k => schema.some(f => f.name === k)), 'Camp desconegut.');
  const result: Record<string, unknown> = {};
  for (const f of schema) { const value = v[f.name]; if (value === undefined || value === null || value === '') { requireProduct(!f.required, `Falta ${f.name}.`); result[f.name] = null; continue; }
    if (f.type === 'text') result[f.name] = text(value, 5000, true);
    else if (f.type === 'number') { requireProduct(typeof value === 'number' && Number.isFinite(value), 'Nombre invàlid.'); result[f.name] = value; }
    else if (f.type === 'date') result[f.name] = date(value);
    else { requireProduct(typeof value === 'boolean', 'Booleà invàlid.'); result[f.name] = value; }
  } return result;
}
const key = (id: unknown) => { const s = text(id,36); requireProduct(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s), 'App invàlida.'); return `app-${s}`; };
const summary = (app: MiniApp) => ({ id: app.id, title: app.title, owner: app.owner, revision: app.revision, latestVersion: app.versions.at(-1)!.version, publishedVersion: app.publishedVersion, shared: app.shared, productionManaged:app.productionManaged===true });
export async function readApp(ctx: ProductContext, id: unknown, published = false) {
  const app = await ctx.store.read<MiniApp>(key(id)); requireProduct(app, 'App no trobada.', 404);
  requireProduct(app.owner === ctx.actor || ctx.appDesigner===true && app.productionManaged===true || app.shared && app.publishedVersion !== null && published, 'Accés no autoritzat.', 403);
  if (published) requireProduct(app.publishedVersion !== null, 'App no publicada.', 404);
  const version = app.versions.find(v => v.version === (published ? app.publishedVersion : app.versions.at(-1)!.version))!;
  return { ...summary(app), version, canWriteRecords: ctx.appRecordsWritable !== false, ...(app.owner===ctx.actor || ctx.appDesigner===true && app.productionManaged===true ? {versions:app.versions.map(v=>({version:v.version,at:v.at,actor:v.actor,instruction:v.instruction})),audit:app.audit} : {}), ...ctx.appRecordsWritable!==false?{retiredRows:app.deletedRows??[]}:{}, rows: app.rows.map(row => ({ ...row, values: Object.fromEntries(version.fields.map(field => [field.name, row.values[field.name] ?? null])) })) };
}
export async function listApps(ctx: ProductContext) {
  let names: string[]; try { names = await readdir(ctx.store.root); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const result = [];
  for (const name of names.filter(n => /^app-[a-f0-9-]{36}\.json$/.test(n))) { const app = await ctx.store.read<MiniApp>(name.slice(0,-5)); if (app && (app.owner === ctx.actor || ctx.appDesigner===true && app.productionManaged===true || app.shared && app.publishedVersion !== null)) result.push(summary(app)); }
  return result.sort((a,b) => a.title.localeCompare(b.title));
}
export async function mutateApp(ctx: ProductContext, raw: unknown) {
  const b = object(raw), action = text(b.action,30);
  if(b.activate!==undefined)requireProduct(typeof b.activate==='boolean','Activació invàlida.');
  if(b.activate===true)requireProduct(ctx.appDesigner===true,'No tens permís per activar programes de Producció.',403);
  requireProduct(['create','update','restore','publish','unpublish','row.create','row.update','row.delete','row.restore'].includes(action), 'Acció desconeguda.');
  if (!action.startsWith('row.')) grant(ctx,'apps');
  else requireProduct(ctx.appRecordsWritable !== false, 'Només tens permís de consulta en aquesta aplicació.', 403);
  const id = action === 'create' ? randomUUID() : text(b.id,36), file = key(id), expected = action === 'create' ? 0 : number(b.revision);
  requireProduct(Number.isSafeInteger(expected), 'Revisió invàlida.');
  return ctx.store.mutate<MiniApp, unknown>(file, () => ({ id, owner: ctx.actor, title: '', revision: 0, versions: [], publishedVersion: null, shared: false, rows: [], audit: [] }), app => {
    requireProduct(action === 'create' || app.versions.length > 0, 'App no trobada.', 404);
    const owner = app.owner === ctx.actor || ctx.appDesigner===true && app.productionManaged===true;
    requireProduct(owner || action.startsWith('row.') && app.shared && app.publishedVersion !== null, 'Accés no autoritzat.', 403);
    let before: unknown = { revision: app.revision, sourceVersion:app.versions.at(-1)?.version, publishedVersion: app.publishedVersion, shared: app.shared };
    let after: unknown;
    if (action === 'create' || action === 'update' || action === 'restore') {
      const chosen=action==='restore' ? app.versions.find(v=>v.version===b.version) : undefined;
      requireProduct(action!=='restore' || chosen,'Versió desconeguda.',404);
      const schema = fields(chosen?.fields ?? b.fields), html = text(chosen?.html ?? b.html,250000), instruction = text(b.instruction,2000);
      // Existing database columns may be extended but never silently removed or retyped.
      if (app.rows.length) for (const old of app.versions.at(-1)!.fields) requireProduct(schema.some(f => f.name === old.name && f.type === old.type && (!f.required || old.required)), 'Esquema incompatible amb les dades existents.');
      if (app.rows.length) requireProduct(schema.every(f => !f.required || app.versions.at(-1)!.fields.some(old => old.name === f.name)), 'Els nous camps han de ser opcionals.');
      if (action === 'create') {app.title = text(b.title,120);if(b.activate===true)app.productionManaged=true;}
      else if(b.title!==undefined)app.title=text(b.title,120);
      if(action!=='create')requireProduct(app.versions.length > 0, 'App no trobada.',404);
      app.versions.push({ version: app.versions.length + 1, at: new Date().toISOString(), actor: ctx.actor, html, fields: schema, instruction });
      if(b.activate===true){app.publishedVersion=app.versions.at(-1)!.version;app.shared=true;app.productionManaged=true;}
    } else if (action === 'publish') {
      const version = number(b.version,1); requireProduct(Number.isSafeInteger(version) && app.versions.some(v => v.version === version), 'Versió desconeguda.');
      const chosen = app.versions.find(v => v.version === version)!;
      for (const row of app.rows) values(Object.fromEntries(chosen.fields.map(f => [f.name, row.values[f.name] ?? null])), chosen.fields);
      requireProduct(typeof b.shared === 'boolean', 'Tria qui pot obrir l’app.'); app.publishedVersion = version; app.shared = b.shared;
    } else if (action === 'unpublish') { app.publishedVersion = null; app.shared = false; }
    else {
      const published = b.published === true;
      requireProduct(owner || published, 'Accés no autoritzat.',403);
      const version = app.versions.find(v => v.version === (published ? app.publishedVersion : app.versions.at(-1)?.version)); requireProduct(version,'Versió no disponible.',404);
      if(action==='row.delete'||action==='row.restore'){
        const source=action==='row.delete'?app.rows:(app.deletedRows??[]),index=source.findIndex(r=>r.id===b.rowId),row=source[index];
        requireProduct(row,'Fila no trobada.',404);requireProduct(row.revision===b.rowRevision,'Fila modificada per una altra persona.',409);before=structuredClone(row);
        if(action==='row.delete'){source.splice(index,1);(app.deletedRows??=[]).push(row);after={retired:true,rowId:row.id};}
        else{requireProduct(!app.rows.some(r=>r.id===row.id),'La fila ja està activa.',409);values(Object.fromEntries(version.fields.map(f=>[f.name,row.values[f.name]??null])),version.fields);source.splice(index,1);row.revision++;app.rows.push(row);after=structuredClone(row);}
      }else{
      const next = values(b.values,version.fields);
      before=action==='row.update' ? structuredClone(app.rows.find(r=>r.id===b.rowId) ?? null) : null;
      if (action === 'row.create') { const row={ id: randomUUID(), revision: 1, values: next };app.rows.push(row);after=structuredClone(row); }
      else { const row = app.rows.find(r => r.id === b.rowId); requireProduct(row,'Fila no trobada.',404); requireProduct(row.revision === b.rowRevision,'Fila modificada per una altra persona.',409); row.values = { ...row.values, ...next }; row.revision++;after=structuredClone(row); }
      }
      requireProduct(app.rows.length+(app.deletedRows?.length??0) <= 10000, 'Límit de dades assolit.');
    }
    requireProduct(app.versions.length <= 500, 'Límit de versions assolit.');
    app.audit.push({ at: new Date().toISOString(), actor: ctx.actor, action, target: id, before, after: after ?? { revision: app.revision + 1, sourceVersion:app.versions.at(-1)?.version, publishedVersion: app.publishedVersion, shared: app.shared }, reason: typeof b.instruction === 'string' ? b.instruction.slice(0,2000) : action });
    return { ...summary(app), revision: app.revision + 1, url: `/g03/apps?id=${id}`, previewUrl: `/api/g03/apps/preview?id=${id}`, ...(ctx.appDesigner?{designPreviewUrl:`/g03/production/preview?id=${id}`}:{ }), publishedUrl: app.publishedVersion ? `/g03/apps?id=${id}&published=1` : null };
  }, expected);
}
