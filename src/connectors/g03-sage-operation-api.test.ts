import {expect,it,vi} from "vitest";
import {SageReader,type SageCredential} from "./g03-sage-api";
const credentials:SageCredential={baseUrl:"https://sage.example.test/api",username:"synthetic",password:"private",appId:"test",allowedQueries:["Products"]};
const companies = () => Response.json([{Code:1,Name:"G03 MECANITZATS MALGRAT S.L."}]);
const catalog = () => Response.json([{name:"Products",parameters:"CodigoEmpresa"}]);
function provider(...responses:Response[]){const f=vi.fn<typeof fetch>();for(const response of [Response.json({publicToken:"synthetic-token-12345"}),companies(),catalog(),...responses])f.mockResolvedValueOnce(response);return f;}
const fields=[{Name:"CodigoEmpresa",DataType:"smallint",IsNullable:"NO",MaxLength:null,HasDefault:"YES"}];
it("reads table capabilities and actual field metadata using the documented POST bodies",async()=>{
 const f=provider(Response.json([{name:"TmpIME_Articulos"},{name:"UnreviewedTable"}]),Response.json({value:JSON.stringify(fields)})),reader=new SageReader(credentials,f);
 expect(await reader.importTables()).toEqual(["TmpIME_Articulos"]);expect(await reader.importSchema("TmpIME_Articulos")).toMatchObject([{name:"CodigoEmpresa",dataType:"smallint"}]);
 expect(f.mock.calls.slice(3).map(([url,init])=>({url,body:JSON.parse(String(init?.body))}))).toEqual([{url:credentials.baseUrl+"/PutData/allowedTables",body:{}},{url:credentials.baseUrl+"/DataQuery/GetTableFields",body:"TmpIME_Articulos"}]);
});
it("rejects foreign-company or undocumented imports before login, and never retries a failed IME dispatch",async()=>{
 const p={tables:[{tableName:"TmpIME_Articulos" as const,values:{CodigoEmpresa:"1",TipoImportacionIME:"2",CodigoArticulo:"A"}}]},f=provider(new Response("private-provider-error",{status:401})),reader=new SageReader(credentials,f);
 await expect(reader.insertValidatedImport({...p,tables:[{...p.tables[0],values:{...p.tables[0].values,CodigoEmpresa:"2"}}]})).rejects.toMatchObject({code:"SAGE_WRITE_INVALID"});expect(f).not.toHaveBeenCalled();
 await expect(reader.insertValidatedImport(p)).rejects.toMatchObject({code:"SAGE_AUTH_REQUIRED"});expect(f).toHaveBeenCalledTimes(4);
});
it("does not retain an unbounded provider result as a durable successful business response",async()=>{
 const f=provider(Response.json({Message:"x".repeat(130*1024)}));
 await expect(new SageReader(credentials,f).insertValidatedImport({tables:[{tableName:"TmpIME_Articulos",values:{CodigoEmpresa:"1",TipoImportacionIME:"2",CodigoArticulo:"A"}}]})).rejects.toMatchObject({code:"SAGE_WRITE_RESPONSE_TOO_LARGE"});
});
it("keeps login and metadata at15s but allows one bounded60s IME dispatch without a retry",async()=>{
 const timeout=vi.spyOn(AbortSignal,"timeout").mockImplementation(()=>new AbortController().signal);
 try{
  const f=provider(Response.json([{name:"TmpIME_Articulos"}]),Response.json({Message:"Submitted"})),reader=new SageReader(credentials,f);
  await reader.importTables();await reader.insertValidatedImport({tables:[{tableName:"TmpIME_Articulos",values:{CodigoEmpresa:"1",TipoImportacionIME:"2",CodigoArticulo:"A"}}]});
  expect(timeout.mock.calls.map(([milliseconds])=>milliseconds)).toEqual([15000,15000,15000,15000,60000]);
  expect(f.mock.calls.filter(([url])=>String(url).endsWith('/PutData/InsertData'))).toHaveLength(1);
 }finally{timeout.mockRestore();}
});


it.each(["tables","schema"] as const)("refreshes an invalidated token once for read-only %s metadata",async kind=>{
 const value=kind==="tables"?Response.json([{name:"TmpIME_Articulos"}]):Response.json(fields);
 const f=provider(new Response("provider-private",{status:401}),Response.json({publicToken:"synthetic-refreshed-token"}),companies(),catalog(),value);
 const reader=new SageReader(credentials,f);
 const actual=kind==="tables"?await reader.importTables():await reader.importSchema("TmpIME_Articulos");
 expect(actual.length).toBeGreaterThan(0);
 expect(f.mock.calls.filter(([url])=>String(url).endsWith("/auth/Login"))).toHaveLength(2);
 expect(f.mock.calls.filter(([url])=>String(url).endsWith("/PutData/InsertData"))).toHaveLength(0);
 expect(f).toHaveBeenCalledTimes(8);
});

it.each(["tables","schema"] as const)("bounds refresh and preserves non-auth metadata failures (%s)",async kind=>{
 for(const status of [401,503]) {
  const f=provider(new Response("provider-private",{status}),Response.json({publicToken:"synthetic-refreshed-token"}),companies(),catalog(),new Response("provider-private",{status:401}));
  const reader=new SageReader(credentials,f);
  const pending=kind==="tables"?reader.importTables():reader.importSchema("TmpIME_Articulos");
  await expect(pending).rejects.toMatchObject({code:status===401?"SAGE_AUTH_REQUIRED":"SAGE_PROVIDER_UNAVAILABLE"});
  expect(f.mock.calls.filter(([url])=>String(url).endsWith("/auth/Login"))).toHaveLength(status===401?2:1);
  expect(f.mock.calls.filter(([url])=>String(url).endsWith("/PutData/InsertData"))).toHaveLength(0);
 }
});

it("coalesces concurrent metadata refreshes after a shared bearer is rejected",async()=>{
 let loginCount=0;
 const f=vi.fn<typeof fetch>(async(input,init)=>{
  const url=String(input),bearer=new Headers(init?.headers).get("authorization");
  if(url.endsWith("/auth/Login"))return Response.json({publicToken:++loginCount===1?"synthetic-expired-token":"synthetic-refreshed-token"});
  if(url.endsWith("/DataQuery/GetQuery"))return companies();
  if(url.endsWith("/DataQuery/GetQueryList"))return catalog();
  if(bearer==="Bearer synthetic-expired-token")return new Response("provider-private",{status:401});
  if(url.endsWith("/PutData/allowedTables"))return Response.json([{name:"TmpIME_Articulos"}]);
  if(url.endsWith("/DataQuery/GetTableFields"))return Response.json(fields);
  throw new Error("unexpected request");
 });
 const reader=new SageReader(credentials,f);await reader.discover();
 const [tables,schema]=await Promise.all([reader.importTables(),reader.importSchema("TmpIME_Articulos")]);
 expect(tables).toEqual(["TmpIME_Articulos"]);expect(schema.length).toBeGreaterThan(0);expect(loginCount).toBe(2);
 expect(f.mock.calls.filter(([url])=>String(url).endsWith("/PutData/InsertData"))).toHaveLength(0);
});

it("does not repeat metadata if refresh cannot reverify the same company",async()=>{
 const f=provider(new Response("private",{status:401}),Response.json({publicToken:"synthetic-refreshed-token"}),Response.json([{Code:1,Name:"Other synthetic company"}]));
 await expect(new SageReader(credentials,f).importTables()).rejects.toMatchObject({code:"SAGE_COMPANY_MISMATCH"});
 expect(f.mock.calls.filter(([url])=>String(url).endsWith("/PutData/allowedTables"))).toHaveLength(1);
 expect(f.mock.calls.filter(([url])=>String(url).endsWith("/PutData/InsertData"))).toHaveLength(0);
});
