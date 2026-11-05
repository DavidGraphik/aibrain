import { expect, it, vi } from "vitest";
const read=vi.hoisted(()=>vi.fn(async()=>({items:[],companyCode:"1"})));
const operations=vi.hoisted(()=>vi.fn(async()=>({tables:[],companyCode:"1"})));
vi.mock("@/connectors/g03-sage-service",()=>({g03SageReadForIdentity:read}));
vi.mock("@/connectors/g03-sage-operation-service",()=>({g03SageOperation:operations}));
import { SAGE_QUERIES } from "@/connectors/g03-sage-api";
import { handleG03SageTool, G03_SAGE_NAMESPACE, G03_SAGE_DYNAMIC_TOOLS } from "./g03-sage-dynamic-tools";
const context={installationId:"g03-production",userId:"actor",session:{provider:"local",tenant:{id:"g03-production"},user:{id:"actor"}},runtimeThreadId:"thread",runtimeTurnId:"turn",selected:true,executeAllowed:true,requestId:"stable-human-request"} as Parameters<typeof handleG03SageTool>[1];
const params={namespace:G03_SAGE_NAMESPACE,tool:"discover",threadId:"thread",turnId:"turn",arguments:{},callId:"call"};
it("exposes typed company reads and controlled import tools and uses server identity",async()=>{
 expect(G03_SAGE_DYNAMIC_TOOLS[0]).toMatchObject({tools:[{name:"discover"},{name:"read"},{name:"operations"},{name:"schema"},{name:"prepare"},{name:"execute"},{name:"operation"}]});
 expect(await handleG03SageTool(params,context)).toMatchObject({success:true});expect(read).toHaveBeenLastCalledWith("g03-production","actor","discover",{});
});
it("rejects import plans/dispatch in read-only turns, even when generic tool execution is allowed",async()=>{
 for(const tool of ["prepare","execute"]){operations.mockClear();expect(await handleG03SageTool({...params,tool,arguments:tool==="execute"?{operationId:"a".repeat(64)}:{table:"TmpIME_Articulos",action:"create",values:{CodigoArticulo:"A"},reason:"User request"}},context)).toMatchObject({success:false});expect(operations).not.toHaveBeenCalled();}
});
it("passes exact authenticated turn authority to controlled imports and denies injected actor/URL fields",async()=>{
 operations.mockClear();const args={operationId:"a".repeat(64)};
 expect(await handleG03SageTool({...params,tool:"execute",arguments:args},{...context,allowWrites:true})).toMatchObject({success:true});
 expect(operations).toHaveBeenLastCalledWith("g03-production","actor","execute",args,{threadId:"thread",turnId:"turn",requestId:"stable-human-request"});
 for(const injected of [{userId:"foreign"},{url:"https://other.example.test"},{companyCode:2}]){operations.mockClear();expect(await handleG03SageTool({...params,tool:"execute",arguments:{...args,...injected}},{...context,allowWrites:true})).toMatchObject({success:false});expect(operations).not.toHaveBeenCalled();}
});
it("never reports no-change after a failed dispatch",async()=>{
 operations.mockRejectedValueOnce(new Error("private upstream response"));
 const response=await handleG03SageTool({...params,tool:"execute",arguments:{operationId:"a".repeat(64)}},{...context,allowWrites:true});
 expect(response.success).toBe(false);expect(JSON.stringify(response)).toContain('effectUnconfirmed');expect(JSON.stringify(response)).not.toContain('private upstream');expect(JSON.stringify(response)).not.toContain('No se ha modificado');
});
it("denies foreign thread/turn/tenant/user and execution policy before service",async()=>{
 for(const override of [{runtimeThreadId:"foreign"},{runtimeTurnId:"foreign"},{installationId:"foreign"},{userId:"another"},{executeAllowed:false},{selected:false},{session:null}]){
  read.mockClear();expect(await handleG03SageTool(params,{...context,...override})).toMatchObject({success:false});expect(read).not.toHaveBeenCalled();
 }
});
it("rejects writes, URL and company parameters at the appropriate boundary",async()=>{
 for(const p of [{...params,tool:"PutData"},{...params,arguments:{url:"https://other.test"}},{...params,tool:"read",arguments:{query:"Products",parameters:{},companyCode:2}}]){
  read.mockClear();expect(await handleG03SageTool(p,context)).toMatchObject({success:false});expect(read).not.toHaveBeenCalled();
 }
});

it("advertises the same expanded queries as the validated reader with string parameters",()=>{
 const namespace=G03_SAGE_DYNAMIC_TOOLS[0];
 expect(namespace.type).toBe("namespace");
 if(namespace.type!=="namespace")throw new Error("Expected namespace");
 const spec=namespace.tools.find(tool=>tool.name==="read")!;
 expect(spec.inputSchema).toMatchObject({properties:{query:{enum:Object.keys(SAGE_QUERIES)},parameters:{additionalProperties:false,properties:{CodigosArticulo:{type:"string",maxLength:128},Ejercicio:{type:"string"},Serie:{type:"string"},Numero:{type:"string"}}}}});
});
it("passes document reads through the existing identity-bound service",async()=>{
 const arguments_={query:"PurchaseOrder",parameters:{Ejercicio:"2026",Serie:"",Numero:"123"},take:1};
 expect(await handleG03SageTool({...params,tool:"read",arguments:arguments_},context)).toMatchObject({success:true});
 expect(read).toHaveBeenLastCalledWith("g03-production","actor","read",arguments_);
});

it('keeps native field selection server-owned and explains direct balances/exact links',async()=>{
 const namespace=G03_SAGE_DYNAMIC_TOOLS[0];
 if(namespace.type!=='namespace')throw new Error('Expected namespace');
 const spec=namespace.tools.find(tool=>tool.name==='read')!;
 expect(spec.description).toContain('Lines.UnidadesPendientes');
 expect(spec.description).toContain('origin-line UUID');
 expect(spec.inputSchema).toMatchObject({additionalProperties:false,properties:{parameters:{additionalProperties:false}}});
 for(const override of [{extraFields:[{subqueryName:'Lines',fields:'*'}]},{extraFilter:'1=1'},{sql:'SELECT *'}]){
  read.mockClear();
  expect(await handleG03SageTool({...params,tool:'read',arguments:{query:'SalesOrder',parameters:{Ejercicio:'2026',Serie:'',Numero:'42'},...override}},context)).toMatchObject({success:false});
  expect(read).not.toHaveBeenCalled();
 }
});
