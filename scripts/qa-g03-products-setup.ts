/** Local QA only: synthetic users/data, no credentials or provider dispatch. */
import { randomBytes } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseInstallationConfig } from '../src/config/installation-schema';
import { UserProvisioner } from '../src/users/provisioner';
import { FileLocalSessionStore } from '../src/auth/local-session-store';
import { ProductStore } from '../src/g03-products/persistence';
import { mutateProduction,previewImport } from '../src/g03-products/production';
import { mutateApp } from '../src/g03-products/apps';
async function main() {
const root=path.resolve(process.argv[2]??'/tmp/g03-products-local-qa');
if(!root.startsWith('/tmp/') && !root.startsWith('/private/tmp/'))throw Error('QA root must be temporary');
await mkdir(root,{recursive:true,mode:0o700});
const template=JSON.parse(await readFile('config/installations/playwright-isolated.example.json','utf8'));
const config=parseInstallationConfig({...template,installationId:'g03-qa',companyName:'G03 Mecanitzats · QA local',companySlug:'g03',publicUrl:'http://localhost:3199',branding:{...template.branding,productName:'G03 AI · QA'},paths:{dataRoot:path.join(root,'data'),companyContextRoot:path.join(root,'data/company'),usersRoot:path.join(root,'data/users'),backupsRoot:path.join(root,'data/backups'),sourceReadRoot:path.join(root,'source-ro'),publishWriteRoot:path.join(root,'publish-rw')}});
await writeFile(path.join(root,'installation.json'),JSON.stringify(config),{mode:0o600});
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const grants=['read','orders','machines','receipts','validate-receipts','import','apps'] as const;
await writeFile(path.join(root,'policy.json'),JSON.stringify({installationId:'g03-qa',users:{[ids[0]]:grants,[ids[1]]:['read','machines','apps']}}),{mode:0o600});
const sessions=new FileLocalSessionStore({rootDirectory:path.join(config.paths.dataRoot,'sessions')});
for(const [i,id]of ids.entries()) { await new UserProvisioner(config).provision({userId:id,email:`g03-qa-${i}@example.test`,displayName:i===0?'Jordi · QA':'Rafa · QA',requireInitialPasswordChange:false});const session=await sessions.create('g03-qa',id);await writeFile(path.join(root,`storage-${i}.json`),JSON.stringify({cookies:[{name:'__Host-aibrain-session',value:session.sessionId,domain:'localhost',path:'/',secure:true,httpOnly:true,sameSite:'Lax',expires:Math.floor(session.record.absoluteExpiresAt/1000)}],origins:[]}),{mode:0o600}); }
const store=new ProductStore(path.join(config.paths.dataRoot,'g03-products'),'g03-qa'),ctx={installationId:'g03-qa',actor:ids[0],grants:[...grants],store};
if(!await store.read('production')){
 const dataset={capturedAt:new Date().toISOString(),sourceVersion:'QA SINTÈTIC · no és la V6 de Jordi',spreadsheet:{title:'Dades de prova locals'},lookups:{machines:['OKUMA MA-600HIII','MORI NV4000','FANUC ROBODRILL 1'],productionStatuses:['NO COMENÇAT','PARAT','EN PRODUCCIÓ - FASE 1','LLEST PER SERVIR','ENTREGAT AL CLIENT']},orders:Array.from({length:24},(_,i)=>({rowNumber:i+30,client:`Client QA ${i%4+1}`,reference:`QA-${100+i}`,description:'Peça sintètica per validar el flux',workOrder:`OF-QA-${i+1}`,salesOrder:`PV-QA-${i+1}`,units:100+i*10,unitsDelivered:i%3*10,productionStatus:i%4===0?'PARAT':'NO COMENÇAT',statusComment:null,deliveryDate:'2026-10-12',assignedMachine:['OKUMA MA-600HIII','MORI NV4000','FANUC ROBODRILL 1'][i%3],priority:i+1,materialStatus:i%2?'REBUT':'PENDENT',unitsAtG03:0,unitsReceivedTotal:0,materialReference:'MP-QA-1',materialRequired:5,materialUnit:'kg'})),phases:[{rowNumber:1,workOrder:'OF-QA-1',phaseNumber:2,machine:'MORI NV4000',state:'EN ESPERA',priority:1,observations:'Acabat posterior'}]};
 const p=previewImport(dataset);await mutateProduction(ctx,{action:'import.commit',dataset,sha256:p.sha256,revision:0,reason:'QA local amb dades sintètiques'});
 const html=`<style>body{font:16px system-ui;padding:28px;color:#21313d}button,input{padding:10px;margin:8px 0}button{background:#21313d;color:white;border:0;border-radius:6px}li{padding:10px 0}</style><h1>Registre de revisions · QA</h1><p>Dades sintètiques persistents dins d’AI Brain.</p><form id="form"><label>Equip <input id="title" required></label><button>Desar revisió</button></form><p id="status"></p><ul id="rows"></ul><script>let revision=0;async function load(){const d=await aibrain.data('list');revision=d.revision;document.querySelector('#rows').replaceChildren(...d.rows.map(r=>{let li=document.createElement('li');li.textContent=r.values.title;return li}))}document.querySelector('#form').onsubmit=async e=>{e.preventDefault();try{const d=await aibrain.data('create',{revision,values:{title:document.querySelector('#title').value}});revision=d.revision;document.querySelector('#status').textContent='Desat al servidor';await load()}catch(e){document.querySelector('#status').textContent=e.message}};load().catch(e=>document.querySelector('#status').textContent=e.message)</script>`;
 const app=await mutateApp(ctx,{action:'create',title:'Registre de revisions · QA',html,fields:[{name:'title',type:'text',required:true}],instruction:'QA de programa amb base de dades'}) as {id:string};
 await mutateApp(ctx,{action:'publish',id:app.id,revision:1,version:1,shared:true});await writeFile(path.join(root,'app-id.txt'),app.id);
}
await writeFile(path.join(root,'session-secret'),randomBytes(32).toString('hex'),{mode:0o600});
console.log(`QA prepared in ${root}; no client data or credentials used.`);

}
void main().catch(error=>{console.error(error);process.exitCode=1;});
