import { spawnSync } from 'node:child_process';
import { mkdtempSync, chmodSync, rmSync, symlinkSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableNameCursors, CURSOR_MAX_BYTES } from './server-name-cursors';
let roots: string[] = [];
function temp() { const p = mkdtempSync(path.join(os.tmpdir(), 'g03-cursor-')); chmodSync(p, 0o700); roots.push(p); return p; }
const binding = { installation: 'g03-production', userId: 'alice', roots: '["issued"]', userRoots: '["allowed"]' };
afterEach(() => { for (const p of roots) rmSync(p, { recursive: true, force: true }); roots = []; });
describe('durable filename search cursors', () => {
 it('resumes after reopen, binds user and scope, leases and atomically replays', () => {
  const dir = temp(); let now = 1000;
  const first = new DurableNameCursors(dir, () => now, 0);
  const response = first.finish(binding, {queue:['a','b']}, null, next => ({next}));
  const id=response.next!.slice('name-cursor:'.length); first.close();
  const a = new DurableNameCursors(dir, () => now, 0); const b = new DurableNameCursors(dir, () => now, 0);
  expect(b.acquire(id, {...binding,userId:'bob'}).kind).toBe('denied');
  expect(b.acquire(id, {...binding,userRoots:'[]'}).kind).toBe('denied');
  const lease=a.acquire<{queue:string[]},unknown>(id,binding); expect(lease.kind).toBe('acquired'); if (lease.kind!=='acquired') throw Error('missing');
  expect(b.acquire(id,binding).kind).toBe('busy');
  const next=a.finish(binding,{queue:['b']},{id,lease:lease.lease},next => ({next, results:['a']}));
  expect(b.acquire(id,binding)).toEqual({kind:'replay',result:next});
  a.close(); b.close();
  const resumed=new DurableNameCursors(dir, () => now, 0); expect(resumed.acquire(next.next!.slice(12),binding)).toMatchObject({kind:'acquired',state:{queue:['b']}}); resumed.close();
 });
 it('reclaims a dead lease, rejects stale completion and expires', () => {
  const dir=temp(); let now=0; const s=new DurableNameCursors(dir,()=>now,0);
  const first=s.finish(binding,{queue:['x']},null,next=>next!); const id=first.slice(12);
  const a=s.acquire(id,binding); if(a.kind!=='acquired') throw Error('missing');
  now+=120001; const b=s.acquire(id,binding); if(b.kind!=='acquired') throw Error('missing');
  expect(()=>s.finish(binding,null,{id,lease:a.lease},()=>({}))).toThrow('CURSOR_LEASE_LOST');
  s.release(id,b.lease); now=600001; expect(s.acquire(id,binding).kind).toBe('denied'); s.close();
 });
 it('refuses oversized state without discarding the previous cursor', () => {
  const s=new DurableNameCursors(temp(),()=>0,0); const q=s.finish(binding,{queue:['x']},null,next=>next!); const id=q.slice(12); const a=s.acquire(id,binding); if(a.kind!=='acquired') throw Error('missing');
  expect(()=>s.finish(binding,{x:'x'.repeat(CURSOR_MAX_BYTES)}, {id,lease:a.lease},()=>null)).toThrow('CURSOR_STORAGE_QUOTA');
  s.release(id,a.lease); expect(s.acquire(id,binding)).toMatchObject({kind:'acquired',state:{queue:['x']}}); s.close();
 });
 it('rejects symlinked or nonprivate storage before opening a database', () => {
  const dir=temp(); const target=temp(); symlinkSync(target,path.join(dir,'server-name-search')); expect(()=>new DurableNameCursors(dir,()=>0,0)).toThrow('CURSOR_STORAGE_UNSAFE');
  const bad=temp(); chmodSync(bad,0o755); expect(()=>new DurableNameCursors(bad,()=>0,0)).toThrow('CURSOR_STORAGE_UNSAFE');
  const file=temp(); mkdirSync(path.join(file,'server-name-search'),{mode:0o700}); symlinkSync(path.join(target,'missing'),path.join(file,'server-name-search','cursors.sqlite3'));
  expect(()=>new DurableNameCursors(file,()=>0,0)).toThrow('CURSOR_STORAGE_UNSAFE');
 });
 it('refuses low disk before creating the database', () => {
  const dir=temp(); expect(()=>new DurableNameCursors(dir,()=>0,Number.MAX_SAFE_INTEGER)).toThrow('CURSOR_STORAGE_QUOTA');
  expect(existsSync(path.join(dir,'server-name-search','cursors.sqlite3'))).toBe(false);
 });
 it('rolls back next-cursor insertion and preserves the prior state after an interrupted commit', () => {
  const s=new DurableNameCursors(temp(),()=>0,0); const id=s.finish(binding,{queue:['keep']},null,next=>next!).slice(12);
  const a=s.acquire(id,binding); if(a.kind!=='acquired') throw Error('missing');
  expect(()=>s.finish(binding,{queue:['next']},{id,lease:a.lease},()=>{throw Error('simulated interruption')})).toThrow('simulated interruption');
  s.release(id,a.lease); expect(s.acquire(id,binding)).toMatchObject({kind:'acquired',state:{queue:['keep']}}); s.close();
 });
 it('clears expired private metadata when storage is next opened', () => {
  const dir=temp(); let now=0; let s=new DurableNameCursors(dir,()=>now,0);
  const secret='SYNTHETIC-PRIVATE-FILENAME-8471'; s.finish(binding,{queue:[secret]},null,next=>next); s.close();
  const file=path.join(dir,'server-name-search','cursors.sqlite3'); expect(readFileSync(file).includes(Buffer.from(secret))).toBe(true);
  now=600001; s=new DurableNameCursors(dir,()=>now,0); s.close();
  expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false);
 });
 it('recovers a prior cursor after a process is killed during an uncommitted write', () => {
  const dir=temp(); let s=new DurableNameCursors(dir,()=>0,0);
  const id=s.finish(binding,{queue:['preserved']},null,next=>next!).slice(12); s.close();
  const file=path.join(dir,'server-name-search','cursors.sqlite3');
  const program=`const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE; UPDATE cursors SET state='{}'"); process.kill(process.pid,'SIGKILL');`;
  const child=spawnSync(process.execPath,['-e',program,file],{encoding:'utf8'});
  expect(child.signal).toBe('SIGKILL');
  s=new DurableNameCursors(dir,()=>0,0);
  expect(s.acquire(id,binding)).toMatchObject({kind:'acquired',state:{queue:['preserved']}}); s.close();
 });
 it('stops at the per-user quota without evicting another active search', () => {
  const s=new DurableNameCursors(temp(),()=>0,0); const ids=[];
  for(let i=0;i<8;i++) ids.push(s.finish(binding,{queue:[String(i)]},null,next=>next!));
  expect(()=>s.finish(binding,{queue:['ninth']},null,next=>next)).toThrow('CURSOR_STORAGE_QUOTA');
  expect(s.acquire(ids[0].slice(12),binding)).toMatchObject({kind:'acquired',state:{queue:['0']}}); s.close();
 });
});
