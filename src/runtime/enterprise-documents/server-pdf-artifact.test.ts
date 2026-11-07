import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileLibraryResourceLocationIndex } from "@/library/resource-location-index";
import { isGeneratedArtifact } from "@/lib/chat-contract";
import { createServerPdfArtifact } from "./server-pdf-artifact";
import { handleCompanyFilesDynamicToolCall, COMPANY_FILES_DYNAMIC_TOOLS } from "./dynamic-tools";

vi.mock("server-only", () => ({}));
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const bytes=Buffer.from("%PDF-1.7\nOriginal source fixture, unchanged bytes");
const sha256=createHash("sha256").update(bytes).digest("hex");
const source=()=>({available:true,scope:"company",path:"server-g03/M/Qualitat/06039MT100_%20DESMO%20ALUMINIO%20PAUTAS-F2.pdf",sourceChecked:true,checkedAt:new Date().toISOString(),size:bytes.length,sha256,base64:bytes.toString("base64")});
async function fixture(){
  const dataRoot=await mkdtemp(path.join(tmpdir(),"aibrain-server-pdf-"));roots.push(dataRoot);
  return {installation:{installationId:"g03-production",paths:{dataRoot} as InstallationConfig["paths"]},
    storageOwnerId:"00000000-0000-4000-8000-000000000001",projectId:"00000000-0000-4000-8000-000000000002",
    threadId:"00000000-0000-4000-8000-000000000003",messageId:"00000000-0000-4000-8000-000000000004"};
}
const params=()=>({namespace:"aibrain_company_files",tool:"read",threadId:"thread",turnId:"turn",callId:"call",arguments:{scope:"company",path:source().path,original:true}});
const parsed=(response:Awaited<ReturnType<typeof handleCompanyFilesDynamicToolCall>>)=>JSON.parse((response.contentItems[0] as {text:string}).text);

it("copies only the verified original PDF bytes into a private owner/thread-bound preview and download",async()=>{
  const context=await fixture(),result=source();
  const artifact=await createServerPdfArtifact(result,context);
  expect(isGeneratedArtifact(artifact)).toBe(true);
  expect(artifact).toMatchObject({name:"06039MT100_ DESMO ALUMINIO PAUTAS-F2.pdf",kind:"pdf",mimeType:"application/pdf",status:"ready",size:bytes.length,previewUrl:expect.stringContaining("?preview=1"),url:expect.stringContaining("?download=1")});
  const index=new FileLibraryResourceLocationIndex({installationId:context.installation.installationId,dataRoot:context.installation.paths.dataRoot});
  const binding=await index.binding("generated-document",artifact!.id);
  expect(binding).toMatchObject({storageOwnerId:context.storageOwnerId,projectId:context.projectId,threadId:context.threadId,sha256,size:bytes.length});
  const target=path.join(context.installation.paths.dataRoot,binding!.relativePath!);
  expect(await readFile(target)).toEqual(bytes);
  expect(await createServerPdfArtifact(result,context)).toEqual(artifact);
  await expect(index.resolve("generated-document",artifact!.id,{projectId:context.projectId,threadId:"foreign-thread"})).rejects.toThrow();
  await writeFile(target,"tampered");
  await expect(createServerPdfArtifact(result,context)).rejects.toThrow();
});

it("rejects stale, unverified, non-PDF or invalid original responses without publishing misleading artifacts",async()=>{
  const context=await fixture(),result=source();
  for(const changed of [{available:false},{sourceChecked:false},{scope:"private"},{checkedAt:"2020-01-01T00:00:00Z"},{path:result.path+"?part=1"},{path:"server-g03/M/file.txt"},{size:17*1024*1024}]){
    expect(await createServerPdfArtifact({...result,...changed},context)).toBeNull();
  }
  await expect(createServerPdfArtifact({...result,sha256:"a".repeat(64)},context)).rejects.toThrow("identity");
  const invalid=Buffer.from("not a PDF");
  await expect(createServerPdfArtifact({...result,base64:invalid.toString("base64"),size:invalid.length,sha256:createHash("sha256").update(invalid).digest("hex")},context)).rejects.toThrow();
});

it("routes explicit original reads through the authorized broker and returns the projected artifact without binary content",async()=>{
  const context=await fixture();let emitted=0;
  const read=vi.fn(),readOriginal=vi.fn(async()=>source());
  const onServerRead=async(result:Record<string,unknown>)=>{const artifact=await createServerPdfArtifact(result,context);if(artifact)emitted++;return artifact;};
  const response=await handleCompanyFilesDynamicToolCall(params() as never,{network:{},roots:[],runtimeThreadId:"thread",runtimeTurnId:"turn",serverFiles:{read,readOriginal},onServerRead} as never);
  expect(response.success).toBe(true);expect(read).not.toHaveBeenCalled();expect(readOriginal).toHaveBeenCalledWith([],{roots:[],scope:"company",scopeId:undefined,path:source().path});
  expect(parsed(response)).toMatchObject({available:true,sha256,artifact:{kind:"pdf",status:"ready"}});
  expect(parsed(response)).not.toHaveProperty("base64");expect(JSON.stringify(response)).not.toContain(bytes.toString("base64"));expect(emitted).toBe(1);
  expect(JSON.stringify(COMPANY_FILES_DYNAMIC_TOOLS)).toContain('"original":{"type":"boolean"');
});

it("never fetches an original for another turn, local/indexed path or malformed request",async()=>{
  const readOriginal=vi.fn(async()=>source());const context={network:{},roots:[],runtimeThreadId:"thread",runtimeTurnId:"turn",serverFiles:{readOriginal}};
  for(const request of [{...params(),turnId:"foreign"},{...params(),arguments:{...params().arguments,path:"knowledge-secret/file.pdf"}},{...params(),arguments:{...params().arguments,path:"file.pdf"}},{...params(),arguments:{...params().arguments,original:"true"}}])expect((await handleCompanyFilesDynamicToolCall(request as never,context as never)).success).toBe(false);
  expect(readOriginal).not.toHaveBeenCalled();
});

it("reports unavailable attachment projection honestly and never leaks original bytes on a failed hook",async()=>{
  const context={network:{},roots:[],runtimeThreadId:"thread",runtimeTurnId:"turn",serverFiles:{readOriginal:async()=>source()}};
  const response=await handleCompanyFilesDynamicToolCall(params() as never,{...context,onServerRead:async()=>{throw Error("disk unavailable");}} as never);
  expect(parsed(response)).toMatchObject({available:true,previewWarning:expect.stringContaining("No afirmes")});
  expect(parsed(response)).not.toHaveProperty("artifact");expect(parsed(response)).not.toHaveProperty("base64");
  const noHook=await handleCompanyFilesDynamicToolCall(params() as never,context as never);
  expect(parsed(noHook)).toHaveProperty("previewWarning");expect(parsed(noHook)).not.toHaveProperty("base64");
  const denied=await handleCompanyFilesDynamicToolCall(params() as never,{...context,serverFiles:{readOriginal:async()=>({available:false})},onServerRead:vi.fn()} as never);
  expect(parsed(denied)).toEqual({available:false});
});
