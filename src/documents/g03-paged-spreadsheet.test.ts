import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readG03PagedSpreadsheet } from "./g03-paged-spreadsheet";

const bytes=Buffer.from("synthetic workbook bytes");
const digest=createHash("sha256").update(bytes).digest("hex");
const gate={run:async <T>(operation:()=>T|Promise<T>)=>await operation()};
it("uses the fixed bounded wrapper and deletes its private input after reading",async()=>{
  let work="";
  const run=vi.fn(async(command:string,args:readonly string[],options:{cwd:string})=>{
    work=options.cwd;
    expect(command).toBe("/usr/local/bin/aibrain-g03-paged-spreadsheet");
    expect(args).toEqual([".xlsm","2"]);
    expect(await readFile(path.join(work,"source.xlsm"))).toEqual(bytes);
    return {stdout:JSON.stringify({ok:true,sourceSha256:digest,page:2,parts:3,text:"second"}),stderr:""};
  });
  expect(await readG03PagedSpreadsheet(bytes,".xlsm",2,{conversionGate:gate,runner:{run}})).toMatchObject({content:"second",parts:3});
  await expect(access(work)).rejects.toThrow();
});
it("fails closed on a changed input, malformed page or unsafe suffix",async()=>{
  for(const value of [
    {ok:true,sourceSha256:"0".repeat(64),page:1,parts:2,text:"x"},
    {ok:true,sourceSha256:digest,page:2,parts:2,text:"x"},
    {ok:true,sourceSha256:digest,page:1,parts:1000,text:"x"},
    {ok:true,sourceSha256:digest,page:1,parts:2,text:"x".repeat(20001)},
  ]){
    const run=vi.fn(async()=>({stdout:JSON.stringify(value),stderr:""}));
    await expect(readG03PagedSpreadsheet(bytes,".xlsm",1,{conversionGate:gate,runner:{run}})).rejects.toThrow("SERVER_SPREADSHEET_INVALID");
  }
  const run=vi.fn();
  await expect(readG03PagedSpreadsheet(bytes,".doc",1,{conversionGate:gate,runner:{run}})).rejects.toThrow("SERVER_SPREADSHEET_INPUT_INVALID");
  expect(run).not.toHaveBeenCalled();
});
