// Optional view of a provider result, after the normal authenticated read.
// This never filters records, changes pagination, or infers missing values.
type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function attioProjectionArguments(input:unknown):{native:unknown;fields:string[]|null}|null {
 // Accept documented /v2 paths as well as paths relative to the configured
 // Attio v2 API base. Provider method/route and actor checks still apply.
 if(object(input)&&input.command==='read'&&object(input.request)&&
   ['GET','POST'].includes(String(input.request.method))&&typeof input.request.path==='string'&&input.request.path.startsWith('/v2/')){
  input={...input,request:{...input.request,path:input.request.path.slice(3)}};
 }
 if(!object(input)||!Object.hasOwn(input,'selectAttributes'))return {native:input,fields:null};
 const {selectAttributes,...native}=input;
 if(input.command!=='read'||!object(input.request)||input.request.method!=='POST'||typeof input.request.path!=='string'||!/^\/objects\/[A-Za-z0-9_-]{1,100}\/records\/query$/.test(input.request.path)||!Array.isArray(selectAttributes)||selectAttributes.length<1||selectAttributes.length>20||selectAttributes.some(x=>typeof x!=='string'||!/^[a-z][a-z0-9_]{0,99}$/.test(x))||new Set(selectAttributes).size!==selectAttributes.length)return null;
 return {native,fields:selectAttributes as string[]};
}
export function projectAttioRecords(input:unknown,fields:string[]):unknown {
 if(!object(input)||!object(input.data)||!object(input.data.data)||!Array.isArray(input.data.data.data))throw Error('ATTIO_PROJECTION_RESPONSE_INVALID');
 const wrapper=input.data,provider=wrapper.data as Obj,rows=provider.data as unknown[];
 const projected=rows.map(row=>{
  if(!object(row)||!object(row.id)||typeof row.id.record_id!=='string'||!row.id.record_id||!object(row.values))throw Error('ATTIO_PROJECTION_RESPONSE_INVALID');
  return {...row,values:Object.fromEntries(fields.filter(k=>Object.hasOwn(row.values as Obj,k)).map(k=>[k,(row.values as Obj)[k]]))};
 });
 return {...input,data:{...wrapper,data:{...provider,data:projected}},viewProjection:{attributes:fields,recordsFiltered:false,omittedAttributesNotEvidenceOfAbsence:true}};
}
