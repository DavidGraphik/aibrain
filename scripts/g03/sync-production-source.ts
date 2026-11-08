/** G03-only operator. Uses a fixed reviewed public sheet, never model-selected URLs. */
import {mkdtemp, readFile, writeFile, rm, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadInstallationConfig} from '../../src/config/installation';
import {productContextForIdentity} from '../../src/g03-products/access';
import type {ProductionState} from '../../src/g03-products/contracts';
import {syncProductionSource,prepareProductionSourceDataset,productionSourceSemanticVersion} from '../../src/g03-products/source-sync';
import {validateUploadedDocumentFile} from '../../src/documents/upload-validation';
import {atomicWriteFile} from '../../src/storage';
import {fetchPublicProductionWorkbook} from '../../src/g03-products/source-download';
import {FileLocalUserStore} from '../../src/auth/local-user-store';
declare const __G03_V7_IMPORTER__: string;
const run=promisify(execFile);
let failureStatusPath:string|null=null;
async function exportedInput(fileId:string){
 const chunks:Buffer[]=[];let bytes=0;
 for await(const chunk of process.stdin){const data=Buffer.from(chunk);bytes+=data.length;if(bytes>10*1024*1024+1024)throw Error('G03_SOURCE_DOWNLOAD_TOO_LARGE');chunks.push(data);}
 const all=Buffer.concat(chunks),newline=all.indexOf(10);if(newline<1||newline>512)throw Error('G03_SOURCE_INPUT_INVALID');
 const header=JSON.parse(all.subarray(0,newline).toString('utf8'));
 const captured=Date.parse(header.capturedAt);if(header.schemaVersion!==1||header.fileId!==fileId||!Number.isFinite(captured)||captured>Date.now()+60000||captured<Date.now()-10*60000)throw Error('G03_SOURCE_INPUT_INVALID');
 if(typeof header.errorCode==='string'&&['G03_SOURCE_CONNECTION_REQUIRED','G03_SOURCE_DOWNLOAD_FAILED','G03_SOURCE_REDIRECT_DENIED','G03_SOURCE_DOWNLOAD_TOO_LARGE'].includes(header.errorCode))throw Error(header.errorCode);
 return{data:all.subarray(newline+1),capturedAt:header.capturedAt as string};
}
async function privateJson(file:string) {
 const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o077)!==0||s.size>32*1024*1024)throw Error('G03_SOURCE_PRIVATE_FILE_REQUIRED');
 return JSON.parse(await readFile(file,'utf8'));
}
async function main(){
 const args=process.argv.slice(2);
 if(args.length===2&&args[0]==='--fetch'){
  const exported=await fetchPublicProductionWorkbook(args[1]);process.stdout.write(JSON.stringify({schemaVersion:1,fileId:args[1],capturedAt:exported.capturedAt})+'\n');process.stdout.write(exported.data);return;
 }
 if(![2,3].includes(args.length)||args[0]!=='--config'||!isAbsolute(args[1])||args.length===3&&args[2]!=='--stdin-export')throw Error('G03_SOURCE_CLI_ARGUMENTS_INVALID');
 const config=await loadInstallationConfig();if(config.installationId!=='g03-production'||config.publicUrl!=='https://g03.graphikai.com')throw Error('G03_SOURCE_INSTALLATION_DENIED');
 const settings=await privateJson(args[1]);
 if(settings.schemaVersion!==1||settings.installationId!==config.installationId||!/^[-a-f0-9]{36}$/.test(settings.actor)||typeof settings.apply!=='boolean'||!isAbsolute(settings.statusPath)||!isAbsolute(settings.baselinePath))throw Error('G03_SOURCE_CONFIG_INVALID');
 const actor=await new FileLocalUserStore(config.paths.usersRoot).read(settings.actor);if(!actor?.enabled)throw Error('G03_SOURCE_ACTOR_DISABLED');
 if(settings.statusPath!==join(config.paths.dataRoot,'g03-products/source-sync/status.json')||!settings.baselinePath.startsWith(join(config.paths.dataRoot,'g03-products/source-sync/')))throw Error('G03_SOURCE_PATH_DENIED');
 failureStatusPath=settings.statusPath;
 const ctx=await productContextForIdentity(config.installationId,settings.actor,config),state=await ctx.store.read<ProductionState>('production');if(!state)throw Error('G03_SOURCE_PRODUCTION_NOT_INITIALIZED');
 const temp=await mkdtemp(join(tmpdir(),'g03-source-'));
 try{
  const {data,capturedAt}=args[2]==='--stdin-export'?await exportedInput(settings.fileId):await fetchPublicProductionWorkbook(settings.fileId);
  const workbook=join(temp,'source.xlsx');await writeFile(workbook,data,{mode:0o600});
  const validated=await validateUploadedDocumentFile({fileName:'source.xlsx',declaredMimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',filePath:workbook});
  const importer=join(temp,'import.py'),output=join(temp,'dataset.json');await writeFile(importer,__G03_V7_IMPORTER__,{mode:0o600});
  await run('/usr/bin/python3',['-I',importer,workbook,output],{timeout:120000,maxBuffer:2*1024*1024});
  const normalized=prepareProductionSourceDataset(JSON.parse(await readFile(output,'utf8')),capturedAt);
  const archived=normalized.sourcePhaseArchive??[];
  const version=productionSourceSemanticVersion(normalized);
  const baseline=await privateJson(settings.baselinePath);
  const resolutions=settings.resolution?.sourceVersion===version?settings.resolution.items:undefined;
  const plan=await syncProductionSource(ctx,{source:{fileId:settings.fileId,modifiedAt:capturedAt,version},dataset:normalized,baseline,revision:state.revision,apply:settings.apply,resolutions,allowSafePartial:settings.allowSafePartial===true});
  await atomicWriteFile(settings.statusPath,JSON.stringify({schemaVersion:1,installationId:config.installationId,checkedAt:capturedAt,sourceHash:validated.sha256,sourceVersion:version,sourcePhaseArchive:archived,sourceOrders:normalized.orders.length,applied:plan.applied,unchanged:'unchanged'in plan&&plan.unchanged===true,revision:'revision'in plan?plan.revision:state.revision,conflicts:plan.conflicts,status:plan.conflicts.length?'conflicts':settings.apply?'current':'preview'}));
  console.log(JSON.stringify({status:plan.conflicts.length?'conflicts':settings.apply?'current':'preview',sourceOrders:normalized.orders.length,archivedSourcePhases:archived.length,conflicts:plan.conflicts.length,applied:plan.applied}));
  if(plan.conflicts.length)process.exitCode=2;
 }finally{await rm(temp,{recursive:true,force:true});}
}
void main().catch(async error=>{const code=error instanceof Error&&/^G03_SOURCE_[A-Z_]+$/.test(error.message)?error.message:'G03_SOURCE_SYNC_FAILED';if(failureStatusPath)await atomicWriteFile(failureStatusPath,JSON.stringify({schemaVersion:1,installationId:'g03-production',checkedAt:new Date().toISOString(),status:code==='G03_SOURCE_CONNECTION_REQUIRED'?'connection_required':'failed',errorCode:code}));console.error(code);process.exitCode=1;});
