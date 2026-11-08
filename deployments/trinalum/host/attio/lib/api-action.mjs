import {requestApi,readBackApi,validateApiRequest} from './api-contract.mjs';

// Called only after the broker binds the authenticated employee and the exact
// action has been confirmed. The durable receipt precedes any provider effect.
export async function executeApiAction(store, actionId, approvedBy, options={}) {
  let stored=await store.require(actionId);
  if(stored.action_type!=='api_request' || stored.requested_by!==approvedBy)throw new Error('Attio action actor/type mismatch');
  if(stored.status==='completed')return {status:'already_completed',actionId,result:stored.result,readback:stored.readback};
  validateApiRequest(stored.request,{writeOnly:true});
  await store.assertDispatchable(actionId);
  if(!await store.claim(actionId))throw new Error('Attio action is already being executed');
  try {
    stored=await store.approve(actionId,approvedBy);
    await checkPersonDuplicates(stored.request,options);
    await store.markDispatched(actionId);
    const result=await requestApi(stored.request,options);
    await store.recordProviderResult(actionId,result);
    const readback=await readBackApi(stored.request,result,options);
    await store.complete(actionId,result,readback);
    return {status:'completed',actionId,result,readback};
  } catch(error) {
    await store.fail(actionId,error);throw error;
  } finally {await store.release(actionId);}
}

// Generic People creation keeps the typed path's duplicate fence; changing the
// payload shape must not bypass the fresh read before dispatch. Existing frozen
// request, hashes and explicit readback stay byte-for-byte unchanged.
async function checkPersonDuplicates(request,options) {
  if(request.method!=='POST')return;
  const object=/^\/objects\/([^/]+)\/records$/.exec(request.path.split('?')[0])?.[1];
  if(!object)return;
  let slug=object;
  if(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(object)){
    const metadata=(await requestApi({method:'GET',path:`/objects/${object}`},options)).data;
    if(!metadata || typeof metadata!=='object' || Array.isArray(metadata) ||
      typeof metadata.id?.object_id!=='string' || metadata.id.object_id.toLowerCase()!==object.toLowerCase() ||
      typeof metadata.id.workspace_id!=='string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(metadata.id.workspace_id) ||
      typeof metadata.api_slug!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(metadata.api_slug) ||
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(metadata.api_slug))throw new Error('ATTIO_OBJECT_ALIAS_INVALID');
    slug=metadata.api_slug;
  }
  if(slug!=='people')return;
  const candidate=request.body?.data?.values;
  const text=value=>{const item=Array.isArray(value)?value[0]:value;return String(item?.value??item?.full_name??item?.title??item?.email_address??item?.original_email_address??item?.domain??item??'').trim().toLocaleLowerCase('es');};
  const emails=values=>new Set((Array.isArray(values?.email_addresses)?values.email_addresses:values?.email_addresses?[values.email_addresses]:[]).map(text).filter(Boolean));
  const companies=values=>new Set((Array.isArray(values?.company)?values.company:values?.company?[values.company]:[]).map(value=>value?.target_record_id).filter(Boolean));
  const intersects=(left,right)=>[...left].some(value=>right.has(value));
  const duplicate=record=>intersects(emails(candidate),emails(record.values))||Boolean(text(candidate?.name)&&text(candidate.name)===text(record.values?.name)&&intersects(companies(candidate),companies(record.values)));
  for(let offset=0;offset<10000;offset+=500){
    const response=await requestApi({method:'POST',path:'/objects/people/records/query',body:{limit:500,offset}},options);
    if(!Array.isArray(response.data)||response.data.length>500||response.data.some(record=>!record||typeof record!=='object'||!record.values||typeof record.values!=='object'))throw new Error('ATTIO_PEOPLE_DUPLICATE_COVERAGE_INVALID');
    if(response.data.some(duplicate)){const error=new Error('A matching Attio person already exists');error.code='ATTIO_PERSON_ALREADY_EXISTS';throw error;}
    if(response.data.length<500)return;
  }
  throw new Error('ATTIO_PEOPLE_DUPLICATE_COVERAGE_INCOMPLETE');
}
