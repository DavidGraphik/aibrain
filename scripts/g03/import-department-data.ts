/** Idempotent, additive import through the normal versioned application service. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { departmentApps, appHtml, type Column } from './department-apps';
import { productContext } from '../../src/g03-products/access';
import { listApps, readApp, mutateApp } from '../../src/g03-products/apps';
import { loadInstallationConfig } from '../../src/config/installation';
import type { AuthSession } from '../../src/auth/types';
const RAFA='d720e7a3-0fc7-4606-971b-28ca28eab464';
const provenance:Column[]=['source_key','source_sha256','source_sheet','source_row','source_data'].map(name=>({name,label:name,type:'text',hidden:true}));
const extra:Record<string,Column[]>={
 'Seguiment ISO i documentació':[{name:'expires',label:'Caducitat del certificat',type:'date'},{name:'audit_date',label:'Auditoria de renovació',type:'date'}],
 'Equips i calibracions':[['equipment_type','Tipus'],['equipment_subtype','Subtipus'],['characteristics','Característiques'],['equipment_state','Estat'],['dimension','Dimensió'],['precision','Precisió'],['quantity','Quantitat','number'],['source_updated','Actualització a l’origen','date'],['source_image','Imatge original']].map(([name,label,type])=>({name,label,type:(type||'text') as Column['type']})),
 'Incidències de qualitat':[['client','Client'],['quantity','Quantitat defectuosa','number'],['pvp','PVP unitari original (€)','number'],['sales_value','Valor original (€)','number'],['reconciliation','Conciliació']].map(([name,label,type])=>({name,label,type:(type||'text') as Column['type']})),
 'Pressupostos per lots':[{name:'calculation_inputs',label:'Càlcul original versionat',type:'text',hidden:true},{name:'pvp',label:'PVP unitari original (€)',type:'number'},{name:'quote_date',label:'Data del pressupost',type:'date'},{name:'description',label:'Denominació',type:'text'},{name:'material',label:'Material',type:'text'}],
};
const intros:Record<string,string>={
 'Seguiment ISO i documentació':'Certificat ISO 9001:2015 ES161278 verificat al PDF original català de Bureau Veritas. Caducitat: 3 de febrer de 2029. La data de la pròxima auditoria de seguiment no figura al certificat; cal confirmar-la amb Rafa.',
 'Equips i calibracions':'373 registres importats de LISTADO_2026.xlsx (exportació del juny de 2026). Es conserven els dos aparells sense codi. L’exportació no inclou dates de calibració: cal contrastar els certificats i l’Access actual amb Rafa.',
 'Incidències de qualitat':'69 expedients de Maquinas i 6 registres històrics de REGISTRO. DATOS es conserva com a evidència sense duplicar expedients. El cost original de Maquinas és el valorat al 66%; l’acumulat de l’Excel requereix conciliació. Estat de tancament no informat; no implica que siguin obertes.',
 'Pressupostos per lots':'85 pressupostos originals de PRESUPUESTOS_2026_REV-0 (version 1_3).xlsm. Si hi ha PVP original, import del lot = unitats × PVP. Per a una nova estimació sense PVP: (preparació + unitats × cost) × (1 + recàrrec / 100). Sense IVA. Calculadora de preparació, mecanitzat, material, tractaments, transports, informes, mostres i utillatges reproduïda del procediment CALCULAR de la versió 1_3. Compara lots i aplica el resultat explícitament. Cal revisar el pressupost comercial abans de lliurar-lo.',
};
async function main(){
 const config=await loadInstallationConfig();assert.equal(config.installationId,'g03-production');assert.equal(config.publicUrl,'https://g03.graphikai.com');
 const session={provider:'local',tenant:{id:config.installationId},user:{id:RAFA,email:'quality@example.invalid'}} as AuthSession;
 const ctx=await productContext(session,config);
 const input=JSON.parse(await fs.readFile(process.argv[2],'utf8')) as {apps:Record<string,Record<string,unknown>[]>};
 const apply=process.argv[3]==='--apply'; const apps=await listApps(ctx);const receipt=[];
 for(const [title,records] of Object.entries(input.apps)){
  const target=apps.find(a=>a.title===title&&a.owner===RAFA);assert(target);let current=await readApp(ctx,target.id);assert(current.shared);
  const existing=new Map<unknown,(typeof current.rows)[number]>(current.rows.map(r=>[r.values.source_key,r]));assert(current.rows.every(r=>typeof r.values.source_key==='string'),'Existing untagged records require reconciliation');
  const pending=records.filter(r=>!existing.has(r.source_key));
  for(const row of records){const old=existing.get(row.source_key);if(old)assert.equal(old.values.source_sha256,row.source_sha256,'Source changed; review rather than overwrite');}
  const base=departmentApps.find(a=>a.title===title)!;
  const app={...base,intro:intros[title],columns:[...base.columns.map(c=>({...c,required:false})),...extra[title],...provenance]};assert(app.columns.length<=30);
  if(apply&&(pending.length||process.argv.includes('--refresh-ui'))){
   const html=appHtml(app);assert(!html.includes('e.checked'));
   await mutateApp(ctx,{action:'update',id:target.id,revision:current.revision,fields:app.columns,html,instruction:'Importació traçable dels fitxers originals; valors desconeguts preservats i cap eliminació.'});
   current=await readApp(ctx,target.id);
   for(const values of pending){await mutateApp(ctx,{action:'row.create',id:target.id,revision:current.revision,values});current=await readApp(ctx,target.id);}
   await mutateApp(ctx,{action:'publish',id:target.id,revision:current.revision,version:current.version.version,shared:true});
   current=await readApp(ctx,target.id,true);
   for(const row of records){const actual=current.rows.find(r=>r.values.source_key===row.source_key);assert(actual);for(const [key,value] of Object.entries(row))assert.deepEqual(actual.values[key],value);}
  }
  receipt.push({title,id:target.id,apply,sourceRows:records.length,inserted:apply?pending.length:0,pending:apply?0:pending.length,actualRows:current.rows.length,version:current.version.version,revision:current.revision});
 }
 console.log(JSON.stringify(receipt,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
