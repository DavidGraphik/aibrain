import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { EnterpriseDocumentNetwork } from "./enterprise-document-network";

const access=vi.hoisted(()=>({roots:vi.fn(),allowed:vi.fn()}));
vi.mock("./server-user-access",()=>({serverUserRoots:access.roots,serverPathAllowed:access.allowed}));
import { ServerDocumentFiles } from "./server-files";

const bytes=Buffer.from("synthetic workbook"), sha=createHash("sha256").update(bytes).digest("hex");
const base="server-g03/M/G03/QUALITAT/book.xlsm";
const network={config:{installationId:"g03-production",paths:{dataRoot:"/tmp/g03-test"}},validateSyncRoots:vi.fn(async()=>{})} as unknown as EnterpriseDocumentNetwork;
const original={available:true,scope:"company",sourceChecked:true,path:base,base64:bytes.toString("base64"),sha256:sha,size:bytes.length};
beforeEach(()=>{vi.resetAllMocks();access.roots.mockResolvedValue(["server-g03/M/G03/QUALITAT"]);access.allowed.mockReturnValue(true);});
it("uses an authorized original and returns version-bound, explicitly partial pages",async()=>{
  const spreadsheetReader=vi.fn(async()=>({content:"first",parts:3,preview:null}));
  const files=new ServerDocumentFiles(network,{userId:"actor",spreadsheetReader});
  const read=vi.spyOn(files,"readOriginal").mockResolvedValue(original);
  const result=await files.read([],{scope:"company",path:base});
  expect(read).toHaveBeenCalledWith([],{scope:"company",path:base});
  expect(result).toMatchObject({available:true,content:"first",nextPath:base+"?part=2&sha256="+sha,truncated:true,coverage:{documentCompleteInResponse:false,versionBound:true}});
  expect(result).not.toHaveProperty("base64");
});
it("does not extract a changed source or release content after access revocation",async()=>{
  const spreadsheetReader=vi.fn(async()=>({content:"private",parts:2,preview:null}));
  const files=new ServerDocumentFiles(network,{userId:"actor",spreadsheetReader});
  vi.spyOn(files,"readOriginal").mockResolvedValue(original);
  expect(await files.read([],{scope:"company",path:base+"?part=2&sha256="+"0".repeat(64)})).toMatchObject({available:false,error:"SERVER_SOURCE_CHANGED"});
  expect(spreadsheetReader).not.toHaveBeenCalled();
  access.allowed.mockReturnValue(false);
  const denied=await files.read([],{scope:"company",path:base});
  expect(denied).toMatchObject({available:false});expect(denied).not.toHaveProperty("content");
});
it("does not invoke the reader when the original authorization fails",async()=>{
  const spreadsheetReader=vi.fn(async()=>({content:"private",parts:1,preview:null}));
  const files=new ServerDocumentFiles(network,{userId:"actor",spreadsheetReader});
  vi.spyOn(files,"readOriginal").mockResolvedValue({available:false,error:"SERVER_REQUEST_DENIED"});
  expect(await files.read([],{scope:"company",path:base})).toMatchObject({available:false});
  expect(spreadsheetReader).not.toHaveBeenCalled();
});
