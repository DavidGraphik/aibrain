import { readFileSync } from 'node:fs';
import {downloadProviderFile,directProviderFile} from './api-download.mjs';

// Official public contract, fetched 2026-10-15 from https://api.attio.com/openapi/api.
// No runtime schema download: a documentation change cannot expand live authority.
const spec = JSON.parse(readFileSync(new URL('./attio-openapi.json', import.meta.url), 'utf8'));
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const ATTIO_API_ORIGIN = 'https://api.attio.com/v2';
const operations = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item)
  .filter(([method]) => methods.has(method.toUpperCase()))
  .map(([method, operation]) => ({ method: method.toUpperCase(), path: path.replace(/^\/v2/, ''), operation,
    parameters: [...(item.parameters ?? []), ...(operation.parameters ?? [])] })))
  // Literal paths precede placeholders, e.g. /objects/records/search.
  .sort((a,b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0));

function invalid(message, code='ATTIO_API_INVALID_ARGUMENTS') {
  const error = new Error(message); error.code = code; return error;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
// Dynamic record-value schemas intentionally admit several attribute types.
// Their broad anyOf branches (and untyped PATCH items) cannot enforce the
// native location contract. Validate that known attribute before dispatch.
const locationSchema = spec.components.schemas['input-value'].anyOf.find(branch =>
  branch.properties?.locality && branch.properties?.postcode && branch.properties?.country_code);
const nativeLocationSchema = {...locationSchema, properties: {...locationSchema.properties,
  // The location documentation permits null for every unknown component.
  country_code: {...locationSchema.properties.country_code, enum: [...locationSchema.properties.country_code.enum, null]},
}};
function validateNativeLocations(body) {
  const values = body?.data?.values;
  if (!object(values) || !Object.hasOwn(values, 'primary_location')) return;
  const input = values.primary_location;
  const locations = Array.isArray(input) ? input : [input];
  locations.forEach((location, index) => {
    // Attio also documents a string shorthand. Preserve it and intentional
    // empty arrays; this validator never fills, clears or rewrites fields.
    if (typeof location === 'string') return;
    const at = `body.data.values.primary_location[${index}]`;
    if (object(location) && Object.hasOwn(location, 'country_code') && location.country_code !== null
        && !locationSchema.properties.country_code.enum.includes(location.country_code)) {
      throw invalid(`${at}.country_code must be a documented ISO 3166-1 alpha-2 code (for example ES, FR, GB, US), or null when unknown. Three-letter codes and country names are not accepted. Correct the input; do not clear the location or guess a country.`);
    }
    try { validateSchema(location, nativeLocationSchema, at); }
    catch (error) {
      throw invalid(`${error.message}. Location objects require all fields: ${locationSchema.required.join(', ')}; components are strings or null. Read the current location and preserve existing components; specify null only for unknown source values. String location shorthand is also supported.`);
    }
  });
}
function resolve(schema) {
  if (!schema?.$ref) return schema;
  if (!schema.$ref.startsWith('#/')) throw invalid('External schema references are forbidden');
  const value = schema.$ref.slice(2).split('/').reduce((node,key) => node?.[key.replace(/~1/g,'/').replace(/~0/g,'~')], spec);
  if (!value) throw invalid('Unknown schema reference');
  return value;
}

// Validate the contract's used JSON Schema vocabulary without a host npm install.
// Attio remains the authority for dynamic workspace attributes and permissions.
export function validateSchema(value, inputSchema, at='body', depth=0) {
  if (depth > 45) throw invalid('JSON nesting limit exceeded');
  const schema = resolve(inputSchema);
  if (schema === true || schema === undefined) return;
  if (schema === false) throw invalid(`${at} is not allowed`);
  if (schema.nullable && value === null) return;
  for (const branch of schema.allOf ?? []) validateSchema(value, branch, at, depth+1);
  for (const keyword of ['anyOf','oneOf']) if (schema[keyword]) {
    const valid = schema[keyword].filter(branch => {try {validateSchema(value,branch,at,depth+1);return true;} catch {return false;}}).length;
    if (!valid || keyword === 'oneOf' && valid !== 1) throw invalid(`${at} does not match ${keyword}`);
  }
  if (schema.enum && !schema.enum.some(x=>JSON.stringify(x)===JSON.stringify(value))) throw invalid(`${at} has an invalid enum value`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = type => type === 'null' ? value === null : type === 'object' ? object(value) : type === 'array' ? Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (types.length && !types.some(matches)) throw invalid(`${at} must be ${types.join(' or ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength) throw invalid(`${at} length is invalid`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) throw invalid(`${at} has an invalid format`);
    if (schema.format === 'uuid' && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw invalid(`${at} must be a UUID`);
    if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw invalid(`${at} must be an email address`);
  }
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) throw invalid(`${at} is outside the documented range`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) throw invalid(`${at} array length is invalid`);
    value.forEach((item,index)=>validateSchema(item,schema.items,`${at}[${index}]`,depth+1));
  }
  if (object(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value,key)) throw invalid(`${at}.${key} is required`);
    for (const [key,item] of Object.entries(value)) {
      if (['__proto__','constructor','prototype'].includes(key)) throw invalid('Unsafe object key');
      if (Object.hasOwn(schema.properties ?? {},key)) validateSchema(item,schema.properties[key],`${at}.${key}`,depth+1);
      else if (schema.additionalProperties === false) throw invalid(`${at}.${key} is not documented`);
      else if (object(schema.additionalProperties)) validateSchema(item,schema.additionalProperties,`${at}.${key}`,depth+1);
    }
  }
}

function matchOperation(method, pathname) {
  for (const entry of operations) {
    if (entry.method !== method) continue;
    const names=[];
    const expression=entry.path.split('/').map(part => part.startsWith('{') ? (names.push(part.slice(1,-1)), '([A-Za-z0-9_.-]+)') : part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/');
    const match=new RegExp(`^${expression}$`).exec(pathname);
    if (!match) continue;
    const params=Object.fromEntries(names.map((name,index)=>[name,match[index+1]]));
    try {
      for (const input of entry.parameters.filter(p=>resolve(p).in==='path')) {
        const parameter=resolve(input);validateSchema(params[parameter.name],parameter.schema,`path.${parameter.name}`);
      }
    } catch { continue; }
    return entry;
  }
  throw invalid('This method/path is not in the pinned official Attio API contract');
}

export function isReadOperation(method, pathname, body) {
  if (method === 'GET') return true;
  if (method !== 'POST') return false;
  if (/\/(?:records|entries)\/query$/.test(pathname) || pathname === '/objects/records/search') return true;
  if (pathname === '/sql') {
    const sql=String(body?.sql ?? '').replace(/'(?:''|[^'])*'/g,"''").replace(/"(?:""|[^"])*"/g,'""').replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\n]*/g,' ').trim();
    if (!/^(?:SELECT|WITH|EXPLAIN)\b/i.test(sql) || /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|CALL|COPY|EXECUTE)\b/i.test(sql) || /;\s*\S/.test(sql)) throw invalid('Only a single read-only SQL query is allowed');
    return true;
  }
  return false;
}

export function validateApiRequest(input, { readOnly=false, writeOnly=false }={}) {
  if (!object(input) || Object.keys(input).some(key=>!['method','path','body','readback'].includes(key))) throw invalid('Use only method, path, body and optional readback');
  if (typeof input.method !== 'string' || !methods.has(input.method)) throw invalid('Unsupported HTTP method');
  if (typeof input.path !== 'string' || input.path.length > 8192 || !input.path.startsWith('/') || input.path.startsWith('//') || /[\\#\s\x00-\x1f]/.test(input.path)) throw invalid('Use an absolute API path, without host, fragment or controls');
  const [pathname,query] = input.path.split('?');
  if (input.path.split('?').length > 2 || /%|\/\.{1,2}(?:\/|$)/.test(pathname)) throw invalid('Encoded paths and traversal are forbidden');
  const entry=matchOperation(input.method,pathname);
  const params=new URLSearchParams(query),seen=new Set();
  const queryParams=entry.parameters.map(resolve).filter(p=>p.in==='query');
  for (const [key,value] of params) {
    if (seen.has(key)) throw invalid(`Duplicate query parameter ${key}`);seen.add(key);
    const parameter=queryParams.find(p=>p.name===key);
    if (!parameter) throw invalid(`Undocumented query parameter ${key}`);
    const schema=resolve(parameter.schema);let typed=value;
    if (['number','integer'].includes(schema?.type)) typed=Number(value);
    else if (schema?.type === 'boolean') typed=value==='true'?true:value==='false'?false:value;
    validateSchema(typed,schema,`query.${key}`);
  }
  for (const p of queryParams) if (p.required && !params.has(p.name)) throw invalid(`query.${p.name} is required`);
  const bodyDefinition=entry.operation.requestBody;
  if (!bodyDefinition && input.body !== undefined) throw invalid('This endpoint has no request body');
  if (bodyDefinition?.required && input.body === undefined) throw invalid('This endpoint requires a body');
  if (input.body !== undefined) {
    if (Buffer.byteLength(JSON.stringify(input.body)) > 72*1024*1024) throw invalid('Request body too large');
    if (['POST','PUT','PATCH'].includes(input.method) && /^\/objects\/[^/]+\/records(?:\/[^/]+)?$/.test(pathname)) validateNativeLocations(input.body);
    const content=bodyDefinition.content;
    if (content['application/json']) validateSchema(input.body,content['application/json'].schema);
    else if (content['multipart/form-data']) {
      const file=input.body?.file;
      if (!object(file) || Object.keys(file).some(k=>!['filename','content_base64','content_type'].includes(k)) || typeof file.filename!=='string' || !file.filename || /[/\\\x00-\x1f]/.test(file.filename) || typeof file.content_base64!=='string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content_base64)) throw invalid('Upload body.file requires filename and canonical content_base64');
      if (Buffer.byteLength(file.content_base64,'base64') > 50*1024*1024) throw invalid('Attio file upload exceeds 50 MB');
      if (file.content_type !== undefined && (typeof file.content_type!=='string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.content_type))) throw invalid('Invalid upload MIME type');
      validateSchema({...input.body,file:file.content_base64},content['multipart/form-data'].schema);
    } else throw invalid('Unsupported documented body encoding');
  }
  const read=isReadOperation(input.method,pathname,input.body);
  if (readOnly && !read) throw invalid('This is a write; use an approved api_request action');
  if (writeOnly && read) throw invalid('This is a read; use api-read without preparing a mutation');
  if (input.readback !== undefined) {
    if (read || !object(input.readback) || Object.hasOwn(input.readback,'readback')) throw invalid('Invalid readback');
    validateApiRequest(input.readback,{readOnly:true});
  }
  return {method:input.method,path:input.path,...(input.body===undefined?{}:{body:input.body}),...(input.readback===undefined?{}:{readback:input.readback})};
}

export function discoverApi({query='',method,path}={}) {
  if (typeof query!=='string' || query.length>200 || method!==undefined&&!methods.has(method) || path!==undefined&&typeof path!=='string') throw invalid('Invalid discovery filters');
  const rows=operations.filter(row=>(!method||row.method===method)&&(!path||row.path===path||(()=>{try{return matchOperation(row.method,path).path===row.path;}catch{return false;}})())&&`${row.path} ${row.operation.summary} ${row.operation.tags}`.toLowerCase().includes(query.toLowerCase()));
  return {source:'Official Attio OpenAPI',sourceUrl:'https://api.attio.com/openapi/api',pinnedAt:'2026-10-15',baseUrl:ATTIO_API_ORIGIN,operationCount:operations.length,
    operations:rows.map(row=>({method:row.method,path:row.path,summary:row.operation.summary,description:row.operation.description,parameters:row.parameters,
      ...(path?{requestBody:row.operation.requestBody ?? null,responses:row.operation.responses}:{}),readOnly:row.method==='GET'||row.method==='POST'&&(/\/(?:records|entries)\/query$/.test(row.path)||['/objects/records/search','/sql'].includes(row.path))})),
    ...(path?{schemas:spec.components.schemas}:{}),
    notes:['Provider scopes and plan entitlements still apply; discovery is not proof of access.','GET and documented POST queries are reads; all other operations use api_request.','Multipart upload: body.file={filename,content_base64,content_type?}.','File downloads return private binary content up to 15 MB; no signed access link is exposed.']};
}

const secretKey=/(?:token|secret|password|authorization|signature|credential|signed.?url|download.?url)/i;
export function redactApiResult(value, token='') {
  if (Array.isArray(value)) return value.map(item=>redactApiResult(item,token));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,secretKey.test(key)?'[redacted]':redactApiResult(item,token)]));
  if (typeof value==='string') {
    if (token) value=value.replaceAll(token,'[redacted]');
    if (/^https?:\/\//i.test(value)) {try {const url=new URL(value);if(url.username||url.password||[...url.searchParams.keys()].some(k=>/signature|token|credential|password|x-amz|x-goog|^(?:sig|key|rlkey|auth|code)$/i.test(k)))return '[protected URL]';}catch{}}
  }
  return value;
}

export async function requestApi(input, {token=process.env.ATTIO_API_TOKEN?.trim(),fetchImpl=globalThis.fetch,resolveHost,downloadTransport}={}) {
  const request=validateApiRequest(input);
  if (!token) throw invalid('ATTIO_API_TOKEN is required','ATTIO_NOT_CONNECTED');
  const headers={Authorization:`Bearer ${token}`};let body;
  if (request.body !== undefined && request.path.split('?')[0]==='/files/upload') {
    body=new FormData();
    for(const [key,value] of Object.entries(request.body)) if(key!=='file')body.set(key,String(value));
    const file=request.body.file;body.set('file',new Blob([Buffer.from(file.content_base64,'base64')],{type:file.content_type??'application/octet-stream'}),file.filename);
  } else if(request.body!==undefined) {headers['Content-Type']='application/json';body=JSON.stringify(request.body);}
  const response=await fetchImpl(`${ATTIO_API_ORIGIN}${request.path}`,{method:request.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(40000)});
  if (/^\/files\/[a-f0-9-]+\/download$/.test(request.path)) {
    const fallback=`attio-${request.path.split('/')[2]}.bin`;
    if(response.status===302)return downloadProviderFile(response.headers.get('location'),{resolveHost,downloadTransport,fallback});
    if(response.ok)return directProviderFile(response,fallback);
  }
  const raw=await response.text();
  if (Buffer.byteLength(raw)>8*1024*1024) throw invalid('Provider result too large; use smaller pages','ATTIO_RESULT_TOO_LARGE');
  let result;try{result=raw?JSON.parse(raw):{};}catch{throw invalid('Provider returned non-JSON content','ATTIO_PROVIDER_RESPONSE_INVALID');}
  if(!response.ok) {const error=invalid(`Attio API rejected ${request.method} ${request.path.split('?')[0]} (HTTP ${response.status})`,typeof result?.code==='string'?result.code:'ATTIO_PROVIDER_REJECTED');error.status=response.status;throw error;}
  return redactApiResult(result,token);
}

export function inferReadback(request,result) {
  if(request.readback)return request.readback;
  const path=request.path.split('?')[0];
  if(request.method==='DELETE')return {method:'GET',path};
  const id=result?.data?.id ?? {};let resourcePath;
  if(id.record_id) resourcePath=path.replace(/\/records(?:\/[^/]+)?$/,'/records')+'/'+id.record_id;
  else if(id.entry_id)resourcePath=path.replace(/\/entries(?:\/[^/]+)?$/,'/entries')+'/'+id.entry_id;
  else {
    const collection=path.split('/').at(-1);
    const key=({objects:'object_id',activities:'activity_id',lists:'list_id',notes:'note_id',tasks:'task_id',comments:'comment_id',meetings:'meeting_id',call_recordings:'call_recording_id',files:'file_id',upload:'file_id',webhooks:'webhook_id',attributes:'attribute_id',options:'option_id',statuses:'status_id'})[collection];
    if(key&&id[key])resourcePath=(collection==='upload'?'/files':path)+'/'+id[key];
  }
  if(resourcePath){try{return validateApiRequest({method:'GET',path:resourcePath},{readOnly:true});}catch{}}
  try{return validateApiRequest({method:'GET',path:request.path},{readOnly:true});}catch{return null;}
}

export async function readBackApi(request,result,options={}) {
  const readback=inferReadback(request,result);
  if(!readback)return {verification:'provider_acknowledgement',independent:false,warning:'This operation has no inferred documented read endpoint. Do not claim independent semantic verification.'};
  try {return {verification:'provider_readback',independent:true,request:readback,data:await requestApi(readback,options),semantic_match:'Compare returned provider state with approved fields; no generic semantic equivalence is assumed.'};}
  catch(error){if(request.method==='DELETE'&&error.status===404)return {verification:'provider_readback',independent:true,deleted:true,path:readback.path};throw error;}
}
