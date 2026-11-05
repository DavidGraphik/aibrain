import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, open, lstat } from "node:fs/promises";
import path from "node:path";

export class AttioActionStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }

  async prepare(action) {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const actionPath = this.actionPath(action.id);
    const existing = await this.readOptional(action.id);
    const requestHash = hashAction(action);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new Error(`Action id ${action.id} already exists with different content`);
      }
      return existing;
    }
    const now = new Date().toISOString();
    const stored = {
      version: 1,
      action_id: action.id,
      action_type: action.type,
      requested_by: action.requestedBy,
      request: action.request,
      request_hash: requestHash,
      effect_hash: hashEffect(action.type, action.requestedBy, action.request),
      status: "prepared",
      prepared_at: now,
      approved_at: null,
      approved_by: null,
      dispatched_at: null,
      dispatch_contract_version: 1,
      executed_at: null,
      result: null,
      readback: null,
      error: null,
    };
    await this.writeNew(actionPath, stored);
    return stored;
  }

  async require(actionId) {
    const stored = await this.readOptional(actionId);
    if (!stored) throw new Error(`Attio action not found: ${actionId}`);
    return stored;
  }

  async approve(actionId, approvedBy) {
    const stored = await this.require(actionId);
    if (stored.status === "completed") return stored;
    await this.assertDispatchable(actionId);
    stored.status = "approved";
    stored.approved_by = approvedBy;
    stored.approved_at = new Date().toISOString();
    stored.error = null;
    await this.replace(actionId, stored);
    return stored;
  }

  async complete(actionId, result, readback) {
    const stored = await this.require(actionId);
    stored.status = "completed";
    stored.executed_at = new Date().toISOString();
    stored.result = result;
    stored.readback = readback;
    stored.error = null;
    await this.replace(actionId, stored);
    return stored;
  }

  async fail(actionId, error) {
    const stored = await this.require(actionId);
    const rejected=stored.dispatched_at && [400,401,403,404,405,406,410,413,415,422,429].includes(error.status) && !stored.provider_result;
    stored.status = rejected ? 'rejected' : stored.dispatched_at ? "indeterminate" : "failed";
    if(rejected)stored.definitive_rejection=true;
    stored.error = {
      message: error.message,
      code: error.code ?? null,
      status: error.status ?? null,
      at: new Date().toISOString(),
    };
    await this.replace(actionId, stored);
    return stored;
  }

  async assertDispatchable(actionId) {
    const stored=await this.require(actionId);
    if(stored.status==='completed')throw new Error('ATTIO_ACTION_COMPLETED');
    if(stored.status==='rejected'&&stored.definitive_rejection){const error=new Error('Provider rejected this exact action; address the reported cause before preparing a new action');error.code='ATTIO_ACTION_REJECTED';throw error;}
    if (stored.dispatched_at || ['dispatched','indeterminate'].includes(stored.status)) {
      const error=new Error('Attio outcome needs reconciliation; automatic repeat is blocked');error.code='ATTIO_ACTION_INDETERMINATE';throw error;
    }
    const fingerprint=stored.effect_hash??hashEffect(stored.action_type,stored.requested_by,stored.request);
    for(const name of await readdir(this.rootDirectory)) {
      if(!name.endsWith('.json') || name===`${actionId}.json`)continue;
      const other=JSON.parse(await readFile(path.join(this.rootDirectory,name),'utf8'));
      if(other.status==='completed' || other.status==='rejected'&&other.definitive_rejection || !(other.dispatched_at || ['dispatched','indeterminate'].includes(other.status)))continue;
      if((other.effect_hash??hashEffect(other.action_type,other.requested_by,other.request))===fingerprint){const error=new Error('An identical Attio effect has an unresolved outcome; do not prepare a new action to repeat it');error.code='ATTIO_ACTION_INDETERMINATE';throw error;}
    }
  }

  async markDispatched(actionId) {
    await this.assertDispatchable(actionId);
    const stored=await this.require(actionId);
    stored.status='dispatched';stored.dispatched_at=new Date().toISOString();
    await this.replace(actionId,stored);return stored;
  }

  async recordProviderResult(actionId, result) {
    const stored=await this.require(actionId);stored.provider_result=result;
    await this.replace(actionId,stored);
  }

  async claim(actionId, {inspectOnly=false}={}) {
    const lockPath = this.lockPath(actionId);
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const stored=await this.readOptional(actionId);
      if(stored){
        // Recheck AFTER the action lock: another executor may have completed
        // between its caller's initial read and this claim.
        if(!inspectOnly&&(stored.status==='completed'||stored.dispatched_at||['dispatched','indeterminate','rejected'].includes(stored.status))){
          await rm(lockPath,{recursive:true,force:true});return false;
        }
        const effect=stored.effect_hash??hashEffect(stored.action_type,stored.requested_by,stored.request);
        try{await mkdir(path.join(this.rootDirectory,`.effect-${effect}.lock`),{mode:0o700});}
        catch(error){await rm(lockPath,{recursive:true,force:true});if(error.code==='EEXIST')return false;throw error;}
      }
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  }

  async release(actionId) {
    await rm(this.lockPath(actionId), { recursive: true, force: true });
    const stored=await this.readOptional(actionId);
    if(stored){const effect=stored.effect_hash??hashEffect(stored.action_type,stored.requested_by,stored.request);await rm(path.join(this.rootDirectory,`.effect-${effect}.lock`),{recursive:true,force:true});}
  }

  async readOptional(actionId) {
    try {
      return JSON.parse(await readFile(this.actionPath(actionId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async replace(actionId, value) {
    const finalPath = this.actionPath(actionId);
    const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    await durableWrite(temporaryPath,value);
    await rename(temporaryPath, finalPath);
    await syncDirectory(this.rootDirectory);
  }

  async writeNew(finalPath, value) {
    try {
      await durableWrite(finalPath,value);
      await syncDirectory(this.rootDirectory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(finalPath, "utf8"));
      if (existing.request_hash !== value.request_hash) {
        throw new Error(`Action id ${value.action_id} already exists with different content`);
      }
    }
  }

  actionPath(actionId) {
    return path.join(this.rootDirectory, `${safeActionId(actionId)}.json`);
  }

  lockPath(actionId) {
    return path.join(this.rootDirectory, `${safeActionId(actionId)}.lock`);
  }

  async withNoDispatchProof(actionId, actor, requestHash, callback) {
    return this.withStatusProof(actionId,actor,requestHash,'no-dispatch',callback);
  }
  async withStatusProof(actionId, actor, requestHash, category, callback) {
    if(!['no-dispatch','definitive-rejection'].includes(category))throw new Error('ATTIO_PROOF_CATEGORY');
    if(!/^[a-f0-9]{64}$/.test(requestHash??''))throw new Error('ATTIO_PROOF_MISMATCH');
    if(!await this.claim(actionId,{inspectOnly:true}))throw new Error('ATTIO_PROOF_CLAIM_HELD');
    try {
      const file=this.actionPath(actionId),s=await lstat(file);
      if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o077)||s.size>48*1024*1024)throw new Error('ATTIO_PROOF_UNSAFE_RECORD');
      const raw=await readFile(file),stored=JSON.parse(raw);
      const actual=hashAction({id:stored.action_id,type:stored.action_type,requestedBy:stored.requested_by,request:stored.request});
      const effect=hashEffect(stored.action_type,stored.requested_by,stored.request);
      if(stored.version!==1||stored.action_id!==actionId||stored.requested_by!==actor||actual!==requestHash||stored.request_hash!==actual||(stored.effect_hash!==undefined&&stored.effect_hash!==effect))throw new Error('ATTIO_PROOF_MISMATCH');
      // No historical guarantee is inferred from a missing dispatch timestamp.
      // Every executed/approved/error/result state is excluded independently.
      if(stored.executed_at!==null||stored.result!==null||stored.readback!==null||stored.provider_result!=null)throw new Error('ATTIO_PROOF_RESULT_PRESENT');
      if(category==='no-dispatch'){
        if(stored.status!=='prepared'||!Number.isFinite(Date.parse(stored.prepared_at))||stored.approved_at!==null||stored.approved_by!==null||stored.error!==null||stored.dispatched_at!=null||stored.definitive_rejection)throw new Error('ATTIO_PROOF_NOT_PREPARED');
        await this.assertDispatchable(actionId);
      }else if(stored.status!=='rejected'||stored.definitive_rejection!==true||stored.error?.status!==400||stored.error?.code!=='validation_type'||stored.approved_by!==actor||![stored.approved_at,stored.dispatched_at].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))))throw new Error('ATTIO_PROOF_NOT_DEFINITIVELY_REJECTED');
      const checkedAt=new Date(),expiresAt=new Date(checkedAt.getTime()+30000);
      const disposition=category==='no-dispatch'?{nativeStatus:'prepared',approvedAt:null,approvedBy:null,dispatchedAt:null,error:null,preparedProvenance:'strict-unapproved-prepared'}:{nativeStatus:'rejected',approvedAt:stored.approved_at,approvedBy:stored.approved_by,dispatchedAt:stored.dispatched_at,error:{status:400,code:'validation_type'},definitiveRejection:true,providerStatus:400,providerCode:'validation_type'};
      return await callback({proofVersion:1,proofCategory:category,actionId,requestedBy:actor,requestHash:actual,effectHash:effect,nativeRecordSha256:createHash('sha256').update(raw).digest('hex'),...disposition,executedAt:null,providerResultPresent:false,resultPresent:false,readbackPresent:false,otherClaimHeld:false,dispatchGuarantee:'attio-durable-before-mutation-v1',legacyHistoryCertified:false,checkedAt:checkedAt.toISOString(),expiresAt:expiresAt.toISOString()});
    } finally {await this.release(actionId);}
  }
}

async function syncDirectory(directory) {
  const file=await open(directory,'r');try{await file.sync();}finally{await file.close();}
}
async function durableWrite(file,value) {
  const handle=await open(file,'wx',0o600);
  try{await handle.writeFile(`${JSON.stringify(value,null,2)}\n`);await handle.sync();}finally{await handle.close();}
}

function safeActionId(actionId) {
  const value = String(actionId ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new Error("Action id must be 8-128 safe characters");
  }
  return value;
}

export function hashAction(action) {
  return createHash("sha256")
    .update(stableJson({
      id: action.id,
      type: action.type,
      requestedBy: action.requestedBy,
      request: action.request,
    }))
    .digest("hex");
}

function hashEffect(type, _actor, request) {
  // Shared CRM effects cannot be retried by changing employee, approval ID or
  // the verification request after an uncertain provider outcome.
  let effect=request;
  if(type==='api_request') {
    const {readback: _readback,...operation}=request;
    const url=new URL(operation.path,'https://api.attio.com');url.searchParams.sort();
    effect={...operation,path:url.pathname+url.search};
  }
  return createHash('sha256').update(stableJson({type,request:effect})).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
