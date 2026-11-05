import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ResourceLockManager } from "@/storage";
import { acquireWorkerKernelLease, currentWorkerExecutionOrigin } from "./kernel-ownership";
const roots:string[]=[];
const generation="00000000-0000-4000-8000-000000000001";
export const testFlock=["python3","-c","import fcntl,sys;fcntl.flock(3,(fcntl.LOCK_SH if '--shared' in sys.argv else fcntl.LOCK_EX)|fcntl.LOCK_NB)"];
async function fixture(){const root=await realpath(await mkdtemp(path.join(tmpdir(),"kernel-owner-")));roots.push(root);return root;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
describe("worker generation kernel ownership",()=>{
  it("excludes a metadata reader while any process retains the inherited owner fd, then recovers immediately on death",async()=>{
    const root=await fixture();const owner=await acquireWorkerKernelLease(root,generation,"shared",{lockCommand:testFlock});
    const child=spawn(process.execPath,["-e","console.log('ready');setInterval(()=>{},1000)"],{stdio:["ignore","pipe","ignore",owner.fd]});
    try{
      await once(child.stdout!,"data");await owner.close();
      await expect(acquireWorkerKernelLease(root,generation,"exclusive",{lockCommand:testFlock})).rejects.toThrow("unavailable");
      const exit=once(child,"exit");child.kill("SIGKILL");await exit;
      const reader=await acquireWorkerKernelLease(root,generation,"exclusive",{lockCommand:testFlock,expected:owner});await reader.close();
    }finally{child.kill();}
  });
  it("allows another live generation while the dead origin is read exclusively",async()=>{
    const root=await fixture();const old=await acquireWorkerKernelLease(root,generation,"shared",{lockCommand:testFlock});await old.close();
    const live=await acquireWorkerKernelLease(root,"00000000-0000-4000-8000-000000000002","shared",{lockCommand:testFlock});
    try{const reader=await acquireWorkerKernelLease(root,generation,"exclusive",{lockCommand:testFlock,expected:old});await reader.close();}
    finally{await live.close();}
  });
  it("binds origin to the exact current gateway generation and role",async()=>{
    const root=await fixture();const role="app";
    const locks=new ResourceLockManager({rootDirectory:path.join(root,"runtime-instances",role,"gateway-locks")});
    const owner=await locks.acquire("worker-journal-owner");const kernel=await acquireWorkerKernelLease(root,owner.token,"shared",{lockCommand:testFlock});
    const origin={generation:owner.token,instanceId:role,dev:kernel.dev,ino:kernel.ino};
    try {await writeFile(path.join(owner.lockPath,"kernel.json"),JSON.stringify(origin),{mode:0o600});
      expect(await currentWorkerExecutionOrigin(root)).toEqual(origin);
      await writeFile(path.join(owner.lockPath,"kernel.json"),JSON.stringify({...origin,generation}),{mode:0o600});
      await expect(currentWorkerExecutionOrigin(root)).rejects.toThrow("not owned");
    }finally{await kernel.close();await owner.release();}
  });
  it("rejects symlink and changed-inode evidence rather than opening a replacement lock",async()=>{
    const root=await fixture();const owner=await acquireWorkerKernelLease(root,generation,"shared",{lockCommand:testFlock});await owner.close();
    await expect(acquireWorkerKernelLease(root,generation,"exclusive",{lockCommand:testFlock,expected:{dev:owner.dev,ino:owner.ino+1}})).rejects.toThrow("inode");
    const file=path.join(root,"kernel-owners",`${generation}.lock`);await rm(file);await writeFile(path.join(root,"target"),"",{mode:0o600});await symlink(path.join(root,"target"),file);
    await expect(acquireWorkerKernelLease(root,generation,"exclusive",{lockCommand:testFlock})).rejects.toThrow();
  });
});
