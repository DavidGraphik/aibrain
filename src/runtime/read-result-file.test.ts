import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
vi.mock("server-only",()=>({}));
import { finalizeOwnedReadResult, ownedReadResultPolicy, type ReadResultFileContext } from "./read-result-file";
const actor="00000000-0000-4000-8000-000000000001",project="10000000-0000-4000-8000-000000000001";
const response=(value:unknown)=>({success:true,contentItems:[{type:"inputText",text:JSON.stringify(value)}]});
const sage={namespace:"aibrain_g03_sage",tool:"read_batch",arguments:{query:"synthetic"}};
const payload=()=>({data:{rows:Array.from({length:150},(_,i)=>({id:i,value:"é".repeat(500)})),nextCursor:"original-cursor",complete:false,totalCount:999}});
let root:string,c:ReadResultFileContext;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),"aibrain-result-test-"));root=await import("node:fs/promises").then(fs=>fs.realpath(root));const usersRoot=path.join(root,"users"),workspaceRoot=path.join(usersRoot,actor,"workspace");c={installationId:"company-a",userId:actor,projectId:project,threadId:"20000000-0000-4000-8000-000000000001",turnId:"30000000-0000-4000-8000-000000000001",callId:"call-one",usersRoot,workspaceRoot,projectWorkspace:path.join(workspaceRoot,"projects",project)};await mkdir(c.projectWorkspace,{recursive:true,mode:0o700});});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const run=async(value:unknown=payload(),context=c,call:Parameters<typeof finalizeOwnedReadResult>[1]=sage)=>await finalizeOwnedReadResult(response(value),call,context) as ReturnType<typeof response>;
describe("owned large read results",()=>{
 it("captures exact full UTF8 bytes, keeps pagination and returns bounded metadata without rows",async()=>{
  const original=response(payload()),result=await finalizeOwnedReadResult(original,sage,c) as typeof original;
  const envelope=JSON.parse(result.contentItems[0].text),bytes=await readFile(path.join(c.projectWorkspace,envelope.relativePath));
  expect(bytes.equals(Buffer.from(original.contentItems[0].text))).toBe(true);expect(envelope.bytes).toBe(bytes.length);expect(envelope.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(JSON.parse(bytes.toString()).data).toMatchObject({nextCursor:"original-cursor",complete:false,totalCount:999});expect(envelope).toMatchObject({wholeResponseSaved:true,shape:{arrayCounts:[{jsonPointer:"/data/rows",count:150}]}});
  expect(result.contentItems[0].text.length).toBeLessThan(2000);expect(envelope).not.toHaveProperty("complete");expect(envelope.relativePath).toMatch(/^\.tool-results\/[a-f0-9-]+\/[a-f0-9]{64}\.json$/);
  expect((await stat(path.join(c.projectWorkspace,envelope.relativePath))).mode&0o777).toBe(0o400);
  expect(await finalizeOwnedReadResult(original,sage,c)).toEqual(result);
 });
 it("preserves a full2MiB read payload without reducing source or worker framing",async()=>{
  const value={data:"x".repeat(2*1024*1024),nextOffset:150,coverage:{globalComplete:false}};
  const result=await run(value),info=JSON.parse(result.contentItems[0].text);
  expect(await readFile(path.join(c.projectWorkspace,info.relativePath),"utf8")).toBe(JSON.stringify(value));
  expect(info.bytes).toBe(Buffer.byteLength(JSON.stringify(value)));expect(result.contentItems[0].text.length).toBeLessThan(2000);
 });
 it("counts UTF8 bytes and leaves exactly64KiB inline",async()=>{
  const small={value:"x".repeat(65536-12)};expect(Buffer.byteLength(JSON.stringify(small))).toBe(65536);
  expect(await finalizeOwnedReadResult(response(small),sage,c)).toEqual(response(small));
  const large={value:"é".repeat(33000)};expect(JSON.parse((await run(large)).contentItems[0].text).kind).toBe("private-json-result");
 });
 it.each(["attio_api","sibema_api"])("uses registered read-command policy for %s, never action/status commands",async tool=>{
  const read={namespace:"trinalum_business",tool,arguments:{command:"read"}};
  expect(JSON.parse((await run(payload(),c,read)).contentItems[0].text).kind).toBe("private-json-result");
  for(const command of ["prepare","execute","action","status",undefined]){const call={...read,arguments:{command}};expect(await finalizeOwnedReadResult(response(payload()),call,c)).toEqual(response(payload()));}
 });
 it("preserves original binary delivery identified by the server callback, not provider fields",async()=>{
  const original=response(payload()),call={namespace:"trinalum_business",tool:"sibema_api",arguments:{command:"read"}};
  expect(await finalizeOwnedReadResult(original,call,{...c,fileDelivery:true})).toBe(original);
 });
 it("does not infer read-only from names, user claims, response data or failed handlers",async()=>{
  expect(ownedReadResultPolicy("unknown","read",{readOnly:true})).toBe(false);
  for(const tool of ["prepare","execute","operation"]){const call={...sage,tool};expect(await finalizeOwnedReadResult(response(payload()),call,c)).toEqual(response(payload()));}
  const denied={...response(payload()),success:false};expect(await finalizeOwnedReadResult(denied,sage,c)).toBe(denied);
 });
 it("preserves mixed images/audio, nonJSON and mail/original result semantics",async()=>{
  for(const item of [{type:"inputImage",imageUrl:"data:image/png;base64,original"},{type:"inputAudio",audioUrl:"data:audio/wav;base64,original"}]){const mixed={success:true,contentItems:[...response(payload()).contentItems,item]};expect(await finalizeOwnedReadResult(mixed,sage,c)).toBe(mixed);}
  const text={success:true,contentItems:[{type:"inputText",text:"raw ".repeat(20000)}]};expect(await finalizeOwnedReadResult(text,sage,c)).toBe(text);
  for(const tool of ["mail_api","mail_read","read_private_file"]){const call={namespace:"trinalum_business",tool,arguments:{command:"read"}};const value=response(payload());expect(await finalizeOwnedReadResult(value,call,c)).toBe(value);}
 });
 it.each(["actor","project","traversal","turn","call"])("rejects invalid %s scope without flooding the result",async kind=>{
  const invalid={...c};if(kind==="actor")invalid.userId="00000000-0000-4000-8000-000000000002";if(kind==="project")invalid.projectId="10000000-0000-4000-8000-000000000002";if(kind==="traversal")invalid.projectWorkspace=path.join(root,"..");if(kind==="turn")invalid.turnId="../../other";if(kind==="call")invalid.callId="";
  const result=await run(payload(),invalid);expect(result.success).toBe(false);expect(result.contentItems[0].text).toContain("TOOL_RESULT_CAPTURE_UNAVAILABLE");expect(result.contentItems[0].text.length).toBeLessThan(200);
 });
 it("rejects symlink directories and targets, preserving external bytes",async()=>{
  const outside=path.join(root,"outside");await mkdir(outside);await symlink(outside,path.join(c.projectWorkspace,".tool-results"));expect((await run()).success).toBe(false);
  await rm(path.join(c.projectWorkspace,".tool-results"));const valid=await run(),envelope=JSON.parse(valid.contentItems[0].text),target=path.join(c.projectWorkspace,envelope.relativePath),external=path.join(outside,"secret");await writeFile(external,"unchanged");await rm(target);await symlink(external,target);expect((await run()).success).toBe(false);expect(await readFile(external,"utf8")).toBe("unchanged");
 });
 it("returns typed failure on IO failure or a changed stable call result, never raw fallback",async()=>{
  await writeFile(path.join(c.projectWorkspace,".tool-results"),"not a directory");expect((await run()).success).toBe(false);await rm(path.join(c.projectWorkspace,".tool-results"));await run();expect((await run({...payload(),different:true})).success).toBe(false);
 });
 it("bounds hostile schema keys without truncating saved data",async()=>{
  const data={["x".repeat(100000)]:[1,2]};const result=await run(data);expect(result.contentItems[0].text.length).toBeLessThan(2000);const info=JSON.parse(result.contentItems[0].text);expect(info.shape.keysTruncated).toBe(true);expect(JSON.parse(await readFile(path.join(c.projectWorkspace,info.relativePath),"utf8"))).toEqual(data);
 });
 it("lets an offline Python filesystem reader aggregate the saved JSON without printing rows",async()=>{
  const result=await run(),info=JSON.parse(result.contentItems[0].text);
  const proof=spawnSync("python3",["-c","import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps({'rows':len(d['data']['rows']),'sum':sum(r['id'] for r in d['data']['rows']),'nextCursor':d['data']['nextCursor']}))",info.relativePath],{cwd:c.projectWorkspace,encoding:"utf8"});
  expect(proof.status).toBe(0);expect(JSON.parse(proof.stdout)).toEqual({rows:150,sum:11175,nextCursor:"original-cursor"});
 });
});
