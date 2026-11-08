import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ProductStore} from './persistence';
let root:string;let store:ProductStore;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-snapshot-test-'));store=new ProductStore(root,'g03-test');await mkdir(path.join(root,'versions/production'),{recursive:true});});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const version=(revision:number,installation='g03-test')=>Buffer.from(JSON.stringify({schemaVersion:1,installationId:installation,value:{revision,content:'Conservar àèíóü\n'.repeat(500)}} ,null,2)+'\n');
const file=(revision:number)=>path.join(root,'versions/production',`${revision}.json`);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
it('compresses future immutable snapshots and reads them after reopening without changing live records',async()=>{
 await store.mutate('production',()=>({revision:0,text:'Original'.repeat(1000)}),()=>{});
 const before=await readFile(path.join(root,'production.json'));
 await store.mutate<{revision:number;text:string},void>('production',()=>{throw Error('missing');},value=>{value.text='Updated';},1);
 const files=await readdir(path.dirname(file(1)));expect(files).toEqual(['1.json.gz']);
 expect(gunzipSync(await readFile(file(1)+'.gz'))).toEqual(before);
 expect(await new ProductStore(root,'g03-test').readVersion('production',1)).toEqual({revision:1,text:'Original'.repeat(1000)});
 expect(await store.read('production')).toEqual({revision:2,text:'Updated'});
});
it('plans without mutation then preserves every original byte/revision and resumes an interrupted duplicate',async()=>{
 const originals=[version(1),version(2),version(3)];for(let i=0;i<originals.length;i++)await writeFile(file(i+1),originals[i]);
 await writeFile(file(2)+'.gz',gzipSync(originals[1]));
 const live=version(99);await writeFile(path.join(root,'production.json'),live);
 const plan=await store.migrateVersions('production');expect(plan).toHaveLength(3);expect(plan.every(item=>!item.applied)).toBe(true);expect(await readFile(file(1))).toEqual(originals[0]);
 const receipts=await store.migrateVersions('production',{apply:true});expect(receipts).toHaveLength(3);
 for(let i=0;i<originals.length;i++){
  expect(hash(gunzipSync(await readFile(file(i+1)+'.gz')))).toBe(hash(originals[i]));
  expect(receipts[i].sha256).toBe(hash(originals[i]));expect((await store.readVersion<{revision:number}>('production',i+1)).revision).toBe(i+1);
  await expect(readFile(file(i+1))).rejects.toMatchObject({code:'ENOENT'});
 }
 expect(await readFile(path.join(root,'production.json'))).toEqual(live);
 expect(await store.migrateVersions('production',{apply:true})).toEqual([]);
});
it('keeps originals intact when a compressed destination conflicts or belongs to another installation',async()=>{
 const original=version(1);await writeFile(file(1),original);await writeFile(file(1)+'.gz',gzipSync(version(2)));
 await expect(store.migrateVersions('production',{apply:true})).rejects.toMatchObject({status:409});expect(await readFile(file(1))).toEqual(original);
 await rm(file(1)+'.gz');await writeFile(file(1),version(1,'foreign'));
 await expect(store.migrateVersions('production',{apply:true})).rejects.toMatchObject({status:403});expect(await readFile(file(1))).toEqual(version(1,'foreign'));
});
it('reads legacy snapshots and rejects unsafe paths and symlinks',async()=>{
 await writeFile(file(1),version(1));expect((await store.readVersion<{revision:number}>('production',1)).revision).toBe(1);
 await expect(store.readVersion('../production',1)).rejects.toMatchObject({status:400});await expect(store.readVersion('production',-1)).rejects.toMatchObject({status:400});
 await symlink(file(1),file(2));await expect(store.migrateVersions('production',{apply:true})).rejects.toMatchObject({status:503});
});
it('serializes migration with writes through the same product key lease',async()=>{
 await store.mutate('production',()=>({revision:0,content:'retain'}),()=>{});
 await writeFile(file(0),version(0));
 const results=await Promise.all([store.migrateVersions('production',{apply:true}),store.mutate<{revision:number;content:string},void>('production',()=>{throw Error('missing')},value=>{value.content='new'},1)]);
 expect(results[0][0].applied).toBe(true);expect((await store.read<{revision:number}>('production'))?.revision).toBe(2);
 expect((await store.readVersion<{revision:number}>('production',0)).revision).toBe(0);expect((await store.readVersion<{content:string}>('production',1)).content).toBe('retain');
});
