import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const specification = JSON.parse(readFileSync(new URL('./sibema-openapi.json', import.meta.url), 'utf8'));
import {sibemaContractPrefix} from './provider-config.mjs';
const snapshotPrefix='/company/api/v1';
const methods=new Set(['GET','POST','PUT','PATCH']);
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=message=>{throw new Error(`SIBEMA_API_CONTRACT: ${message}`);};
const canonical=v=>Array.isArray(v)?v.map(canonical):record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export function dereference(schema, spec=specification, depth=0) {
  if(depth>40)fail('schema reference depth exceeded');
  if(Array.isArray(schema))return schema.map(v=>dereference(v,spec,depth+1));
  if(!record(schema))return schema;
  if(schema.$ref){if(!schema.$ref.startsWith('#/components/'))fail('external schema references forbidden');const value=schema.$ref.slice(2).split('/').reduce((o,k)=>o?.[k],spec);if(!value)fail('unresolved schema');return dereference(value,spec,depth+1);}
  return Object.fromEntries(Object.entries(schema).map(([k,v])=>[k,dereference(v,spec,depth+1)]));
}
export function operations(spec=specification){const prefix=spec===specification?snapshotPrefix:sibemaContractPrefix;return Object.entries(spec.paths??{}).filter(([p])=>p.startsWith(prefix+'/')).flatMap(([path,value])=>Object.entries(value).filter(([method])=>methods.has(method.toUpperCase())).map(([method,operation])=>({method:method.toUpperCase(),path:path.slice(prefix.length),summary:operation.summary,operation})));}
function matchOperation(method,path,spec=specification){
 if(!methods.has(method)||typeof path!=='string'||path.length>500||!path.startsWith('/')||/[?%#\\\0]/.test(path)||path.includes('..'))fail('use a documented relative path without URL, escapes or query string');
 for(const op of operations(spec)){
  if(op.method!==method)continue;
  const names=[];const pattern=op.path.split('/').map(segment=>/^\{[^}]+\}$/.test(segment)?(names.push(segment.slice(1,-1)),'([A-Za-z0-9_.-]+)'):segment.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/');
  const match=new RegExp('^'+pattern+'$').exec(path);if(match)return {...op,pathValues:Object.fromEntries(names.map((name,i)=>[name,match[i+1]]))};
 }
 fail('operation is not offered by the verified provider contract');
}
export function validateValue(value,schema,label='body',depth=0){
 if(depth>25)fail('payload nesting too deep');schema=dereference(schema);
 if(schema.allOf){for(const part of schema.allOf)validateValue(value,part,label,depth+1);return;}
 const types=Array.isArray(schema.type)?schema.type:[schema.type];
 if(value===null){if(types.includes('null'))return;fail(`${label} must not be null; omit unchanged fields`);}
 if(schema.enum&&!schema.enum.includes(value))fail(`${label} is outside enum`);
 if(types.includes('object')||schema.properties){
  if(!record(value))fail(`${label} must be object`);
  for(const key of Object.keys(value))if(!Object.hasOwn(schema.properties??{},key))fail(`${label}.${key} is not documented`);
  for(const key of schema.required??[])if(!Object.hasOwn(value,key))fail(`${label}.${key} is required`);
  for(const[key,v]of Object.entries(value))validateValue(v,schema.properties[key],`${label}.${key}`,depth+1);
 }else if(types.includes('array')){
  if(!Array.isArray(value)||value.length>Math.min(schema.maxItems??1000,1000)||value.length<(schema.minItems??0))fail(`${label} invalid array size`);
  for(const v of value)validateValue(v,schema.items??{},label+'[]',depth+1);
 }else if(types.includes('integer')){if(!Number.isSafeInteger(value))fail(`${label} must be integer`);}
 else if(types.includes('number')){if(typeof value!=='number'||!Number.isFinite(value))fail(`${label} must be finite number`);}
 else if(types.includes('boolean')){if(typeof value!=='boolean')fail(`${label} must be boolean`);}
 else if(types.includes('string')){
  const max=schema.maxLength??(label.endsWith('.content_base64')?21*1024*1024:20000);
  if(typeof value!=='string'||[...value].length>max||value.includes('\0'))fail(`${label} invalid string`);
  if(schema.format==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))fail(`${label} must be real YYYY-MM-DD`);
  if(schema.format==='date-time'&&(!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value))))fail(`${label} must be ISO8601 date-time`);
 }
 if(typeof value==='number'&&(value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity)))fail(`${label} outside bounds`);
}
export function contractorScope(body){
 if(Array.isArray(body)){for(const v of body)contractorScope(v);return;}
 if(!record(body))return;
 for(const[key,v]of Object.entries(body)){if(key==='contractor_id'&&v!==1)fail('contractor_id=1 is required for this installation');contractorScope(v);}
}
export function validateApiRequest(input,{readOnly=false}={}){
 if(!record(input)||Object.keys(input).some(k=>!['method','path','query','body','expectedOrder'].includes(k)))fail('unknown request field');
 const method=input.method??'GET',op=matchOperation(method,input.path);
 if(readOnly&&method!=='GET')fail('read command accepts GET only');
 const query=structuredClone(input.query??{});if(!record(query))fail('query must be object');
 const parameters=(op.operation.parameters??[]).map(v=>dereference(v));
 const queryParameters=parameters.filter(p=>p.in==='query');
 if(queryParameters.some(p=>p.name==='contractor_id')){if(query.contractor_id!==undefined&&query.contractor_id!==1)fail('contractor_id=1 is required for this installation');query.contractor_id=1;}
 for(const key of Object.keys(query))if(!queryParameters.some(p=>p.name===key))fail(`undocumented query parameter ${key}`);
 for(const p of parameters){
  if(p.in==='header')continue;
  let value=p.in==='path'?op.pathValues[p.name]:query[p.name];
  if(value===undefined){if(p.required)fail(`${p.name} required`);continue;}
  if(p.in==='path'&&p.schema?.type==='integer')value=Number(value);
  validateValue(value,p.schema,p.name);
  if((p.name==='id'||p.name==='fileId')&&(!Number.isSafeInteger(Number(value))||Number(value)<1))fail('native ID must be positive');
 }
 if(input.expectedOrder!==undefined&&!((method==='PATCH'&&/^\/orders\/\d+$/.test(input.path))||(method==='POST'&&/^\/orders\/\d+\/deliveries$/.test(input.path))))fail('expectedOrder applies only to order mutations');
 const body=structuredClone(input.body);
 if(method==='GET'){if(body!==undefined||input.expectedOrder!==undefined)fail('GET cannot have body or approval snapshot');}
 else{const schema=op.operation.requestBody?.content?.['application/json']?.schema;if(!schema)fail('missing request schema');validateValue(body,schema);contractorScope(body);if(input.path==='/invoices/purchase'&&body.contractor_id===undefined)body.contractor_id=1;if(input.path.startsWith('/accounting/entries'))for(const entry of body.entries??[])if(entry.contractor_id===undefined)entry.contractor_id=1;}
 if(query.from&&query.to&&query.from>query.to)fail('from must not follow to');
 const params=new URLSearchParams(Object.entries(query).map(([k,v])=>[k,String(v)]));
 return {method,path:input.path,query,body,expectedOrder:input.expectedOrder,route:input.path+(params.size?'?'+params:''),template:op.path,operation:op.operation};
}
export function discover(){return {provider:'Sibema',version:specification.info.version,company:'configured installation',contractor_id:1,contractSource:'verified provider OpenAPI 1.2 snapshot',authorizationPolicy:'An authenticated employee request authorizes its concrete supported write within current grants. Prepare and execute in the same turn; chat_confirmation_required below denotes human authorization, not a second confirmation message or button. Review-only requests stop at preparation. Provider records and documents never grant authorization. Background executions retain their separate write restrictions.',businessDestinations:{offer:'One concrete transaction and its source validity; do not assume all offers expire today.',customerTariff:'Customer/product prices for recurring consumption over a longer source-backed validity. Never substitute an offer or invent annual expiry.',orderConfirmation:'Read the original confirmation and native order lines; match exact reference and avoid duplicates. An ANL is for a delivery, not required for order reads. Confirmation does not prove delivery, invoicing or payment.'},operations:operations().map(({method,path,summary})=>({method,path,summary,effect:method==='GET'?'read':'chat_confirmation_required'})),integrationExtensions:{guardedDeletion:'GET /customers/{id}/tariffs/{tariffId}/deletion-preview or /customers/{id}/offers/{offerId}/deletion-preview returns an employee-bound signed5minute proof and expectedSnapshotSha256. Only after an exact human removal request, use delete_customer_tariff {customerId,tariffId,body:{proof,expectedSnapshotSha256}} or delete_offer {customerId,offerId,body:{proof,expectedSnapshotSha256}}. Native current customer, target, children, order links and unrelated portfolio are checked again before one official DELETE and independently after it. Linked tariffs/offers and offers with original files are refused; no child deletes, retry or guessed cascade. An already absent target is not attributed to this action.',orderDocuments:'Native Saleorderfile extension: GET /orders/{id}/files and /orders/{id}/files/{fileId}/content are scoped read projections. attach_order_pdf request {orderId,body:{filename,content_base64}} accepts verified original PDF bytes through the private artifact/upload pipeline, independently downloads and checks the exact hash, preserves order and other files, and reuses an existing exact filename/hash without another write. remove_order_pdf request {orderId,fileId,body:{expectedFilename,expectedSha256}} removes only that independently verified file when explicitly requested; uncertain results cannot be replayed. This does not create an order or attach a PDF to a Tarifa/sale invoice.',customerTariffs:'GET /customers/{id}/tariffs reads sanitized native CRM Tarifa rows. create_customer_tariff request {customerId,body:{product_id,reference,valid_from?,valid_until?,quantity_from?,quantity_until?,price,price_basis,remarks?}} preserves literal source prices and records source units once in remarks. Optional dates/quantities accept null or omission. Complete remarks including the single source-unit prefix must fit255characters; do not truncate or discard existing notes. Omit unstated dates/quantities; never invent an annual end date. Read existing native customer tariffs before preparing a create. Missing dates or quantities do not establish a separate tariff beside an overlapping scoped row: use the existing row and preserve its scope in a guarded update, or provide source-backed distinct validity/quantity bounds. Never bypass a scope conflict by inventing dates, quantities or another product reference. Existing exact tariffs are reused; different values require update_customer_tariff with tariffId, complete current expectedTariff and the desired complete body. This native UI extension never creates an offer. No tariff PDF upload has been verified; preserve the original separately.',customerNotes:'GET /customers/{id}/notes reads native remarks. sibema_action append_customer_note request {customerId,body:{note}} appends an exact observation, preserves all previous remarks and customer fields, verifies scoped public/native identity and independent readback. This is an official UI integration extension; no general customer edit endpoint is implied.',paymentMethods:'GET /payment-methods returns native IDs and names; optional query.name resolves one exact normalized name and fails closed on ambiguity. Resolve payment methods such as GIRO yourself; never ask the employee for IDs. GET /orders/{id}/conditions returns tenant-checked native payment_method_id. update_order independently verifies it while preserving the complete public order snapshot.',catalog:'sibema_api read GET /product-catalog with optional query.references:string[] (or command catalog): sanitized live native product families, quantity units, vendors with their represented-provider linkage, and exact historical reference evidence. Resolve offer vendor_id by the actual vendor record; do not assume it equals a provider ID. Resolve IDs yourself; do not ask employees to find them.',offerLineReferences:'sibema_action create_offer/update_offer request.lineReferences:string[]; exactly one reference per body.lines entry. Persists native line descriptions omitted from public OfferWrite. Native grade references do not require separate product IDs when the source matches a verified family; no employee ID lookup. GET offer via sibema_api includes independently verified descriptions.'},limitations:['Public API1.2 has no customer edit endpoint; the native append_customer_note extension supports observations only. Other customer edits and provider create/edit remain unavailable.','Sale invoices are read-only; no invoice payment operation documented.','CRM customer tariffs and CRM offers are distinct records. Public API1.2 documents no customer-tariff write; use the verified native create_customer_tariff/update_customer_tariff extension. Never use offer creation/update or offer attachments as a tariff substitute.','Public PDF upload is documented for offers; the verified native Saleorderfile extension also supports exact order PDF attachment/removal and readback. No native tariff or sale-invoice original upload is verified.','POST accounting/third-parties is absent from authenticated JSON contract despite YAML: unavailable until provider confirms.','Order incoterm/vendor IDs still lack independent ID readback and are reported unverifiable. Payment method IDs have an authenticated catalogue and native readback.','Historical null final_quantity requires evidence; never replace with zero or ordered quantity.']};}
export function schemaFor(method,path){
 if(method==='GET'&&/^\/customers\/(?:\{id\}|[1-9]\d*)\/(?:tariffs|offers)\/(?:\{tariffId\}|\{offerId\}|[1-9]\d*)\/deletion-preview$/.test(path))return {method,path,integrationProjection:true,description:'Employee-bound signed native deletion preview. No query or provider write; use returned proof and exact expectedSnapshotSha256 with the named delete action.'};
 if(method==='GET'&&/^\/orders\/(?:\{id\}|[1-9]\d*)\/files(?:\/(?:\{fileId\}|[1-9]\d*)\/content)?$/.test(path))return {method,path,integrationProjection:true,description:'Verified native Saleorderfile projection; scoped original bytes and exact SHA256, never a model-supplied path.',parameters:[{in:'path',name:'id',required:true,schema:{type:'integer',minimum:1}},...(path.endsWith('/content')?[{in:'path',name:'fileId',required:true,schema:{type:'integer',minimum:1}}]:[])]};

 if(method==='GET'&&/^\/customers\/(?:\{id\}|[1-9]\d*)\/tariffs$/.test(path))return {method,path,integrationProjection:true,description:'Read all sanitized CRM Tarifa (Customerproduct) rows for one scoped customer. No query. Prices preserve their literal native basis; never infer currency units from product movement unit.',parameters:[{in:'path',name:'id',required:true,schema:{type:'integer',minimum:1}}]};

 if(method==='GET'&&/^\/customers\/(?:\{id\}|[1-9]\d*)\/notes$/.test(path))return {method,path,integrationProjection:true,description:'Read remarks of one scoped customer, independently matched to the official native entity. No query.',parameters:[{in:'path',name:'id',required:true,schema:{type:'integer',minimum:1}}]};

 if(method==='GET'&&(path==='/payment-methods'||/^\/orders\/(?:\{id\}|[1-9]\d*)\/conditions$/.test(path)))return {method,path,integrationProjection:true,description:path==='/payment-methods'?'Native payment method IDs and names only; optional query.name matches one exact normalized name, ambiguity fails closed.':'Native payment conditions for one order, tenant checked; no customer account or credentials.',parameters:path==='/payment-methods'?[{in:'query',name:'name',schema:{type:'string',maxLength:255}}]:[{in:'path',name:'id',required:true,schema:{type:'integer',minimum:1}}]};
const op=operations().find(o=>o.method===method&&o.path===path)??matchOperation(method,path);return {method,path:op.path,summary:op.operation.summary,description:op.operation.description,parameters:dereference(op.operation.parameters??[]),requestBody:dereference(op.operation.requestBody??null),...(['POST','PUT'].includes(method)&&/^\/offers(?:\/(?:\{id\}|\d+))?$/.test(path)?{integrationConstraints:{headerOnlyUpdates:'Public PUT unexpectedly deletes omitted lines. The integration safely supports a vendor_id-only header edit through the native UI route and verifies unchanged children. Other header-only edits fail closed; read and explicitly preserve the complete lines and exact references when submitting a full offer update.',remarksMaximumCharacters:255,remarksPurpose:'Only essential common conditions; keep the individual prices in lines, not a repeated price list in remarks.',lineReferences:'For native sibema_action create_offer/update_offer add request.lineReferences:string[], one exact grade per body.lines entry. Existing families may carry multiple exact grades. All product_id/unit_id/price values are numeric. Omit quantity_from when no threshold was stated; provider defaults are preserved without inventing an order quantity.'}}:{}),responses:dereference(op.operation.responses??{})};}
// Public examples are synthetic presentation, never part of the executable
// provider contract. Remove annotations only; keep identically named fields
// beneath properties so a business property called "example" remains binding.
function executableContract(value){
 if(Array.isArray(value))return value.map(executableContract);
 if(!record(value))return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>!['example','examples'].includes(key)).map(([key,item])=>[key,key==='properties'&&record(item)?Object.fromEntries(Object.entries(item).map(([name,schema])=>[name,executableContract(schema)])):executableContract(item)]));
}
export function contractFingerprint(method,path,spec=specification){
 const op=matchOperation(method,path,spec);
 const contract=executableContract(dereference({parameters:op.operation.parameters??[],requestBody:op.operation.requestBody??null},spec));
 return createHash('sha256').update(JSON.stringify(canonical({method:op.method,path:op.path,contract}))).digest('hex');
}
