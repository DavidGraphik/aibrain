#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttioClient } from "../lib/client.mjs";
import { AttioActionStore } from "../lib/action-store.mjs";
import { normalizeCommercialValues } from "../lib/commercial-schema.mjs";
import { taskText } from "../lib/task-display.mjs";
import { validateApiRequest } from '../lib/api-contract.mjs';
import { executeApiAction } from '../lib/api-action.mjs';

const ACTION_TYPES = new Set([
  "create_company",
  "create_person",
  "api_request",
  "create_note",
  "create_task",
  "update_task",
  "delete_task",
  "create_deal",
  "update_deal",
  "update_company",
  "update_person",
  "upsert_commercial_entry",
]);
const LIST_SLUG = process.env.ATTIO_COMMERCIAL_LIST_SLUG?.trim() || "trinalum_comercial";
const actionMode = process.env.ATTIO_ACTION_MODE?.trim().toLowerCase() || "review_only";
const dataDirectory = process.env.ATTIO_DATA_DIR?.trim() || "/opt/trinalum/data/attio";
const store = new AttioActionStore(path.join(dataDirectory, "actions"));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    const args = parseArgs(process.argv.slice(3));
    if (!command || command === '--help' || command === '-h') {
      print({usage:'attio-action.mjs prepare --input FILE | show --action-id ID | execute --action-id ID --approved-by NAME --confirmed-exact-action',actions:[...ACTION_TYPES],update_task:{taskId:'UUID',deadlineAt:'ISO-8601 including timezone',isCompleted:'optional boolean',assigneeId:'optional workspace member UUID'}});
    } else if (command === "prepare") {
      const action = validateAction(
        JSON.parse(await readFile(requiredArg(args, "input"), "utf8")),
      );
      if (action.type === 'create_task') {
        const client = new AttioClient();
        await client.get('/tasks?limit=1');
        const members = (await client.get('/workspace_members')).data;
        if (!members.some(m=>m.id?.workspace_member_id===action.request.assigneeId)) throw new Error('Task assignee is not a verified workspace member');
        await client.get(`/objects/${action.request.parentObject??'companies'}/records/${action.request.recordId}`);
      }
      if(action.type==='update_task'||action.type==='delete_task') {
        const client=new AttioClient();
        await client.get(`/tasks/${action.request.taskId}`);
        if(action.request.assigneeId){
          const members=(await client.get('/workspace_members')).data;
          if(!members.some(m=>m.id.workspace_member_id===action.request.assigneeId))throw new Error('Task assignee is not a verified workspace member');
        }
        for(const link of action.request.linkedRecords??[])await client.get(`/objects/${link.target_object}/records/${link.target_record_id}`);
      }
      const stored = await store.prepare(action);
      print({
        status: stored.status,
        action: preview(stored),
        next: `Show and approve the exact action before executing ${stored.action_id}`,
      });
    } else if (command === "status-proof") {
      // Operator/broker only: hold the existing action AND effect locks through
      // the upper audited CAS. No provider client, approval or state write.
      if(!args.hold)throw new Error('status-proof requires --hold');
      await store.withStatusProof(requiredArg(args,'action-id'),canonicalUser(requiredArg(args,'actor')),requiredArg(args,'request-hash'),args['proof-category']??'no-dispatch',async proof=>{
        process.stdout.write(JSON.stringify(proof)+'\n');
        await new Promise(resolve=>{
          const done=()=>{clearTimeout(timer);process.removeListener('SIGTERM',done);process.stdin.pause();resolve();};
          const timer=setTimeout(done,30000);
          process.stdin.once('end',done);process.stdin.once('error',done);process.once('SIGTERM',done);process.stdin.resume();
        });
      });
    } else if (command === "show") {
      const stored = await store.require(requiredArg(args, "action-id"));
      print({ status: stored.status, action: preview(stored) });
    } else if (command === "execute") {
      assertExecutionMode(actionMode);
      if (!args["confirmed-exact-action"]) {
        throw new Error("--confirmed-exact-action is required");
      }
      const actionId = requiredArg(args, "action-id");
      const approvedBy = canonicalUser(requiredArg(args, "approved-by"));
      let stored = await store.require(actionId);
      if (stored.requested_by !== approvedBy) {
        throw new Error("The approving user must be the user who requested the exact action");
      }
      if (stored.action_type === 'api_request') {
        print(await executeApiAction(store, actionId, approvedBy));
      } else if (stored.status === "completed") {
        print({
          status: "already_completed",
          actionId,
          executedAt: stored.executed_at,
          result: stored.result,
          readback: stored.readback,
        });
      } else {
        await store.assertDispatchable(actionId);
        if (!(await store.claim(actionId))) {
          throw new Error(`Attio action ${actionId} is already being executed`);
        }
        try {
          stored = await store.approve(actionId, approvedBy);
          const client = new AttioClient();
          if (stored.action_type === "create_company") {
            await assertCompanyDoesNotExist(client, stored.request.values);
          }
          if (stored.action_type === 'create_person') {
            const people=await client.listRecords('people');
            if(people.some(person=>duplicatePerson(person,stored.request.values))){const error=new Error('A matching Attio person already exists');error.code='ATTIO_PERSON_ALREADY_EXISTS';throw error;}
          }
          if (stored.action_type === "create_deal") {
            const existing = await client.listRecords("deals");
            const companyId = stored.request.values.associated_company?.[0]?.target_record_id;
            if (existing.some(d => plainText(d.values?.name) === plainText(stored.request.values.name) && d.values?.associated_company?.some(v => v.target_record_id === companyId))) {
              throw new Error("An identical Deal for this company already exists");
            }
          }
          const operation = operationForStored(stored);
          let result;
          if(stored.action_type === "create_task") {
            if ((stored.request.parentObject ?? "companies") === "deals") {
              const deal = (await client.get(`/objects/deals/records/${stored.request.recordId}`)).data;
              const companyId = deal.values?.associated_company?.find(v => v.active_until === null)?.target_record_id;
              if (companyId) operation.body.data.linked_records.push({target_object:"companies",target_record_id:companyId});
            }
            const marker=`Registro Trinalum: ${stored.action_id}`;
            const tasks=await client.listTasks();
            const existing=tasks.find(t=>t.linked_records?.some(x=>x.target_record_id===stored.request.recordId)&&((t.content_plaintext??'').split('\n').includes(marker)||(!t.is_completed&&taskText(t)===operation.body.data.content&&Date.parse(t.deadline_at)===Date.parse(stored.request.deadlineAt)&&t.assignees?.some(x=>x.referenced_actor_id===stored.request.assigneeId))));
            if(existing) result={data:existing};
            else {await store.markDispatched(actionId);result=await client.request(operation.method,operation.path,operation.body,{maxAttempts:1});}
          } else if(stored.action_type === "create_note") {
            const marker = `Registro Trinalum: ${stored.action_id}`;
            const notes = await client.listNotes({parent_object:stored.request.parentObject??"companies",parent_record_id:stored.request.recordId});
            const existing=notes.find(n=>(n.content_plaintext??n.content_markdown??"").includes(marker));
            operation.body.data.content += `\n\nResponsable del registro: ${stored.requested_by}\n${marker}`;
            if(existing) result={data:existing};
            else {await store.markDispatched(actionId);result=await client.request(operation.method,operation.path,operation.body,{maxAttempts:1});}
          } else {await store.markDispatched(actionId);result = await client.request(operation.method, operation.path, operation.body, { maxAttempts: 1 });}
          await store.recordProviderResult(actionId,result);
          const readback = await readBack(client, stored, result);
          await store.complete(actionId, result.data ?? result, readback);
          print({ status: "completed", actionId, result: result.data ?? result, readback });
        } catch (error) {
          await store.fail(actionId, error);
          throw error;
        } finally {
          await store.release(actionId);
        }
      }
    } else {
      throw new Error(
        "Usage: attio-action.mjs prepare --input FILE | show --action-id ID | execute --action-id ID --approved-by NAME --confirmed-exact-action",
      );
    }
  } catch (error) {
    let nativeDisposition;
    if(process.argv[2]==='execute'){
      try{
        const a=parseArgs(process.argv.slice(3)),id=requiredArg(a,'action-id'),record=await store.require(id);
        await store.withStatusProof(id,canonicalUser(requiredArg(a,'approved-by')),record.request_hash,'definitive-rejection',async proof=>{nativeDisposition=proof;});
      }catch{/* A missing/busy/unverifiable receipt never becomes a rejection proof. */}
    }
    console.error(JSON.stringify({
      status: "error",
      code: error.code ?? null,
      httpStatus: error.status ?? null,
      message: error.message,
      ...(nativeDisposition?{nativeDisposition}:{}),
    }));
    process.exitCode = 1;
  }
}

export function validateAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("Action must be a JSON object");
  }
  const id = String(action.id ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id)) {
    throw new Error("Action id must be 8-128 safe characters");
  }
  if (!ACTION_TYPES.has(action.type)) {
    throw new Error(`Unsupported Attio action type: ${action.type}`);
  }
  const requestedBy = canonicalUser(action.requestedBy);
  let request = requiredObject(action.request, "request");
  if (action.type === 'upsert_commercial_entry') request = {...request, values:normalizeCommercialValues(requiredObject(request.values,'request.values'))};
  operationFor({ type: action.type, request });
  return { id, type: action.type, requestedBy, request };
}

export function operationFor(action) {
  const request = action.request;
  if(action.type==='api_request')return validateApiRequest(request,{writeOnly:true});
  if(action.type==='delete_task') {
    if(Object.keys(request).join(',')!=='taskId')throw new Error('Task deletion accepts taskId only');
    return {method:'DELETE',path:`/tasks/${requiredId(request.taskId,'request.taskId')}`};
  }
  if(action.type==='update_task') {
    if(Object.keys(request).some(k=>!['taskId','deadlineAt','isCompleted','assigneeId','linkedRecords'].includes(k)))throw new Error('Unsupported Task update field');
    const data={};
    if(request.deadlineAt!==undefined){
      if(typeof request.deadlineAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(request.deadlineAt)||!Number.isFinite(Date.parse(request.deadlineAt)))throw new Error('Task deadline must be ISO-8601 with explicit timezone');
      data.deadline_at=request.deadlineAt;
    }
    if(request.isCompleted!==undefined){if(typeof request.isCompleted!=='boolean')throw new Error('Task completion must be boolean');data.is_completed=request.isCompleted;}
    if(request.assigneeId!==undefined)data.assignees=[{referenced_actor_type:'workspace-member',referenced_actor_id:requiredId(request.assigneeId,'request.assigneeId')}];
    if(request.linkedRecords!==undefined){
      if(!Array.isArray(request.linkedRecords)||request.linkedRecords.length>100)throw new Error('linkedRecords must be an array of at most 100 verified records');
      data.linked_records=request.linkedRecords.map(link=>{
        if(!link||Object.keys(link).sort().join(',')!=='target_object,target_record_id'||!['companies','people','deals'].includes(link.target_object))throw new Error('Invalid Task linked record');
        return {target_object:link.target_object,target_record_id:requiredId(link.target_record_id,'linkedRecords.target_record_id')};
      });
    }
    if(!Object.keys(data).length)throw new Error('Task update cannot be empty');
    return {method:'PATCH',path:`/tasks/${requiredId(request.taskId,'request.taskId')}`,body:{data}};
  }
  if(action.type==='create_task') {
    const parent=request.parentObject??'companies';
    if(!['companies','people','deals'].includes(parent))throw new Error('Unsupported task parent');
    const content=String(request.content??'').trim();
    if(!content || content.length>10000)throw new Error('Task content must contain 1-10000 characters');
    if(typeof request.deadlineAt!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(request.deadlineAt) || !Number.isFinite(Date.parse(request.deadlineAt)))throw new Error('Task deadline must be ISO-8601 with explicit timezone');
    return {method:'POST',path:'/tasks',body:{data:{content,format:'plaintext',deadline_at:request.deadlineAt,is_completed:false,linked_records:[{target_object:parent,target_record_id:requiredId(request.recordId,'request.recordId')}],assignees:[{referenced_actor_type:'workspace-member',referenced_actor_id:requiredId(request.assigneeId,'request.assigneeId')}]}}};
  }
  if(action.type === "create_note") {
    const parent = request.parentObject ?? "companies";
    if(!["companies","people","deals"].includes(parent)) throw new Error("Unsupported note parent");
    if(!String(request.title??"").trim() || !String(request.content??"").trim()) throw new Error("Note title and content required");
    return {method:"POST",path:"/notes",body:{data:{parent_object:parent,parent_record_id:requiredId(request.recordId,"request.recordId"),title:request.title,format:"markdown",content:request.content}}};
  }
  const values = requiredObject(request.values, "request.values");
  if (Object.keys(values).length === 0) throw new Error("request.values cannot be empty");
  switch (action.type) {
    case 'create_person':
      if(values.name!==undefined)validatePersonalName(values.name);
      if(!plainText(values.name)&&!tokenSet(values,['email_addresses']).size)throw new Error('Person name or verified email is required');
      return {method:'POST',path:'/objects/people/records',body:{data:{values}}};
    case "create_deal":
      if (!plainText(values.name) || !plainText(values.stage) || !plainText(values.owner) || !values.associated_company?.[0]?.target_record_id) {
        throw new Error("Deal name, stage, owner and associated_company are required");
      }
      return { method: "POST", path: "/objects/deals/records", body: { data: { values } } };
    case "update_deal":
      if (Object.keys(values).some(k => !["name","stage","owner","associated_company","next_step","action_deadline"].includes(k))) {
        throw new Error("Unsupported Deal update field");
      }
      return { method: "PUT", path: `/objects/deals/records/${requiredId(request.recordId, "request.recordId")}`, body: { data: { values } } };
    case "create_company":
      if (!plainText(values.name)) throw new Error("request.values.name is required");
      return {
        method: "POST",
        path: "/objects/companies/records",
        body: { data: { values } },
      };
    case "update_company":
      return {
        method: "PUT",
        path: `/objects/companies/records/${requiredId(request.recordId, "request.recordId")}`,
        body: { data: { values } },
      };
    case "update_person":
      return {
        method: "PUT",
        path: `/objects/people/records/${requiredId(request.recordId, "request.recordId")}`,
        body: { data: { values } },
      };
    case "upsert_commercial_entry":
      return {
        method: "PUT",
        path: `/lists/${encodeURIComponent(LIST_SLUG)}/entries`,
        body: {
          data: {
            parent_object: "companies",
            parent_record_id: requiredId(request.companyRecordId, "request.companyRecordId"),
            entry_values: values,
          },
        },
      };
    default:
      throw new Error(`Unsupported Attio action type: ${action.type}`);
  }
}

export function validatePersonalName(value){
  const entries=Array.isArray(value)?value:[value];
  if(entries.length!==1)throw new Error('Person name requires one exact string or first_name, last_name and full_name');
  const name=entries[0];
  if(typeof name==='string'&&name.trim())return value;
  if(name&&typeof name==='object'&&!Array.isArray(name)&&Object.keys(name).sort().join(',')==='first_name,full_name,last_name'&&['first_name','last_name','full_name'].every(k=>typeof name[k]==='string')&&name.full_name.trim())return value;
  throw new Error('Person name requires an exact string or all three first_name, last_name and full_name fields');
}

function operationForStored(stored) {
  return operationFor({ type: stored.action_type, request: stored.request });
}

async function readBack(client, stored, result) {
  if(stored.action_type==='delete_task'){
    try{await client.get(`/tasks/${stored.request.taskId}`);}catch(error){if(error.status===404)return {taskId:stored.request.taskId,deleted:true};throw error;}
    throw new Error('Task still exists after deletion');
  }
  if(stored.action_type==='update_task'){
    const task=(await client.get(`/tasks/${stored.request.taskId}`)).data;
    if(stored.request.deadlineAt!==undefined&&Date.parse(task.deadline_at)!==Date.parse(stored.request.deadlineAt))throw new Error('Task deadline readback mismatch');
    if(stored.request.isCompleted!==undefined&&task.is_completed!==stored.request.isCompleted)throw new Error('Task completion readback mismatch');
    if(stored.request.assigneeId!==undefined&&!task.assignees?.some(a=>a.referenced_actor_id===stored.request.assigneeId))throw new Error('Task owner readback mismatch');
    if(stored.request.linkedRecords!==undefined){
      const types=[...new Set(stored.request.linkedRecords.map(link=>link.target_object))];
      const byType=new Map(await Promise.all(types.map(async type=>[type,(await client.get(`/objects/${type}`)).data.id.object_id])));
      const objects=stored.request.linkedRecords.map(link=>({object:byType.get(link.target_object),id:link.target_record_id}));
      if(task.linked_records?.length!==objects.length||objects.some(link=>!task.linked_records.some(actual=>actual.target_object_id===link.object&&actual.target_record_id===link.id)))throw new Error('Task linked records readback mismatch');
    }
    return task;
  }
  if (stored.action_type === "create_deal" || stored.action_type === "update_deal") {
    const id = stored.action_type === "create_deal" ? result.data?.id?.record_id : stored.request.recordId;
    if (!id) throw new Error("Deal ID missing for readback");
    const deal = (await client.get(`/objects/deals/records/${encodeURIComponent(id)}`)).data;
    for (const key of ["name","next_step","action_deadline"]) {
      const expected = key === "action_deadline" ? String(plainText(stored.request.values[key])).slice(0,10) : plainText(stored.request.values[key]);
      const actual = key === "action_deadline" ? String(plainText(deal.values?.[key])).slice(0,10) : plainText(deal.values?.[key]);
      if (stored.request.values[key] !== undefined && expected !== actual) {
        throw new Error(`Deal ${key} readback mismatch`);
      }
    }
    return deal;
  }
  if(stored.action_type==='create_task') {
    const id=result.data?.id?.task_id;if(!id)throw new Error('Task id missing for readback');
    const task=(await client.get(`/tasks/${encodeURIComponent(id)}`)).data;
    if(taskText(task)!==String(stored.request.content).trim() || !task.assignees?.some(x=>x.referenced_actor_id===stored.request.assigneeId) || !task.linked_records?.some(x=>x.target_record_id===stored.request.recordId) || Date.parse(task.deadline_at)!==Date.parse(stored.request.deadlineAt))throw new Error('Task readback does not match approved content, owner, record or deadline');
    return task;
  }
  if(stored.action_type === "create_note") {
    const id=result.data?.id?.note_id;if(!id)throw Error("Note id missing for readback");
    return (await client.get(`/notes/${encodeURIComponent(id)}`)).data;
  }
  if (stored.action_type === "create_company") {
    const recordId = result.data?.id?.record_id;
    if (!recordId) throw new Error("Attio did not return a company record id for readback");
    return (await client.get(
      `/objects/companies/records/${encodeURIComponent(recordId)}`,
    )).data;
  }
  if (stored.action_type === "update_company") {
    return (await client.get(
      `/objects/companies/records/${encodeURIComponent(stored.request.recordId)}`,
    )).data;
  }
  if (stored.action_type === "update_person") {
    return (await client.get(
      `/objects/people/records/${encodeURIComponent(stored.request.recordId)}`,
    )).data;
  }
  if(stored.action_type==='create_person'){
    const id=result.data?.id?.record_id;if(!id)throw new Error('Person ID missing for readback');
    return (await client.get(`/objects/people/records/${encodeURIComponent(id)}`)).data;
  }
  const entryId = result.data?.id?.entry_id;
  if (!entryId) throw new Error("Attio did not return an entry id for readback");
  return (await client.get(
    `/lists/${encodeURIComponent(LIST_SLUG)}/entries/${encodeURIComponent(entryId)}`,
  )).data;
}

async function assertCompanyDoesNotExist(client, candidateValues) {
  const records = await client.listRecords("companies");
  const duplicate = records.find((record) => duplicateCompany(record, candidateValues));
  if (!duplicate) return;
  const error = new Error(
    `A matching Attio company already exists: ${plainText(duplicate.values?.name) || duplicate.id?.record_id}`,
  );
  error.code = "ATTIO_COMPANY_ALREADY_EXISTS";
  throw error;
}

export function duplicateCompany(record, candidateValues) {
  const existing = record?.values ?? {};
  const candidateName = normalized(plainText(candidateValues?.name));
  const existingName = normalized(plainText(existing.name));
  if (candidateName && candidateName === existingName) return true;

  const candidateEmails = tokenSet(candidateValues, ["email_addresses", "trinalum_emails"]);
  const existingEmails = tokenSet(existing, ["email_addresses", "trinalum_emails"]);
  if (intersects(candidateEmails, existingEmails)) return true;

  const candidateDomains = tokenSet(candidateValues, ["domains"]);
  const existingDomains = tokenSet(existing, ["domains"]);
  return intersects(candidateDomains, existingDomains);
}

export function duplicatePerson(record,candidateValues) {
  const existing=record?.values??{};
  const emails=tokenSet(candidateValues,['email_addresses']);
  if(emails.size && intersects(emails,tokenSet(existing,['email_addresses'])))return true;
  const name=normalized(plainText(candidateValues.name));
  if(!name||name!==normalized(plainText(existing.name)))return false;
  const companies=values=>new Set((Array.isArray(values?.company)?values.company:values?.company?[values.company]:[]).map(value=>value?.target_record_id).filter(Boolean));
  return intersects(companies(candidateValues),companies(existing));
}

function plainText(value) {
  const item = Array.isArray(value) ? value[0] : value;
  return String(
    item?.value ??
      item?.full_name ??
      item?.title ??
      item?.email_address ??
      item?.original_email_address ??
      item?.domain ??
      item ??
      "",
  ).trim();
}

function tokenSet(values, slugs) {
  const tokens = new Set();
  for (const slug of slugs) {
    const items = Array.isArray(values?.[slug]) ? values[slug] : [values?.[slug]];
    for (const item of items) {
      const token = normalized(plainText(item));
      if (token) tokens.add(token.replace(/^www\./, ""));
    }
  }
  return tokens;
}

function normalized(value) {
  return String(value ?? "").trim().toLocaleLowerCase("es");
}

function intersects(left, right) {
  return [...left].some((value) => right.has(value));
}

function preview(stored) {
  return {
    id: stored.action_id,
    type: stored.action_type,
    requestedBy: stored.requested_by,
    request: stored.request,
    requestHash: stored.request_hash,
    status: stored.status,
    preparedAt: stored.prepared_at,
    approvedAt: stored.approved_at,
    executedAt: stored.executed_at,
    error: stored.error,
  };
}

export function canonicalUser(value) {
  const normalized = String(value ?? "").trim().toLocaleLowerCase("es");
  const users = new Map([
    ["david", "David"],
    ["trini", "Trini"],
    ["trinidad", "Trini"],
    ["miguel", "Miguel"],
    ["nerea", "Nerea"],
  ]);
  const canonical = users.get(normalized);
  if (!canonical) throw new Error("requestedBy/approvedBy must be David, Trini, Miguel, or Nerea");
  return canonical;
}

function assertExecutionMode(mode) {
  if (mode === "review_only") {
    throw new Error("Attio mutation is blocked in review_only");
  }
  if (mode !== "approval_required") {
    throw new Error(`Unsupported ATTIO_ACTION_MODE: ${mode}`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (name === "confirmed-exact-action" || name === "hold") {
      args[name] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    args[name] = value;
  }
  return args;
}

function requiredArg(args, name) {
  const value = args[name]?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredId(value, label) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error(`${label} is invalid`);
  return encodeURIComponent(id);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
