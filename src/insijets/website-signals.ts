import { deploymentIdentity } from "@/deployment/identities";
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,lstatSync,existsSync} from 'node:fs';
import path from 'node:path';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(status:number):never{throw Object.assign(Error('Website signal denied'),{status});}
export type SignalConfig={enabled:boolean;activationApproved:boolean;installationId:string;clientAccountReference:string;signingKey:string;storageRoot:string;retentionDays?:number};
export function signalConfigurationValid(c:SignalConfig){return c.enabled===true&&c.activationApproved===true&&c.installationId==='insijets-demo'&&/^[-a-zA-Z0-9_:]{1,100}$/.test(c.clientAccountReference)&&typeof c.signingKey==='string'&&c.signingKey.length>=32&&typeof c.storageRoot==='string'&&path.isAbsolute(c.storageRoot)&&Number.isInteger(c.retentionDays??30)&&(c.retentionDays??30)>=1&&(c.retentionDays??30)<=90;}
function validEvent(e:unknown,now:number){
 if(!object(e)||Object.keys(e).some(k=>!['version','requestId','kind','email','locale','occurredAt','consent','memberId'].includes(k))||e.version!==1||!uuid.test(String(e.requestId||''))||!['enquiry','booking','newsletter'].includes(String(e.kind))||typeof e.email!=='string'||e.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.email)||!['en','it','es','fr','de','ar'].includes(String(e.locale))||typeof e.occurredAt!=='string'||!Number.isFinite(Date.parse(e.occurredAt))||new Date(e.occurredAt).toISOString()!==e.occurredAt||!object(e.consent)||e.consent.requestProcessing!==true||e.consent.aiSignals!==true||Object.keys(e.consent).length!==2||e.memberId!==undefined&&!uuid.test(String(e.memberId)))fail(400);
 const age=now-Date.parse(String(e.occurredAt));if(age < -300000||age>7*86400000)fail(400);
 return e as Record<string,unknown>;
}
function open(c:SignalConfig){
 // Validate tenant before any directory creation or durable reads.
 if(!signalConfigurationValid(c))fail(404);
 const directory=path.join(c.storageRoot,'insijets-website-signals');if(existsSync(directory)&&(!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink()))fail(503);mkdirSync(directory,{recursive:true,mode:0o700});
 const file=path.join(directory,'signals.sqlite');if(existsSync(file)&&(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink()))fail(503);
 const existed=existsSync(file),db=new DatabaseSync(file);try{if(existed){const identities=db.prepare('SELECT * FROM identity LIMIT 2').all(),bound=identities[0];if(identities.length!==1||!bound||bound.installation!==c.installationId||bound.account!==c.clientAccountReference)fail(503);}}catch(error){db.close();throw error;}chmodSync(directory,0o700);chmodSync(file,0o600);db.exec(`PRAGMA busy_timeout=5000;PRAGMA secure_delete=ON;CREATE TABLE IF NOT EXISTS identity(installation TEXT PRIMARY KEY,account TEXT NOT NULL);CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,request_id TEXT NOT NULL,receipt_id TEXT NOT NULL,status TEXT NOT NULL,event TEXT,created_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY,at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS withdrawn(request_id TEXT PRIMARY KEY,at INTEGER NOT NULL);`);
 const identity=db.prepare('SELECT * FROM identity').get();if(identity&&(identity.installation!==c.installationId||identity.account!==c.clientAccountReference)){db.close();fail(503);}if(!identity)db.prepare('INSERT INTO identity VALUES(?,?)').run(c.installationId,c.clientAccountReference);return db;
}
export async function handleWebsiteSignal(request:Request,c:SignalConfig,now=Date.now()){
 const respond=(status:number,data:unknown)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
 if(!signalConfigurationValid(c))return respond(404,{error:'NOT_CONFIGURED'});
 if(request.method==='GET'){try{const healthDB=open(c);healthDB.prepare("UPDATE operations SET event=NULL,status='expired' WHERE event IS NOT NULL AND created_at<?").run(now-(c.retentionDays??30)*86400000);healthDB.prepare('SELECT count(*) AS n FROM operations').get();healthDB.close();return respond(200,{version:1,status:'ready',persistence:'sqlite',installationId:'insijets-demo',receiver:'identified-request-signals',consentRequired:true,anonymousIdentification:false});}catch{return respond(503,{error:'SIGNAL_STORAGE_UNAVAILABLE'});}}
 if(request.method!=='POST')return respond(405,{error:'METHOD_DENIED'});
 let db:DatabaseSync|undefined;
 try{
  if(!request.headers.get('content-type')?.startsWith('application/json'))fail(415);
  const chunks:Uint8Array[]=[];let size=0;const reader=request.body?.getReader();if(!reader)fail(400);while(true){const part=await reader!.read();if(part.done)break;size+=part.value.byteLength;if(size>8192){await reader!.cancel();fail(413);}chunks.push(part.value);}const text=Buffer.concat(chunks).toString('utf8');
  const timestamp=request.headers.get('x-insijets-timestamp')||'',nonce=request.headers.get('x-insijets-nonce')||'',signature=request.headers.get('x-insijets-signature')||'';
  if(!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60000||!uuid.test(nonce)||! /^[a-f0-9]{64}$/.test(signature))fail(401);
  const expected=createHmac('sha256',c.signingKey).update(`${timestamp}.${nonce}.${text}`).digest('hex');if(!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))fail(401);
  const input:unknown=JSON.parse(text);if(!object(input)||input.version!==1||input.installationId!==c.installationId||input.clientAccountReference!==c.clientAccountReference||!uuid.test(String(input.operationId))||!['record','withdraw','receipt'].includes(String(input.action)))fail(403);
  const allowed=input.action==='record'?['version','installationId','clientAccountReference','operationId','action','event']:['version','installationId','clientAccountReference','operationId','action','requestId'];if(Object.keys(input).some(k=>!allowed.includes(k)))fail(400);
  const event=input.action==='record'?validEvent(input.event,now):undefined,requestId=String(event?.requestId??input.requestId);if(!uuid.test(requestId))fail(400);
  db=open(c);db.exec('BEGIN IMMEDIATE');
  db.prepare('DELETE FROM nonces WHERE at<?').run(now-120000);if(db.prepare('SELECT nonce FROM nonces WHERE nonce=?').get(nonce))fail(409);if(Number(db.prepare('SELECT count(*) AS n FROM nonces').get()?.n)>5000)fail(429);db.prepare('INSERT INTO nonces VALUES(?,?)').run(nonce,now);
  const cutoff=now-(c.retentionDays??30)*86400000;db.prepare("UPDATE operations SET event=NULL,status='expired' WHERE event IS NOT NULL AND created_at<?").run(cutoff);
  const previous=db.prepare('SELECT * FROM operations WHERE id=?').get(String(input.operationId));
  if(input.action==='receipt'){if(!previous||previous.request_id!==requestId)fail(404);db.exec('COMMIT');return respond(200,{operationId:input.operationId,requestId,receiptId:previous.receipt_id,status:previous.status,digest:previous.digest});}
  const digest=hash(JSON.stringify(input));if(previous){if(previous.digest!==digest)fail(409);db.exec('COMMIT');return respond(200,{operationId:input.operationId,requestId,receiptId:previous.receipt_id,status:previous.status,duplicate:true});}
  if(Number(db.prepare('SELECT count(*) AS n FROM operations').get()?.n)>=50000)fail(429);
  let status='recorded';if(input.action==='withdraw'){status='withdrawn';db.prepare('INSERT OR IGNORE INTO withdrawn VALUES(?,?)').run(requestId,now);db.prepare("UPDATE operations SET event=NULL,status='withdrawn' WHERE request_id=?").run(requestId);}else if(db.prepare('SELECT request_id FROM withdrawn WHERE request_id=?').get(requestId))fail(409);
  const receiptId=randomUUID();db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(String(input.operationId),digest,requestId,receiptId,status,event?JSON.stringify(event):null,now);db.exec('COMMIT');return respond(201,{operationId:input.operationId,requestId,receiptId,status});
 }catch(error){if(db)try{db.exec('ROLLBACK');}catch{}return respond(object(error)&&typeof error.status==='number'?error.status:503,{error:'SIGNAL_REJECTED'});}finally{db?.close();}
}
export function readWebsiteSignalsForReview(c:SignalConfig,actor:{installationId:string;email:string},limit=50,now=Date.now()){
 // Owner identity is checked before opening the signal database. This is only
 // newly volunteered website data, never a CRM-history query interface.
 if(actor.installationId!=='insijets-demo'||actor.installationId!==c.installationId||![deploymentIdentity("operator"),deploymentIdentity("cmsOwner")].includes(actor.email.toLowerCase())||!Number.isInteger(limit)||limit<1||limit>100)fail(403);
 const db=open(c);try{db.prepare("UPDATE operations SET event=NULL,status='expired' WHERE event IS NOT NULL AND created_at<?").run(now-(c.retentionDays??30)*86400000);const rows=db.prepare("SELECT id,request_id,receipt_id,event,created_at FROM operations WHERE status='recorded' AND event IS NOT NULL ORDER BY created_at DESC LIMIT ?").all(limit);return{installationId:c.installationId,source:'consented-website-signals',items:rows.map(row=>({operationId:row.id,requestId:row.request_id,receiptId:row.receipt_id,event:JSON.parse(String(row.event)),receivedAt:new Date(Number(row.created_at)).toISOString()})),historicalCRMRead:false};}finally{db.close();}
}
