import "server-only";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { loadInstallationConfig } from "@/config/installation";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import { g03SageAccess } from "./g03-sage-service";
import { SageError, sageRecord } from "./g03-sage-api";
import { buildSageImport, sageImportAction, sageImportTable, type SageImportAction, type SageImportTable } from "./g03-sage-operations";

type Authority={threadId:string;turnId:string;requestId?:string};
type Grant={table:SageImportTable;actions:SageImportAction[];identityFields:string[];emptyIdentityFields:string[];documentTypes:string[]};
const documentTable=(table:SageImportTable)=>table==="TmpIME_CabeceraDocumento"||table==="TmpIME_IvaDocumento";
// Empty dimensions identify the unbatched/uncoloured/unsized inventory row;
// omitting them is different from explicitly selecting the empty dimension.
const emptyDimensions:Partial<Record<SageImportTable,readonly string[]>>={
  TmpIME_CabeceraDocumento:["SerieDocumento"],
  TmpIME_IvaDocumento:["SerieDocumento","CuentaIvaSoportado","CuentaRecargo"],
  TmpIME_Inventarios:["Partida","TipoUnidadMedida_","CodigoColor_","CodigoTalla01_"],
  TmpIME_InventariosSerie:["Partida","TipoUnidadMedida_","CodigoColor_","CodigoTalla01_"],
};
type Operation={schema:1;installationId:string;actor:string;id:string;payloadHash:string;table:SageImportTable;action:SageImportAction;payload:ReturnType<typeof buildSageImport>["payload"];reason:string;preservedFields?:Record<string,string>;connection:string;authority:Authority;createdAt:string;preparedAt:string;expiresAt:number;state:"prepared"|"sending"|"submitted"|"unknown";attempts:number;dispatchedAt?:string;result?:unknown;error?:string};
const fail=(code:string):never=>{throw new SageError(code);};
const checkedId=(value:unknown)=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value)?value:fail("SAGE_OPERATION_INVALID");
function policy(raw:unknown,userId:string){
  if(raw===undefined)return {enabled:false,grants:[] as Grant[]};
  if(!sageRecord(raw)||typeof raw.enabled!=="boolean"||!Array.isArray(raw.grants)||raw.grants.length>1000)return fail("SAGE_OPERATION_POLICY_INVALID");
  const grants:Grant[]=[];
  for(const value of raw.grants){
    if(!sageRecord(value)||typeof value.userId!=="string"||!/^[a-f0-9-]{36}$/.test(value.userId)||!Array.isArray(value.actions)||!value.actions.length||!Array.isArray(value.identityFields)||!value.identityFields.length||value.identityFields.length>32||value.identityFields.some(k=>typeof k!=="string"||!k.length||k.length>128))return fail("SAGE_OPERATION_POLICY_INVALID");
    const identityFields=value.identityFields as string[],table=sageImportTable(value.table),actions=value.actions.map(sageImportAction),documentTypes=value.documentTypes??[],emptyIdentityFields=value.emptyIdentityFields??[];
    if(new Set(identityFields).size!==identityFields.length||!Array.isArray(emptyIdentityFields)||new Set(emptyIdentityFields).size!==emptyIdentityFields.length||emptyIdentityFields.some(k=>typeof k!=="string"||!identityFields.includes(k)||!emptyDimensions[table]?.includes(k)))return fail("SAGE_OPERATION_POLICY_INVALID");
    if(!Array.isArray(documentTypes)||documentTypes.some(k=>typeof k!=="string"||!/^[A-Z0-9]{1,10}$/.test(k))||documentTable(table)&&!documentTypes.length)return fail("SAGE_OPERATION_POLICY_INVALID");
    if(value.userId===userId){if(grants.some(g=>g.table===table))return fail("SAGE_OPERATION_POLICY_INVALID");grants.push({table,actions,identityFields,emptyIdentityFields:emptyIdentityFields as string[],documentTypes:documentTypes as string[]});}
  }
  return {enabled:raw.enabled,grants};
}
function summary(record:Operation){return {source:"SAGE",companyCode:"1",operationId:record.id,table:record.table,action:record.action,state:record.state,attempts:record.attempts,preparedAt:record.preparedAt,dispatchedAt:record.dispatchedAt??null,result:record.result??null,error:record.error??null,businessEffectVerified:false,notice:record.state==="prepared"?"Preparado; no se ha enviado nada a SAGE.":"El estado registra el envío a la API, no acredita el efecto final en SAGE. No repetir una operación enviada o incierta; comprobar la entidad con read."};}
async function root(installationId:string){const config=await loadInstallationConfig();if(config.installationId!==installationId||!path.isAbsolute(config.paths.dataRoot))return fail("SAGE_ACCESS_DENIED");return path.join(config.paths.dataRoot,"g03-sage","operations");}
async function read(directory:string,id:string):Promise<Operation|null>{
  try{const file=path.join(directory,`${id}.json`),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0||stat.size>256*1024)return fail("SAGE_OPERATION_STORAGE_INVALID");const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let value:unknown;try{value=JSON.parse(await handle.readFile("utf8"));}finally{await handle.close();}
    if(!sageRecord(value)||value.schema!==1||value.installationId!=="g03-production"||value.id!==id||typeof value.actor!=="string"||!sageRecord(value.payload)||!sageRecord(value.authority)||!["prepared","sending","submitted","unknown"].includes(String(value.state))||!Number.isSafeInteger(value.attempts))return fail("SAGE_OPERATION_STORAGE_INVALID");return value as Operation;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
}
async function save(directory:string,record:Operation){await mkdir(directory,{recursive:true,mode:0o700});await atomicWriteFile(path.join(directory,`${record.id}.json`),JSON.stringify(record),{mode:0o600});}
function permitted(grants:Grant[],table:SageImportTable,action:SageImportAction){
  const grant=grants.find(g=>g.table===table&&g.actions.includes(action))??fail("SAGE_OPERATION_DENIED");
  if(action==="create"&&!grant.actions.includes("update"))return fail("SAGE_CREATE_CAN_UPDATE");
  return grant;
}
function effectiveActions(grant:Grant|undefined){return grant?.actions.filter(action=>action!=="create"||grant.actions.includes("update"))??[];}
function checkKeys(grant:Grant,payload:ReturnType<typeof buildSageImport>["payload"]){
  const values=payload.tables[0].values;
  for(const key of grant.identityFields)if(!Object.hasOwn(values,key)||key!=="SerieDocumento"&&!grant.emptyIdentityFields.includes(key)&&!values[key].trim())return fail("SAGE_IDENTITY_REQUIRED");
  if(documentTable(grant.table)&&!grant.documentTypes.includes(values.CodigoDocumentoLc))return fail("SAGE_DOCUMENT_TYPE_DENIED");
}
// Real IME article updates default an omitted TipoArticulo to M. Preserve the
// existing type rather than letting a description/price edit convert a service
// or comment article. Bind that preserved baseline and recheck before dispatch.
async function articleType(reader:Awaited<ReturnType<typeof g03SageAccess>>["reader"],code:unknown){
  if(typeof code!=="string"||!code.trim())return fail("SAGE_IDENTITY_REQUIRED");
  const result=await reader.read("Product",{CodigoArticulo:code},0,2),rows=result.items;
  if(!Array.isArray(rows)||rows.length!==1||!sageRecord(rows[0])||String(rows[0].CodigoArticulo).trimEnd()!==code.trimEnd()||typeof rows[0].TipoArticulo!=="string"||rows[0].TipoArticulo.length!==1)return fail("SAGE_UPDATE_BASELINE_UNAVAILABLE");
  return rows[0].TipoArticulo;
}
export async function g03SageOperation(installationId:string,userId:string,operation:"operations"|"schema"|"prepare"|"execute"|"operation",args:Record<string,unknown>,authority:Authority){
  const initial=await g03SageAccess(installationId,userId),current=policy(initial.operations,userId);
  if(operation==="operations"){
    const tables=await initial.reader.importTables(),fresh=await g03SageAccess(installationId,userId);if(fresh.key!==initial.key)return fail("SAGE_CONNECTION_CHANGED");
    return {source:"SAGE",companyCode:"1",tables:tables.map(table=>({table,actions:effectiveActions(current.grants.find(g=>g.table===table)),identityFields:current.grants.find(g=>g.table===table)?.identityFields??[],emptyIdentityFields:current.grants.find(g=>g.table===table)?.emptyIdentityFields??[],documentTypes:current.grants.find(g=>g.table===table)?.documentTypes??[]})),writeEnabled:current.enabled&&initial.catalogWrite,providerIdentity:"installation-service-account",actor:userId,importSemantics:{create:"IME0; provider may modify if the business key already exists; requires both create and update grants",update:"IME2",delete:"IME1",conditionalWrite:false,providerIdempotencyGuaranteed:false,finalBusinessEffectRequiresReadback:true},notice:"Las tablas disponibles del proveedor no otorgan permisos al usuario. Sólo actions asignadas por la política del servidor son ejecutables; no se supone que la cuenta compartida tenga los permisos personales de Sage. Datos de OF/conversión se resuelven al pedir cada operación, no por adelantado. Las importaciones generales no actualizan automáticamente Producció; para ese efecto usar receiving. Las dimensiones vacías autorizadas deben enviarse explícitas, nunca omitirse. IVA requiere el documento y todos sus discriminantes fiscales; no tratar IdRegistroIME ausente como clave. MovConta requiere el UUID real del movimiento y readback de la cuenta, ejercicio y asiento; un acuse IME no acredita un asiento."};
  }
  if(operation==="schema"){
    const table=sageImportTable(args.table),tables=await initial.reader.importTables();if(!tables.includes(table))return fail("SAGE_TABLE_DENIED");
    const fields=await initial.reader.importSchema(table),lines=table==="TmpIME_CabeceraDocumento"?await initial.reader.importSchema("TmpIME_LineasDocumento"):undefined;
    const fresh=await g03SageAccess(installationId,userId);if(fresh.key!==initial.key)return fail("SAGE_CONNECTION_CHANGED");
    return {source:"SAGE",companyCode:"1",table,fields,...(lines?{lineFields:lines}:{}),apiControls:{CodigoEmpresa:"injected1",TipoImportacionIME:"injected by action; create0/update2/delete1"},notice:"La metadata describe tipos/longitudes/defaults de base de datos, no los requisitos empresariales. Resolver los datos con fuentes verificables o con el usuario en el chat; no rellenar precios, cantidades ni claves por suposición."};
  }
  const directory=await root(installationId),locks=new ResourceLockManager({rootDirectory:path.join(directory,".locks")});
  if(["prepare","execute"].includes(operation)&&(typeof authority.requestId!=="string"||!authority.requestId.length||authority.requestId.length>200))return fail("SAGE_REQUEST_AUTHORITY_REQUIRED");
  if(operation==="prepare"){
    const table=sageImportTable(args.table),action=sageImportAction(args.action),grant=permitted(current.grants,table,action),tables=await initial.reader.importTables();if(!tables.includes(table))return fail("SAGE_TABLE_DENIED");
    const fields=await initial.reader.importSchema(table),lineFields=table==="TmpIME_CabeceraDocumento"?await initial.reader.importSchema("TmpIME_LineasDocumento"):undefined;
    let values=args.values,preservedFields:Record<string,string>|undefined;
    if(table==="TmpIME_Articulos"&&action==="update"&&fields.some(f=>f.name==="TipoArticulo")&&sageRecord(values)&&!Object.hasOwn(values,"TipoArticulo")){
      preservedFields={TipoArticulo:await articleType(initial.reader,values.CodigoArticulo)};values={...values,...preservedFields};
    }
    const built=buildSageImport({table,action,values,lines:args.lines},fields,lineFields);checkKeys(grant,built.payload);
    if(typeof args.reason!=="string"||!args.reason.trim()||args.reason.length>1000)return fail("SAGE_REASON_REQUIRED");
    const fresh=await g03SageAccess(installationId,userId);if(fresh.key!==initial.key)return fail("SAGE_CONNECTION_CHANGED");
    const id=createHash("sha256").update(JSON.stringify([installationId,userId,authority.requestId,built.id])).digest("hex");
    return locks.withLock("prepare",async()=>locks.withLock(id,async lease=>{
      const old=await read(directory,id);if(old&&old.actor!==userId)return fail("SAGE_OPERATION_ALREADY_EXISTS");
      if(old&&old.state!=="prepared")return summary(old);
      if(!old&&(await readdir(directory)).filter(file=>/^[a-f0-9]{64}\.json$/.test(file)).length>=1000)return fail("SAGE_OPERATION_STORAGE_LIMIT");
      const now=new Date().toISOString(),record:Operation={schema:1,installationId,actor:userId,id,payloadHash:built.id,table,action,payload:built.payload,reason:args.reason as string,...(preservedFields?{preservedFields}:{}),connection:initial.key,authority,createdAt:old?.createdAt??now,preparedAt:now,expiresAt:Date.now()+15*60_000,state:"prepared",attempts:0};
      await lease.assertHeld();await save(directory,record);return {...summary(record),payload:record.payload,...(record.preservedFields?{preservedFields:record.preservedFields}:{}),writeEnabled:current.enabled&&initial.catalogWrite,expiresAt:new Date(record.expiresAt).toISOString()};
    }));
  }
  const id=checkedId(args.operationId);
  return locks.withLock(id,async lease=>{
    const record=await read(directory,id);if(!record||record.actor!==userId)return fail("SAGE_OPERATION_NOT_FOUND");permitted(current.grants,record.table,record.action);
    if(operation==="operation")return summary(record);
    if(record.state!=="prepared")return summary(record); // Sending/unknown is never resubmitted, including after a process restart.
    if(!current.enabled||!initial.catalogWrite)return fail("SAGE_OPERATIONS_DISABLED");
    if(record.connection!==initial.key||record.expiresAt<Date.now()||record.authority.threadId!==authority.threadId||record.authority.turnId!==authority.turnId||record.authority.requestId!==authority.requestId)return fail("SAGE_OPERATION_REPREPARE_REQUIRED");
    const tables=await initial.reader.importTables();if(!tables.includes(record.table))return fail("SAGE_TABLE_DENIED");
    const fields=await initial.reader.importSchema(record.table),lineFields=record.table==="TmpIME_CabeceraDocumento"?await initial.reader.importSchema("TmpIME_LineasDocumento"):undefined;
    const raw=record.payload.tables[0],strip=(v:Record<string,string>)=>Object.fromEntries(Object.entries(v).filter(([key])=>!["CodigoEmpresa","TipoImportacionIME"].includes(key)));
    const checked=buildSageImport({table:record.table,action:record.action,values:strip(raw.values),lines:raw.lines?.map(v=>strip(v.line))},fields,lineFields);if(checked.id!==record.payloadHash)return fail("SAGE_OPERATION_CHANGED");checkKeys(permitted(current.grants,record.table,record.action),checked.payload);
    if(record.preservedFields&&record.table==="TmpIME_Articulos"&&await articleType(initial.reader,record.payload.tables[0].values.CodigoArticulo)!==record.preservedFields.TipoArticulo)return fail("SAGE_UPDATE_BASELINE_CHANGED");
    const fresh=await g03SageAccess(installationId,userId),latest=policy(fresh.operations,userId);if(fresh.key!==initial.key||!fresh.catalogWrite||!latest.enabled)return fail("SAGE_CONNECTION_CHANGED");permitted(latest.grants,record.table,record.action);
    await lease.assertHeld();record.state="sending";record.attempts=1;record.dispatchedAt=new Date().toISOString();await save(directory,record);
    try{record.result=await fresh.reader.insertValidatedImport(record.payload);record.state="submitted";}
    catch(error){record.state="unknown";record.error=error instanceof SageError?error.code:"SAGE_OPERATION_UNCONFIRMED";}
    await lease.assertHeld();await save(directory,record);
    // Do not release results after policy revocation, but preserve the durable uncertain dispatch.
    const after=await g03SageAccess(installationId,userId);if(after.key!==initial.key||!after.catalogWrite)return fail("SAGE_OPERATION_DISPATCHED_CHECK_STATUS");
    return summary(record);
  });
}
