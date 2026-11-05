import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('server-only',()=>({}));
import { productContextForIdentity } from './access';
import type { InstallationConfig } from '@/config/installation-schema';
let root:string;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-app-access-'));vi.stubEnv('AIBRAIN_G03_PRODUCT_POLICY',path.join(root,'policy.json'));});
afterEach(async()=>{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});});
const policy={installationId:'g03-qa',users:{owner:['apps'],viewer:[]}};
const read=(actor:string)=>productContextForIdentity('g03-qa',actor,{installationId:'g03-qa',paths:{dataRoot:root}} as InstallationConfig);
const save=(data:unknown)=>writeFile(path.join(root,'policy.json'),JSON.stringify(data));
it('rechecks an explicit writer list without expanding production or app-creation grants',async()=>{
 await save({...policy,appRecordWriters:['owner']});
 expect(await read('owner')).toMatchObject({appRecordsWritable:true,grants:['apps']});
 expect(await read('viewer')).toMatchObject({appRecordsWritable:false,grants:[]});
 await save({...policy,appRecordWriters:[]});
 expect((await read('owner')).appRecordsWritable).toBe(false);
 await expect(read('missing')).rejects.toMatchObject({status:403});
});
it('preserves the previous permission contract until an explicit writer list is configured',async()=>{
 await save(policy);
 expect((await read('viewer')).appRecordsWritable).toBe(true);
});
it.each([null,'owner',['missing'],['owner','owner'],[1]])('rejects an invalid writer list: %j',async(writers)=>{
 await save({...policy,appRecordWriters:writers});
 await expect(read('owner')).rejects.toMatchObject({status:503});
});

it('grants and revokes production design explicitly without changing other roles',async()=>{
 await save({...policy,appDesigners:['owner']});expect((await read('owner')).appDesigner).toBe(true);expect((await read('viewer')).appDesigner).toBe(false);expect((await read('viewer')).grants).toEqual([]);
 await save({...policy,appDesigners:[]});expect((await read('owner')).appDesigner).toBe(false);
});
it.each([null,'owner',['missing'],['owner','owner'],[1]])('rejects an invalid designer list: %j',async(appDesigners)=>{
 await save({...policy,appDesigners});await expect(read('owner')).rejects.toMatchObject({status:503});
});
