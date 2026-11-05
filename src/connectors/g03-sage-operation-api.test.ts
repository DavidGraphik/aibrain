import {expect,it,vi} from "vitest";
import {SageReader,type SageCredential} from "./g03-sage-api";
const credentials:SageCredential={baseUrl:"https://sage.example.test/api",username:"synthetic",password:"private",appId:"test",allowedQueries:["Products"]};
function provider(...responses:Response[]){const f=vi.fn<typeof fetch>();for(const response of [Response.json({publicToken:"synthetic-token-12345"}),Response.json([{Code:1,Name:"G03 MECANITZATS MALGRAT S.L."}]),Response.json([{name:"Products",parameters:"CodigoEmpresa"}]),...responses])f.mockResolvedValueOnce(response);return f;}
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
