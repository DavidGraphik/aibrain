import {test} from 'vitest';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {installMultisourceDatabase} from '../../src/insijets/operator-sourcing-store';
import {operatorSourcingResponse} from '../../src/insijets/operator-sourcing-api';
const session={provider:'local' as const,user:{id:'fixture',name:'Fixture',email:'operator@example.invalid'},tenant:{id:'insijets-demo',name:'InsiJets'},expiresAt:'2099-01-01T00:00:00Z'};
test('scopes access before opening any directory database',async()=>{
 const cfg={installationId:'insijets-demo',origin:'https://insijets.example.invalid',dataRoot:'/does-not-exist',enabled:true};
 const request=new Request(cfg.origin+'/api/insijets/operator-sourcing');
 assert.equal((await operatorSourcingResponse(request,cfg,null)).status,401);
 assert.equal((await operatorSourcingResponse(request,cfg,{...session,tenant:{id:'another-tenant',name:'Other'}})).status,403);
 assert.equal((await operatorSourcingResponse(request,{...cfg,enabled:false},session)).status,503);
 assert.equal((await operatorSourcingResponse(new Request(request.url,{headers:{'sec-fetch-site':'cross-site'}}),cfg,session)).status,403);
});
test('versioned adapter validates provenance, keeps existing data and prepares inert drafts',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'insijets-sourcing-test-')),root=path.join(dir,'data'),file=path.join(dir,'source.sqlite');mkdirSync(root);
 try{
 const db=new DatabaseSync(file);
 db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO metadata VALUES('schema_version','2');
 CREATE TABLE operators(id TEXT PRIMARY KEY,name TEXT,country TEXT,city TEXT,phone TEXT,website TEXT,source TEXT,source_url TEXT,checked_at TEXT,identity_status TEXT);
 CREATE TABLE bases(id TEXT PRIMARY KEY,operator_id TEXT,airport TEXT,country TEXT,city TEXT,source TEXT,source_url TEXT);
 CREATE TABLE aircraft(id TEXT PRIMARY KEY,operator_id TEXT,base_id TEXT,model TEXT,seats INTEGER,category TEXT,registration TEXT,source TEXT,source_url TEXT,checked_at TEXT,availability TEXT);
 CREATE TABLE contacts(id TEXT PRIMARY KEY,operator_id TEXT,base_id TEXT,email TEXT,suppressed INTEGER,source TEXT,source_url TEXT);`);
 const src='Air Charter Guide',url='https://www.aircharterguide.com/operator_info/fixture/1/all/1',at='2026-10-14T00:00:00Z';
 db.prepare('INSERT INTO operators VALUES(?,?,?,?,?,?,?,?,?,?)').run('acg:operator:1','Fixture operator','France','Paris','','',src,url,at,'Test fixture');
 db.prepare('INSERT INTO bases VALUES(?,?,?,?,?,?,?)').run('acg:base:1','acg:operator:1','LFPB','France','Paris',src,url);
 db.prepare('INSERT INTO aircraft VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('acg:aircraft:1','acg:operator:1','acg:base:1','Fixture jet',7,'Light Jet','',src,url,at,'Unknown');
 db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?)').run('acg:contact:1','acg:operator:1','acg:base:1','ops@example.invalid',0,src,url);db.close();
 const hash=()=>createHash('sha256').update(readFileSync(file)).digest('hex');
 const input={sourceFile:file,expectedSha256:hash(),dataRoot:root,installationId:'insijets-demo',confirmation:'INSTALL INSIJETS MULTISOURCE V2'};
 assert.throws(()=>installMultisourceDatabase({...input,expectedSha256:'0'.repeat(64)}),/digest/);
 assert.equal(installMultisourceDatabase(input).repeated,false);assert.equal(installMultisourceDatabase(input).repeated,true);
 const cfg={installationId:'insijets-demo',origin:'https://insijets.example.invalid',dataRoot:root,enabled:true};
 const result=await operatorSourcingResponse(new Request(cfg.origin+'/api/insijets/operator-sourcing?airport=LFPB&minSeats=6'),cfg,session);assert.equal(result.status,200);assert.equal((await result.json()).result.total,1);
 const body={originAirport:'LFPB',destinationAirport:'LSGG',passengers:6};
 const request=new Request(cfg.origin+'/api/insijets/operator-sourcing',{method:'POST',headers:{origin:cfg.origin,'content-type':'application/json'},body:JSON.stringify(body)});
 const plan=await(await operatorSourcingResponse(request,cfg,session)).json();assert.equal(plan.preparation.drafts.length,1);assert.equal(plan.preparation.sendEnabled,false);assert.equal(plan.preparation.drafts[0].approval,null);
 const changed=new DatabaseSync(file);changed.prepare("UPDATE operators SET source_url='https://untrusted.invalid/operator'").run();changed.close();
 assert.throws(()=>installMultisourceDatabase({...input,expectedSha256:hash()}),/provenance/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
