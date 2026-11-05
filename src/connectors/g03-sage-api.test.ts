import { describe, expect, it, vi } from "vitest";
import { SageReader, SAGE_QUERIES, sageReadArguments, type SageCredential } from "./g03-sage-api";
const credential: SageCredential = { baseUrl:"https://sage.example.test/api",username:"user",password:"private-password",appId:"private-app",allowedQueries:["Products","Vendors","SalesOrders"] };
const login = () => Response.json({ publicToken:"private-token-1234567890",publicTokenValidTo:new Date(Date.now()+600_000).toISOString() });
const companies = () => Response.json({value:JSON.stringify([{Code:1,Name:"G03 MECANITZATS MALGRAT S.L."},{Code:2,Name:"Foreign company never returned"}])});
const catalog = () => Response.json(Object.entries(SAGE_QUERIES).map(([name,info])=>({name,parameters:["CodigoEmpresa",...info.parameters].join(", "),accessLevel:"public"})));
function provider(...tail: Response[]) { const f=vi.fn<typeof fetch>();for(const response of [login(),companies(),catalog(),...tail])f.mockResolvedValueOnce(response);return f; }
describe("SAGE predefined company1 reads",()=>{
 it("verifies company identity/catalog and returns bounded company1 data, never tokens/global companies",async()=>{
  const f=provider(Response.json({value:JSON.stringify([{CompanyId:1,Code:"P",Name:"Article",password:"hidden",nested:{access_token:"hidden"}}])}));
  const result=await new SageReader(credential,f).read("Products",{},0,2);
  expect(result).toMatchObject({companyCode:"1",items:[{CompanyId:1,Code:"P",Name:"Article",nested:{}}],nextOffset:null,complete:true});
  expect(JSON.stringify(result)).not.toMatch(/private-|Foreign company|hidden/);
  expect(f.mock.calls.map(([url])=>url)).toEqual([credential.baseUrl+"/auth/Login",credential.baseUrl+"/DataQuery/GetQuery",credential.baseUrl+"/DataQuery/GetQueryList",credential.baseUrl+"/DataQuery/GetQuery"]);
  expect(JSON.parse(String(f.mock.calls[3][1]?.body))).toEqual({queryName:"Products",parameters:{CodigoEmpresa:"1"},skip:0,take:2});
  expect(f.mock.calls.every(([,init])=>init?.method==="POST"&&init.redirect==="error")).toBe(true);
 });
 it("lists only explicitly approved company-scoped queries",async()=>{
  const f=provider();const result=await new SageReader({...credential,allowedQueries:["Products"]},f).discover();
  expect(result.queries.map(x=>x.name)).toEqual(["Products"]);
 });
 it("exposes the provider's order status semantics without claiming line quantities are outstanding",async()=>{
  const f=provider();
  const result=await new SageReader({...credential,allowedQueries:["SalesOrders"]},f).discover();
  const description=result.queries.find(query=>query.name==="SalesOrders")?.description;
  expect(description).toContain("0=abierto, 1=cerrado, 2=servido");
  expect(description).toContain("no necesariamente la pendiente");
 });
 it.each([
  ["Companies",{},0,10],["ExecuteScript",{},0,10],["Products",{CodigoEmpresa:"2"},0,10],["Products",{sql:"SELECT *"},0,10],
  ["SalesOrders",{FechaInicial:"2026-02-30",FechaFinal:"2026-03-01"},0,10],["SalesOrders",{FechaInicial:"2026-03-02",FechaFinal:"2026-03-01"},0,10],
  ["Products",{},0,51],["Products",{},5001,2],["Products",{},0,-1],
 ])("rejects query/parameter/scope/pagination overrides before HTTP (%s)",async(q,p,s,t)=>{
  const f=vi.fn<typeof fetch>();await expect(new SageReader(credential,f).read(q,p,s,t)).rejects.toMatchObject({code:"SAGE_ARGUMENTS_INVALID"});expect(f).not.toHaveBeenCalled();
 });
 it("honors query grant before login",async()=>{
  const f=vi.fn<typeof fetch>();await expect(new SageReader({...credential,allowedQueries:["Products"]},f).read("Vendors")).rejects.toMatchObject({code:"SAGE_QUERY_DENIED"});expect(f).not.toHaveBeenCalled();
 });
 it("does not grant sales delivery-note reads merely because the provider supports them",async()=>{
  const f=vi.fn<typeof fetch>();
  await expect(new SageReader(credential,f).read("LineasAlbaranVentaEntreFechas",{FechaInicial:"2026-11-01",FechaFinal:"2026-11-04"})).rejects.toMatchObject({code:"SAGE_QUERY_DENIED"});
  expect(f).not.toHaveBeenCalled();
 });
 it("fails closed if company1 was replaced or renamed",async()=>{
  const f=vi.fn<typeof fetch>().mockResolvedValueOnce(login()).mockResolvedValueOnce(Response.json({value:JSON.stringify([{Code:1,Name:"Another company"}])}));
  await expect(new SageReader(credential,f).read("Products")).rejects.toMatchObject({code:"SAGE_COMPANY_MISMATCH"});expect(f).toHaveBeenCalledTimes(2);
 });
 it("requires the actual catalog to declare exact company and query parameters",async()=>{
  const f=vi.fn<typeof fetch>().mockResolvedValueOnce(login()).mockResolvedValueOnce(companies()).mockResolvedValueOnce(Response.json([{name:"Products",parameters:"OtherCompany"}]));
  await expect(new SageReader(credential,f).read("Products")).rejects.toMatchObject({code:"SAGE_QUERY_NOT_AVAILABLE"});expect(f).toHaveBeenCalledTimes(3);
 });
 it.each([[{CompanyId:2}],[{Code:"no company proof"}],[{CompanyId:1,CodigoEmpresa:2}],[{CompanyId:1,Lines:[{CompanyId:2}]}]])("rejects misfiltered or unscoped returned rows",async row=>{
  const f=provider(Response.json([row]));await expect(new SageReader(credential,f).read("Products")).rejects.toMatchObject({code:"SAGE_COMPANY_SCOPE_INVALID"});
 });
 it("coalesces concurrent login/identity/catalog validation and preserves pagination",async()=>{
  const f=provider(Response.json([{CompanyId:1}]),Response.json([]));const reader=new SageReader(credential,f);
  const results=await Promise.all([reader.read("Products",{},0,1),reader.read("Vendors",{},1,1)]);
  expect(f.mock.calls.filter(([url])=>String(url).endsWith("auth/Login"))).toHaveLength(1);
  expect(results[0]).toMatchObject({nextOffset:1,complete:false});expect(results[1]).toMatchObject({nextOffset:null,complete:true});
 });
 it("re-authenticates once after401 and rechecks company before repeating only a read",async()=>{
  const f=provider(new Response("private provider error",{status:401}),login(),companies(),catalog(),Response.json([{CompanyId:1}]));
  expect(await new SageReader(credential,f).read("Products")).toMatchObject({items:[{CompanyId:1}]});
  expect(f).toHaveBeenCalledTimes(8);
 });
 it("redacts errors and never retries500 or malformed/oversize data",async()=>{
  for(const [response,code] of [[new Response("private-password private-token",{status:500}),"SAGE_PROVIDER_UNAVAILABLE"],[Response.json({value:"SQL error private-password"}),"SAGE_PROVIDER_RESPONSE_INVALID"],[new Response("x",{headers:{"content-length":"1048577"}}),"SAGE_RESPONSE_TOO_LARGE"]] as const){
   const f=provider(response);await expect(new SageReader(credential,f).read("Products",{},0,1)).rejects.toMatchObject({message:code});expect(f).toHaveBeenCalledTimes(4);
  }
 });
 it("shrinks oversized provider pages without skipping records or weakening the size limit",async()=>{
  const oversized=new Response("x",{headers:{"content-length":"1048577"}});
  const f=provider(oversized,Response.json([{CompanyId:1,Code:"a"},{CompanyId:1,Code:"b"}]));
  const result=await new SageReader(credential,f).read("Products",{},4,4);
  expect(result).toMatchObject({skip:4,take:2,nextOffset:6,complete:false,items:[{Code:"a"},{Code:"b"}]});
  expect(f.mock.calls.slice(3).map(([,init])=>JSON.parse(String(init?.body)))).toMatchObject([{skip:4,take:4},{skip:4,take:2}]);
 });
 it("shrinks an oversized filtered result, and fails when one row still exceeds the limit",async()=>{
  const row={CompanyId:1,Note:"a".repeat(70_000)};
  const f=provider(Response.json([row,row]),Response.json([row]));
  expect(await new SageReader(credential,f).read("Products",{},0,2)).toMatchObject({take:1,nextOffset:1,complete:false});
  const single=provider(Response.json([{CompanyId:1,Note:"a".repeat(140_000)}]));
  await expect(new SageReader(credential,single).read("Products",{},0,1)).rejects.toMatchObject({code:"SAGE_RESPONSE_TOO_LARGE"});
  expect(single).toHaveBeenCalledTimes(4);
 });
 it("does not turn size retries into extra authentication retries or bypass company checks",async()=>{
  const oversized=()=>new Response("x",{headers:{"content-length":"1048577"}});
  const f=provider(new Response("",{status:401}),login(),companies(),catalog(),oversized(),new Response("",{status:401}));
  await expect(new SageReader(credential,f).read("Products",{},0,4)).rejects.toMatchObject({code:"SAGE_AUTH_REQUIRED"});
  expect(f.mock.calls.filter(([url])=>String(url).endsWith("auth/Login"))).toHaveLength(2);
  const foreign=provider(oversized(),Response.json([{CompanyId:2}]));
  await expect(new SageReader(credential,foreign).read("Products",{},0,4)).rejects.toMatchObject({code:"SAGE_COMPANY_SCOPE_INVALID"});
 });
 it("stops at the bounded offset without claiming completeness",async()=>{
  const f=provider(Response.json([{CompanyId:1}]));expect(await new SageReader(credential,f).read("Products",{},5000,1)).toMatchObject({nextOffset:null,limitReached:true,complete:false});
 });
});

describe("SAGE purchasing and stock read contracts",()=>{
 const expandedCredential: SageCredential={...credential,allowedQueries:Object.keys(SAGE_QUERIES) as SageCredential["allowedQueries"]};
 it("pages scoped sales delivery lines and rejects another company's line",async()=>{
  const p={FechaInicial:"2026-11-01",FechaFinal:"2026-11-04"};
  const f=provider(Response.json([{CompanyId:1,CodigoArticulo:"A"}]),Response.json([]),Response.json([{CodigoEmpresa:2}]));
  const reader=new SageReader(expandedCredential,f);
  expect(await reader.read("LineasAlbaranVentaEntreFechas",p,0,1)).toMatchObject({nextOffset:1,complete:false});
  expect(await reader.read("LineasAlbaranVentaEntreFechas",p,1,1)).toMatchObject({nextOffset:null,complete:true});
  await expect(reader.read("LineasAlbaranVentaEntreFechas",p,0,1)).rejects.toMatchObject({code:"SAGE_COMPANY_SCOPE_INVALID"});
 });
 it.each([
  ["PurchaseOrders",{FechaInicial:"2026-01-01",FechaFinal:"2026-10-27"}],
  ["SalesDeliveryNotes",{FechaInicial:"2026-01-01",FechaFinal:"2026-10-27"}],
  ["LineasAlbaranVentaEntreFechas",{FechaInicial:"2026-01-01",FechaFinal:"2026-10-27"}],
  ["SalesDeliveryNote",{Ejercicio:"2026",Serie:"",Numero:"123"}],
  ["AlbaranConLineas",{Ejercicio:"2026",Serie:"",Numero:"123"}],
  ["PurchaseDeliveryNotes",{FechaInicial:"2026-01-01",FechaFinal:"2026-10-27"}],
  ["StockMovements",{FechaInicial:"2026-01-01",FechaFinal:"2026-10-27"}],
  ["SalesOrder",{Ejercicio:"2026",Serie:"",Numero:"123"}],
  ["PurchaseOrder",{Ejercicio:"2026",Serie:"A",Numero:"123"}],
  ["PurchaseDeliveryNote",{Ejercicio:"2026",Serie:"A",Numero:"123"}],
  ["Product",{CodigoArticulo:"MAT-À/01"}],
  ["ProductStock",{CodigosArticulo:"MAT-01"}],
  ["ProductKits",{}],["Stores",{}],
  ["SalesInvoice",{Ejercicio:"2026",Serie:"",Numero:"123"}],
  ["PurchaseInvoice",{Ejercicio:"2026",Serie:"A",Numero:"123"}],
  ["MovimientosConta",{Cuentas:"430000001",Ejercicio:"2026",FechaInicial:"2026-01-01",FechaFinal:"2026-11-03"}],
  ["AcumuladosConta",{Cuentas:"430000001",Ejercicio:"2026",Periodo:"11"}],
  ["PlanCuentas",{Cuenta:"430000001"}],
  ["Serialnumber",{NumeroSerie:"SERIE-01"}],
  ["SerialnumbersByProduct",{CodigoArticulo:"MAT-01"}],
  ["StockMovementsByProduct",{CodigoArticulo:"MAT-01"}],
 ])("uses the exact predefined %s parameters and pinned company",async(query,parameters)=>{
  const f=provider(Response.json([{CompanyId:1}]));
  const result=await new SageReader(expandedCredential,f).read(query,parameters,0,2);
  expect(result).toMatchObject({query,companyCode:"1",complete:true});
  expect(JSON.parse(String(f.mock.calls[3][1]?.body))).toEqual(sageReadArguments(query,parameters,0,2));
 });
 it.each([
  ["PurchaseOrders",{FechaInicial:"2026-02-30",FechaFinal:"2026-03-01"}],
  ["StockMovements",{FechaInicial:"2026-10-27",FechaFinal:"2026-01-01"}],
  ["PurchaseDeliveryNotes",{FechaInicial:"2026-01-01"}],
  ["PurchaseOrder",{Ejercicio:2026,Serie:"A",Numero:"1"}],
  ["PurchaseOrder",{Ejercicio:"2026",Serie:"A",Numero:1}],
  ["SalesOrder",{Ejercicio:"2026",Serie:"A",Numero:"1 OR 1=1"}],
  ["SalesOrder",{Ejercicio:"2026",Serie:"A\nB",Numero:"1"}],
  ["SalesOrder",{Ejercicio:"2026",Serie:"A".repeat(33),Numero:"1"}],
  ["PurchaseDeliveryNote",{Ejercicio:"0000",Serie:"A",Numero:"1"}],
  ["Product",{CodigoArticulo:""}],["Product",{CodigoArticulo:"*"}],
  ["Product",{CodigoArticulo:"A\nB"}],["Product",{CodigoArticulo:"A,B"}],
  ["Product",{CodigoArticulo:"A".repeat(129)}],
  ["ProductStock",{CodigosArticulo:["A","B"]}],
  ["ProductStock",{CodigosArticulo:"A,"}],["ProductStock",{CodigosArticulo:"A,   "}],
  ["ProductStock",{CodigosArticulo:Array.from({length:21},(_,i)=>String(i)).join(",")}],
  ["ProductStock",{CodigosArticulo:"%"}],
  ...["A'; DROP TABLE Products;--", "A;SELECT", "A\\B", "A%", "A*", "A?", 'A"B', "A\u200bB"].flatMap<[string, Record<string, string>]>(value=>[
   ["Product",{CodigoArticulo:value}],
   ["ProductStock",{CodigosArticulo:value}],
   ["SalesOrder",{Ejercicio:"2026",Serie:value,Numero:"1"}],
  ]),
  ["ProductKits",{CodigoEmpresa:"2"}],["Stores",{sql:"SELECT *"}],
  ["MovimientosConta",{Cuentas:"430,570",Ejercicio:"2026",FechaInicial:"2026-01-01",FechaFinal:"2026-11-03"}],
  ["MovimientosConta",{Cuentas:"430 OR 1=1",Ejercicio:"2026",FechaInicial:"2026-01-01",FechaFinal:"2026-11-03"}],
  ["PlanCuentas",{Cuenta:""}],["PlanCuentas",{Cuenta:"430%"}],
  ["AcumuladosConta",{Cuentas:"430",Ejercicio:"2026",Periodo:"0"}],
  ["AcumuladosConta",{Cuentas:"430",Ejercicio:"2026",Periodo:"13"}],
  ["Serialnumber",{NumeroSerie:""}],["Serialnumber",{NumeroSerie:"S".repeat(31)}],
  ["Serialnumber",{NumeroSerie:"S*"}],
 ])("rejects malformed expanded %s arguments before HTTP",async(query,parameters)=>{
  const f=vi.fn<typeof fetch>();
  await expect(new SageReader(expandedCredential,f).read(query,parameters)).rejects.toMatchObject({code:"SAGE_ARGUMENTS_INVALID"});expect(f).not.toHaveBeenCalled();
 });
 it.each([
  ["Product",{CodigoArticulo:"MAT-À/01   "}],
  ["ProductStock",{CodigosArticulo:"MAT-À/01   "}],
 ])("preserves fixed-width SAGE article codes byte-for-byte for %s",async(query,parameters)=>{
  const code="MAT-À/01   ";
  const f=provider(Response.json([{CompanyId:1,ProductId:code,password:"secret-value",nested:{access_token:"secret-value"}}]));
  const result=await new SageReader(expandedCredential,f).read(query,parameters,0,2);
  expect(JSON.parse(String(f.mock.calls[3][1]?.body))).toEqual({queryName:query,parameters:{...parameters,CodigoEmpresa:"1"},skip:0,take:2});
  expect(result).toMatchObject({companyCode:"1",items:[{CompanyId:1,ProductId:code,nested:{}}]});
  expect(JSON.stringify(result)).not.toMatch(/secret-value|private-token|private-password/);
 });
 it.each([
  ["Product",{CodigoArticulo:"   "}],
  ["Product",{CodigoArticulo:"A"+" ".repeat(128)}],
  ["ProductStock",{CodigosArticulo:"   "}],
  ["ProductStock",{CodigosArticulo:"A   ,   "}],
 ])("rejects whitespace-only or oversized padded article identifiers in %s before HTTP",async(query,parameters)=>{
  const f=vi.fn<typeof fetch>();
  await expect(new SageReader(expandedCredential,f).read(query,parameters)).rejects.toMatchObject({code:"SAGE_ARGUMENTS_INVALID"});expect(f).not.toHaveBeenCalled();
 });
 it.each([
  ["Product",{CodigoArticulo:'X01100-3"X4"'}],
  ["Product",{CodigoArticulo:'X01100-1 1/2"X3"'}],
  ["Product",{CodigoArticulo:'OTHER-0.5"x1/2"   '}],
  ["ProductStock",{CodigosArticulo:'X01100-3"X4"'}],
  ["ProductStock",{CodigosArticulo:'X01100-1 1/2"X3"'}],
 ])("preserves validated inch dimensions in real %s article identifiers",async(query,parameters)=>{
  const f=provider(Response.json([{CompanyId:1,ProductId:'X01100-3"X4"',password:'secret-value'}]));
  const result=await new SageReader(expandedCredential,f).read(query,parameters,0,2);
  expect(JSON.parse(String(f.mock.calls[3][1]?.body))).toEqual({queryName:query,parameters:{...parameters,CodigoEmpresa:"1"},skip:0,take:2});
  expect(result).toMatchObject({companyCode:"1",items:[{CompanyId:1,ProductId:'X01100-3"X4"'}]});
  expect(JSON.stringify(result)).not.toContain('secret-value');
 });
 it.each([
  'X01100-3"X4" OR 1=1', 'X01100-3"X4";SELECT', 'X01100-3"X4"\\',
  'X01100-3"X4"%','X01100-3"X4"*','X01100-3"X4"\n',
  'A" OR "1"="1', 'A"X4"', 'X01100-3"X4";--', 'X01100-3"X4"\u200b',
 ])("rejects quoted injection or malformed dimension identifiers before HTTP: %s",async(code)=>{
  for(const [query,parameters] of [["Product",{CodigoArticulo:code}],["ProductStock",{CodigosArticulo:code}]] as const){
   const f=vi.fn<typeof fetch>();await expect(new SageReader(expandedCredential,f).read(query,parameters)).rejects.toMatchObject({code:"SAGE_ARGUMENTS_INVALID"});expect(f).not.toHaveBeenCalled();
  }
 });
 it.each(['406113MP,406113','406113MP,X01100-3"X4"','MAT-01   ,MAT-02'])('rejects unsupported stock lists before HTTP rather than returning a false absence: %s',async(codes)=>{
  const f=vi.fn<typeof fetch>();
  await expect(new SageReader(expandedCredential,f).read("ProductStock",{CodigosArticulo:codes})).rejects.toMatchObject({code:"SAGE_ARGUMENTS_INVALID"});
  expect(f).not.toHaveBeenCalled();
 });
 it("keeps new queries denied until explicitly granted by server configuration",async()=>{
  const f=vi.fn<typeof fetch>();
  await expect(new SageReader(credential,f).read("PurchaseOrders",{FechaInicial:"2026-01-01",FechaFinal:"2026-10-27"})).rejects.toMatchObject({code:"SAGE_QUERY_DENIED"});expect(f).not.toHaveBeenCalled();
 });
 it("rejects foreign company nested in a purchase document",async()=>{
  const f=provider(Response.json([{CompanyId:1,Lines:[{CompanyId:2,ProductId:"foreign"}]}]));
  await expect(new SageReader(expandedCredential,f).read("PurchaseOrder",{Ejercicio:"2026",Serie:"A",Numero:"1"})).rejects.toMatchObject({code:"SAGE_COMPANY_SCOPE_INVALID"});
 });
 it("rejects a changed stock parameter declaration from the live catalog",async()=>{
  const f=vi.fn<typeof fetch>().mockResolvedValueOnce(login()).mockResolvedValueOnce(companies()).mockResolvedValueOnce(Response.json([{name:"ProductStock",parameters:"CodigoEmpresa, Articulos"}]));
  await expect(new SageReader(expandedCredential,f).read("ProductStock",{CodigosArticulo:"A"})).rejects.toMatchObject({code:"SAGE_QUERY_NOT_AVAILABLE"});expect(f).toHaveBeenCalledTimes(3);
 });
});
it('uses one ALP endpoint without retrying a failed provider write',async()=>{
 const {buildSagePurchaseReceipt}=await import('./g03-sage-receipt');const payload=buildSagePurchaseReceipt({id:'11111111-1111-4111-8111-111111111111',vendorId:'V',issueDate:'2026-10-27',receiptSerie:'R',storeId:'A',productId:'BAR',quantity:'3',purchase:{period:2026,serie:'P',number:5,position:1}}).payload;
 const f=provider(new Response('',{status:401}));await expect(new SageReader(credential,f).insertPurchaseReceipt(payload)).rejects.toMatchObject({code:'SAGE_AUTH_REQUIRED'});expect(f).toHaveBeenCalledTimes(4);expect(f.mock.calls[3][0]).toBe(credential.baseUrl+'/PutData/InsertData');expect(JSON.parse(String(f.mock.calls[3][1]?.body))).toEqual(payload);
});
it('rejects another provider write table and foreign company before login',async()=>{
 const f=vi.fn<typeof fetch>();for(const payload of [{tables:[{tableName:'TmpIME_MovimientoStock',values:{CodigoEmpresa:'1',CodigoDocumentoLc:'ALP'},lines:[{}]}]},{tables:[{tableName:'TmpIME_CabeceraDocumento',values:{CodigoEmpresa:'2',CodigoDocumentoLc:'ALP'},lines:[{}]}]}])await expect(new SageReader(credential,f).insertPurchaseReceipt(payload)).rejects.toMatchObject({code:'SAGE_WRITE_INVALID'});expect(f).not.toHaveBeenCalled();
});

describe('SAGE native pending balances and exact origin references',()=>{
 const all: SageCredential={...credential,allowedQueries:Object.keys(SAGE_QUERIES) as SageCredential['allowedQueries']};
 const date={FechaInicial:'2026-11-01',FechaFinal:'2026-11-05'};
 const document={Ejercicio:'2026',Serie:'',Numero:'42'};
 it.each([
  ['SalesOrder',document,'LineasPosicion,UnidadesPendientes,UnidadesServidas'],
  ['SalesOrders',date,'LineasPosicion,UnidadesPendientes,UnidadesServidas'],
  ['PurchaseOrder',document,'LineasPosicion,UnidadesPendientes'],
  ['PurchaseOrders',date,'LineasPosicion,UnidadesPendientes'],
  ['SalesDeliveryNote',document,'LineasPosicion,LineaPedido,EjercicioPedido,SeriePedido,NumeroPedido,UnidadesServidas'],
  ['SalesDeliveryNotes',date,'LineasPosicion,LineaPedido,EjercicioPedido,SeriePedido,NumeroPedido,UnidadesServidas'],
  ['PurchaseDeliveryNote',document,'LineasPosicion,LineaPedido,EjercicioPedido,SeriePedido,NumeroPedido'],
  ['PurchaseDeliveryNotes',date,'LineasPosicion,LineaPedido,EjercicioPedido,SeriePedido,NumeroPedido'],
 ])('requests only the fixed native Lines profile for %s',async(query,parameters,fields)=>{
  const f=provider(Response.json([{CompanyId:1,Lines:[]}]));
  await new SageReader(all,f).read(query,parameters,3,2);
  expect(JSON.parse(String(f.mock.calls[3][1]?.body))).toEqual({queryName:query,parameters:{...parameters,CodigoEmpresa:'1'},extraFields:[{subqueryName:'Lines',fields}],skip:3,take:2});
  expect(f).toHaveBeenCalledTimes(4);
 });
 it('preserves native pending quantities, explicit zero, missing/null and line units independently of ordered quantity or header status',async()=>{
  const lines=[
   {LineasPosicion:'11111111-1111-4111-8111-111111111111',ProductId:'BAR   ',Quantity:130,QuantityMeasureUnit:'BAR',UnidadesPendientes:70,UnidadesServidas:60},
   {LineasPosicion:'22222222-2222-4222-8222-222222222222',ProductId:'BAR   ',Quantity:30,QuantityMeasureUnit:'',UnidadesPendientes:0,UnidadesServidas:30},
   {LineasPosicion:'33333333-3333-4333-8333-333333333333',ProductId:'.',Quantity:2,UnidadesServidas:0},
   {LineasPosicion:'44444444-4444-4444-8444-444444444444',ProductId:'X',Quantity:9,UnidadesPendientes:null,UnidadesServidas:0},
  ];
  const f=provider(Response.json([{CompanyId:1,Status:0,Lines:lines}]));
  const result=await new SageReader(all,f).read('SalesOrder',document);
  expect(result.items).toEqual([{CompanyId:1,Status:0,Lines:lines}]);
  expect(result.nativeLineFields).toMatchObject({returnedLineCount:4,documentsMissingLines:0,linesMissingRequestedFields:1,linesWithNullRequestedFields:1});
 });
 it('preserves exact order/line references and keeps a same-product line without an origin unlinked',async()=>{
  const linked={LineasPosicion:'55555555-5555-4555-8555-555555555555',LineaPedido:'11111111-1111-4111-8111-111111111111',EjercicioPedido:2026,SeriePedido:'',NumeroPedido:42,ProductId:'BAR   ',Quantity:31,UnidadesServidas:30};
  const unlinked={...linked,LineasPosicion:'66666666-6666-4666-8666-666666666666',LineaPedido:'00000000-0000-0000-0000-000000000000',EjercicioPedido:0,NumeroPedido:0,Quantity:1,UnidadesServidas:1};
  const f=provider(Response.json([{CompanyId:1,Lines:[linked,unlinked]}]));
  const result=await new SageReader(all,f).read('SalesDeliveryNote',document);
  expect(result.items).toEqual([{CompanyId:1,Lines:[linked,unlinked]}]);
  expect(result.nativeLineFields).toMatchObject({returnedLineCount:2,linesMissingRequestedFields:0});
  expect(result.nativeLineFields?.notice).toContain('puede diferir de UnidadesServidas');
 });
 it('reports absent document lines without fabricating a complete line balance',async()=>{
  const result=await new SageReader(all,provider(Response.json([{CompanyId:1}]))).read('PurchaseOrder',document);
  expect(result.nativeLineFields).toMatchObject({returnedLineCount:0,documentsMissingLines:1});
  expect(result.items).toEqual([{CompanyId:1}]);
 });
 it('keeps the native profile, offset and scoped validation through bounded size retry and one reauthentication',async()=>{
  const f=provider(new Response('x',{headers:{'content-length':'1048577'}}),new Response('',{status:401}),login(),companies(),catalog(),Response.json([{CompanyId:1,Lines:[{CompanyId:1,UnidadesPendientes:0,LineasPosicion:'11111111-1111-4111-8111-111111111111'}]}]));
  const result=await new SageReader(all,f).read('PurchaseOrders',date,4,4);
  expect(result).toMatchObject({skip:4,take:2,nextOffset:null,complete:true});
  const bodies=f.mock.calls.filter(([url,init])=>String(url).endsWith('/DataQuery/GetQuery')&&JSON.parse(String(init?.body)).queryName==='PurchaseOrders').map(([,init])=>JSON.parse(String(init?.body)));
  expect(bodies).toEqual([4,2,2].map(take=>({queryName:'PurchaseOrders',parameters:{...date,CodigoEmpresa:'1'},extraFields:[{subqueryName:'Lines',fields:'LineasPosicion,UnidadesPendientes'}],skip:4,take})));
  expect(f.mock.calls.every(([url])=>!String(url).includes('/PutData/'))).toBe(true);
 });
 it.each(['extraFields','extraFilter','fields','subqueryName','sql'])('rejects a caller override of %s before HTTP',async(key)=>{
  const f=vi.fn<typeof fetch>();
  await expect(new SageReader(all,f).read('SalesOrder',{...document,[key]:'Unrestricted'})).rejects.toMatchObject({code:'SAGE_ARGUMENTS_INVALID'});
  expect(f).not.toHaveBeenCalled();
 });
 it('rejects a foreign company hidden in enriched lines',async()=>{
  const f=provider(Response.json([{CompanyId:1,Lines:[{CodigoEmpresa:2,UnidadesPendientes:7}]}]));
  await expect(new SageReader(all,f).read('PurchaseOrder',document)).rejects.toMatchObject({code:'SAGE_COMPANY_SCOPE_INVALID'});
 });
});
