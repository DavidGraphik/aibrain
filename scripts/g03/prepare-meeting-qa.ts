/** Synthetic local QA; does not read or mutate client data. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {ProductStore} from '../../src/g03-products/persistence';
import {mutateProduction,previewImport,readProduction} from '../../src/g03-products/production';
import {mutateApp,readApp} from '../../src/g03-products/apps';
import {v7FormulaFields} from '../../src/g03-products/v7-logic';
import type {Grant} from '../../src/g03-products/contracts';
async function main(){
const root=process.argv[2];if(!root?.startsWith('/tmp/'))throw Error('Temporary QA root required');
const installationId='g03-qa',store=new ProductStore(path.join(root,'data/g03-products'),installationId),ctx={installationId,actor:'11111111-1111-4111-8111-111111111111',grants:['read','orders','machines','receipts','validate-receipts','import','apps'] as Grant[],store};
const state=await readProduction(ctx);
const names=['BASE DE DADES','INTRO COMANDES','CONTROL PRODUCCIÓ','CARGA TREBALL MAQUINARIA','FASES OF','HISTÒRIC ENTREGATS','TASQUES ','CARGA_HELPER','BACKUP CARGA MANUAL','LLISTES AUXILIARS'];
const dataset={...state,sourceVersion:'V7',capturedAt:new Date().toISOString(),catalog:[{rowNumber:2,reference:'QA-100',client:'Client QA 1',description:'Peça sintètica per validar el flux'}],intake:[],sheets:names.map(name=>({name,dimension:'A1:B2',cells:{A1:{value:'Dades sintètiques',formula:null,format:'General'},B2:{value:8,formula:'=10-2',format:'0'}}})),orders:state.orders.map(o=>({...o,formulaFields:[...v7FormulaFields],materialRequired:o.units,materialUnit:'unitats'}))};
const p=previewImport(dataset);await mutateProduction(ctx,{action:'import.commit',dataset,sha256:p.sha256,revision:state.revision,reason:'Synthetic V7 UI verification'});
const id=(await readFile(path.join(root,'app-id.txt'),'utf8')).trim(),app=await readApp(ctx,id);
await mutateApp(ctx,{action:'update',id,revision:app.revision,title:app.title,html:app.version.html+'<p>Versió 2 · QA</p>',fields:app.version.fields,instruction:'Synthetic revision for recovery QA'});
console.log('Synthetic V7 and app recovery QA prepared.');
}
void main().catch(e=>{console.error(e);process.exitCode=1});
