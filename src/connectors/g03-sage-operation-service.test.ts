import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {mkdtemp,rm,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import type {SageField} from "./g03-sage-operations";
vi.mock("server-only",()=>({}));
const calls=vi.hoisted(()=>({access:vi.fn(),send:vi.fn(),tables:vi.fn(),schema:vi.fn(),read:vi.fn(),root:""}));
vi.mock("./g03-sage-service",()=>({g03SageAccess:calls.access}));
vi.mock("@/config/installation",()=>({loadInstallationConfig:async()=>({installationId:"g03-production",paths:{dataRoot:calls.root}})}));
import {g03SageOperation} from "./g03-sage-operation-service";
const user="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222",authority={threadId:"thread",turnId:"turn",requestId:"stable-human-request"};
const fields:SageField[]=[{name:"CodigoEmpresa",dataType:"smallint",nullable:false,maxLength:null,hasDefault:true},{name:"CodigoArticulo",dataType:"varchar",nullable:false,maxLength:20,hasDefault:false},{name:"DescripcionArticulo",dataType:"varchar",nullable:false,maxLength:50,hasDefault:true}];
const plan={table:"TmpIME_Articulos",action:"update",values:{CodigoArticulo:"A",DescripcionArticulo:"User's exact requested text"},reason:"User asked to update article description"};
let access:Record<string,unknown>;
beforeEach(async()=>{calls.root=await mkdtemp(path.join(tmpdir(),"sage-operation-"));calls.send.mockReset().mockResolvedValue({Message:"Imported",IdsProceso:"synthetic"});calls.tables.mockReset().mockResolvedValue(["TmpIME_Articulos"]);calls.schema.mockReset().mockResolvedValue(fields);calls.read.mockReset().mockResolvedValue({items:[{CodigoEmpresa:1,CodigoArticulo:"A",TipoArticulo:"S"}]});access={reader:{read:calls.read,importTables:calls.tables,importSchema:calls.schema,insertValidatedImport:calls.send},key:"same-config",catalogWrite:true,operations:{enabled:true,grants:[{userId:user,table:"TmpIME_Articulos",actions:["update"],identityFields:["CodigoArticulo"]}]}};calls.access.mockReset().mockImplementation(async()=>({...access}));});
afterEach(async()=>{await rm(calls.root,{recursive:true,force:true});});
async function prepare(){return await g03SageOperation("g03-production",user,"prepare",plan,authority) as {operationId:string;state:string};}
it("prepares without provider writes then dispatches once, retains actor/turn and never treats process response as business completion",async()=>{
 const p=await prepare();expect(p.state).toBe("prepared");expect(calls.send).not.toHaveBeenCalled();
 const result=await g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority);expect(result).toMatchObject({state:"submitted",businessEffectVerified:false,attempts:1});
 await g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority);await prepare();expect(calls.send).toHaveBeenCalledTimes(1);
 const saved=JSON.parse(await readFile(path.join(calls.root,"g03-sage","operations",`${p.operationId}.json`),"utf8"));expect(saved).toMatchObject({actor:user,authority,state:"submitted",reason:plan.reason});
});
it("serializes a concurrent reprepare behind dispatch without resetting the sending ledger",async()=>{
 const p=await prepare();let started!:()=>void,complete!:(value:unknown)=>void;
 const onStart=new Promise<void>(resolve=>{started=resolve;}),response=new Promise(resolve=>{complete=resolve;});
 calls.send.mockImplementationOnce(async()=>{started();return response;});
 const execution=g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority);await onStart;
 const reprepare=prepare();complete({Message:"Imported"});
 const [sent,again]=await Promise.all([execution,reprepare]);expect(sent).toMatchObject({state:"submitted"});expect(again).toMatchObject({state:"submitted"});expect(calls.send).toHaveBeenCalledTimes(1);
});
it("persists uncertain sends and recovered sending state without any replay",async()=>{
 const p=await prepare();calls.send.mockRejectedValueOnce(new Error("private transport failure"));expect(await g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority)).toMatchObject({state:"unknown",attempts:1});
 await g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority);expect(calls.send).toHaveBeenCalledTimes(1);
 const file=path.join(calls.root,"g03-sage","operations",`${p.operationId}.json`),saved=JSON.parse(await readFile(file,"utf8"));saved.state="sending";await writeFile(file,JSON.stringify(saved),{mode:0o600});
 expect(await g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority)).toMatchObject({state:"sending"});expect(calls.send).toHaveBeenCalledTimes(1);
});
it("requires user table/action grants, exact identity and catalog write, never derives writes from technical service account access",async()=>{
 access.operations={enabled:true,grants:[]};await expect(prepare()).rejects.toMatchObject({code:"SAGE_OPERATION_DENIED"});expect(calls.send).not.toHaveBeenCalled();
 access.operations={enabled:true,grants:[{userId:user,table:"TmpIME_Articulos",actions:["update"],identityFields:["MissingKey"]}]};await expect(prepare()).rejects.toMatchObject({code:"SAGE_IDENTITY_REQUIRED"});
 access.operations={enabled:true,grants:[{userId:user,table:"TmpIME_Articulos",actions:["update"],identityFields:["CodigoArticulo"]}]};const p=await prepare();access.catalogWrite=false;
 await expect(g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority)).rejects.toMatchObject({code:"SAGE_OPERATIONS_DISABLED"});expect(calls.send).not.toHaveBeenCalled();
});
it("does not let create-only permissions exploit the provider's upsert semantics, before metadata or dispatch",async()=>{
 access.operations={enabled:true,grants:[{userId:user,table:"TmpIME_Articulos",actions:["create"],identityFields:["CodigoArticulo"]}]};
 await expect(g03SageOperation("g03-production",user,"prepare",{...plan,action:"create"},authority)).rejects.toMatchObject({code:"SAGE_CREATE_CAN_UPDATE"});
 expect(calls.tables).not.toHaveBeenCalled();expect(calls.schema).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled();
 expect(await g03SageOperation("g03-production",user,"operations",{},authority)).toMatchObject({tables:[{table:"TmpIME_Articulos",actions:[]}]});
 access.operations={enabled:true,grants:[{userId:user,table:"TmpIME_Articulos",actions:["create","update"],identityFields:["CodigoArticulo"]}]};
 const available=await g03SageOperation("g03-production",user,"operations",{},authority);expect(available).toMatchObject({tables:[{table:"TmpIME_Articulos",actions:["create","update"]}]});
 expect(await g03SageOperation("g03-production",user,"prepare",{...plan,action:"create"},authority)).toMatchObject({state:"prepared"});expect(calls.send).not.toHaveBeenCalled();
});
it("fails closed on user/turn/config/schema revocation before dispatch",async()=>{
 const p=await prepare();await expect(g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},{...authority,turnId:"other"})).rejects.toMatchObject({code:"SAGE_OPERATION_REPREPARE_REQUIRED"});
 access.key="new-config";await expect(g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority)).rejects.toMatchObject({code:"SAGE_OPERATION_REPREPARE_REQUIRED"});access.key="same-config";
 calls.schema.mockResolvedValue(fields.filter(f=>f.name!=="DescripcionArticulo"));await expect(g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority)).rejects.toMatchObject({code:"SAGE_FIELD_UNKNOWN"});expect(calls.send).not.toHaveBeenCalled();
});
it("does not leak another actor's operation and binds identical plans to each authenticated actor",async()=>{
 const p=await prepare();access.operations={enabled:true,grants:[{userId:other,table:"TmpIME_Articulos",actions:["update"],identityFields:["CodigoArticulo"]}]};
 await expect(g03SageOperation("g03-production",other,"operation",{operationId:p.operationId},authority)).rejects.toMatchObject({code:"SAGE_OPERATION_NOT_FOUND"});
 const foreign=await g03SageOperation("g03-production",other,"prepare",plan,authority) as {operationId:string};expect(foreign.operationId).not.toBe(p.operationId);expect(calls.send).not.toHaveBeenCalled();
});
it("requires a trusted stable human request and permits a later distinct request without confusing it with a retry",async()=>{
 await expect(g03SageOperation("g03-production",user,"prepare",plan,{threadId:"thread",turnId:"turn"})).rejects.toMatchObject({code:"SAGE_REQUEST_AUTHORITY_REQUIRED"});
 const p=await prepare();await g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority);
 const later=await g03SageOperation("g03-production",user,"prepare",plan,{...authority,requestId:"later-human-request",turnId:"later-turn"}) as {operationId:string};expect(later.operationId).not.toBe(p.operationId);
});
it("does not release final result after revocation and does not lose the already dispatched status",async()=>{
 const p=await prepare();calls.send.mockImplementationOnce(async()=>{access.key="revoked-config";return {Message:"Imported"};});
 await expect(g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority)).rejects.toMatchObject({code:"SAGE_OPERATION_DISPATCHED_CHECK_STATUS"});
 expect(await g03SageOperation("g03-production",user,"operation",{operationId:p.operationId},authority)).toMatchObject({state:"submitted",attempts:1});expect(calls.send).toHaveBeenCalledTimes(1);
});
it.each(["TmpIME_Inventarios","TmpIME_InventariosSerie"])("requires explicit inventory dimensions in %s while preserving operator-approved empty dimensions",async(table)=>{
 const identityFields=["Inventario","CodigoArticulo","Partida","CodigoAlmacen","TipoUnidadMedida_","CodigoColor_","CodigoTalla01_",...(table.endsWith("Serie")?["NumeroSerieLc"]:[])];
 const emptyIdentityFields=["Partida","TipoUnidadMedida_","CodigoColor_","CodigoTalla01_"];
 const values={Inventario:"INV01",CodigoArticulo:"A",Partida:"",CodigoAlmacen:"001",TipoUnidadMedida_:"",CodigoColor_:"",CodigoTalla01_:"",...(table.endsWith("Serie")?{NumeroSerieLc:"SN01"}:{})};
 calls.tables.mockResolvedValue([table]);calls.schema.mockResolvedValue([fields[0],...identityFields.map(name=>({name,dataType:"varchar",nullable:false,maxLength:30,hasDefault:true}))]);
 access.operations={enabled:true,grants:[{userId:user,table,actions:["update"],identityFields,emptyIdentityFields}]};
 const result=await g03SageOperation("g03-production",user,"prepare",{table,action:"update",values,reason:"User approved exact inventory row"},authority);
 expect(result).toMatchObject({state:"prepared",payload:{tables:[{values:{Partida:"",CodigoColor_:"",CodigoTalla01_:""}}]}});expect(calls.send).not.toHaveBeenCalled();
 const omitted={...values} as Record<string,string>;delete omitted.Partida;
 await expect(g03SageOperation("g03-production",user,"prepare",{table,action:"update",values:omitted,reason:"Missing scope"},authority)).rejects.toMatchObject({code:"SAGE_IDENTITY_REQUIRED"});
 access.operations={enabled:true,grants:[{userId:user,table,actions:["update"],identityFields}]};
 await expect(g03SageOperation("g03-production",user,"prepare",{table,action:"update",values,reason:"No empty dimension permission"},authority)).rejects.toMatchObject({code:"SAGE_IDENTITY_REQUIRED"});
});
it("does not let an empty-identity policy bypass core article identity or invent a dimension",async()=>{
 for(const emptyIdentityFields of [["CodigoArticulo"],["Partida"]]){
  access.operations={enabled:true,grants:[{userId:user,table:"TmpIME_Articulos",actions:["update"],identityFields:["CodigoArticulo"],emptyIdentityFields}]};
  await expect(prepare()).rejects.toMatchObject({code:"SAGE_OPERATION_POLICY_INVALID"});
 }
 expect(calls.send).not.toHaveBeenCalled();
});
it("applies document-type permissions to the tax breakdown as well as document headers",async()=>{
 const table="TmpIME_IvaDocumento",identityFields=["CodigoDocumentoLc","EjercicioDocumento","SerieDocumento","NumeroDocumento","GrupoIva","CodigoIva"];
 const values={CodigoDocumentoLc:"FAC",EjercicioDocumento:"2026",SerieDocumento:"",NumeroDocumento:"123",GrupoIva:"1",CodigoIva:"21"};
 calls.tables.mockResolvedValue([table]);calls.schema.mockResolvedValue([fields[0],...identityFields.map(name=>({name,dataType:"varchar",nullable:false,maxLength:30,hasDefault:true}))]);
 access.operations={enabled:true,grants:[{userId:user,table,actions:["update"],identityFields}]};
 await expect(g03SageOperation("g03-production",user,"prepare",{table,action:"update",values,reason:"Requested VAT line"},authority)).rejects.toMatchObject({code:"SAGE_OPERATION_POLICY_INVALID"});
 access.operations={enabled:true,grants:[{userId:user,table,actions:["update"],identityFields,documentTypes:["ALP"]}]};
 await expect(g03SageOperation("g03-production",user,"prepare",{table,action:"update",values,reason:"Wrong fiscal scope"},authority)).rejects.toMatchObject({code:"SAGE_DOCUMENT_TYPE_DENIED"});
 access.operations={enabled:true,grants:[{userId:user,table,actions:["update"],identityFields,documentTypes:["FAC"]}]};
 expect(await g03SageOperation("g03-production",user,"prepare",{table,action:"update",values,reason:"Exact approved fiscal scope"},authority)).toMatchObject({state:"prepared"});expect(calls.send).not.toHaveBeenCalled();
});

it("preserves an existing article type when IME would default an omitted type, then rechecks the baseline",async()=>{
 calls.schema.mockResolvedValue([...fields,{name:"TipoArticulo",dataType:"varchar",nullable:false,maxLength:1,hasDefault:true}]);
 const p=await prepare();expect(calls.read).toHaveBeenCalledWith("Product",{CodigoArticulo:"A"},0,2);
 const saved=JSON.parse(await readFile(path.join(calls.root,"g03-sage","operations",`${p.operationId}.json`),"utf8"));
 expect(saved).toMatchObject({preservedFields:{TipoArticulo:"S"},payload:{tables:[{values:{CodigoArticulo:"A",DescripcionArticulo:plan.values.DescripcionArticulo,TipoArticulo:"S"}}]}});
 await g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority);expect(calls.read).toHaveBeenCalledTimes(2);expect(calls.send).toHaveBeenCalledTimes(1);
});
it("does not silently overwrite a changed preserved article type or write without a unique current baseline",async()=>{
 calls.schema.mockResolvedValue([...fields,{name:"TipoArticulo",dataType:"varchar",nullable:false,maxLength:1,hasDefault:true}]);
 const p=await prepare();calls.read.mockResolvedValue({items:[{CodigoArticulo:"A",TipoArticulo:"C"}]});
 await expect(g03SageOperation("g03-production",user,"execute",{operationId:p.operationId},authority)).rejects.toMatchObject({code:"SAGE_UPDATE_BASELINE_CHANGED"});expect(calls.send).not.toHaveBeenCalled();
 for(const items of [[],[{CodigoArticulo:"OTHER",TipoArticulo:"M"}],[{CodigoArticulo:"A"}]]){calls.read.mockResolvedValue({items});await expect(prepare()).rejects.toMatchObject({code:"SAGE_UPDATE_BASELINE_UNAVAILABLE"});}
});
it("honours an explicitly requested article type change instead of replacing it with the old type",async()=>{
 calls.schema.mockResolvedValue([...fields,{name:"TipoArticulo",dataType:"varchar",nullable:false,maxLength:1,hasDefault:true}]);
 expect(await g03SageOperation("g03-production",user,"prepare",{...plan,values:{...plan.values,TipoArticulo:"C"}},authority)).toMatchObject({payload:{tables:[{values:{TipoArticulo:"C"}}]}});expect(calls.read).not.toHaveBeenCalled();
});
