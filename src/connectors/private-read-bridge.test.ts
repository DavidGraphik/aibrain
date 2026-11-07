import { describe,it,expect,vi } from 'vitest';
vi.mock('server-only',()=>({}));
import {createPrivateReadBridge,validatePrivateReadConfig,privateMailCapability,type PrivateReadConfig} from './private-read-bridge';
const user='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const cfg=():PrivateReadConfig=>({schemaVersion:1,installationId:'g03-production',enabled:true,readOnly:true,createdAt:Date.now()-1000,expiresAt:Date.now()+60000,bindings:[{userId:user,socketPath:`/run/aibrain-user-access/private-read/${user}/broker.sock`,token:'a'.repeat(48)}]});
const response=(body:unknown,id=user)=>new Response(JSON.stringify({kind:'private-employee-native-response',schemaVersion:1,installationId:'g03-production',userId:id,body}));
describe('source-native private read transport',()=>{
 it('rejects unknown, foreign, expired and duplicate bindings',()=>{
  for(const [c,t,u] of [[cfg(),'g03-production',other],[cfg(),'trinalum-production',user],[{...cfg(),expiresAt:Date.now()-1},'g03-production',user],[{...cfg(),createdAt:1},'g03-production',user]] as const)expect(()=>validatePrivateReadConfig(c,t,u)).toThrow();
  const c=cfg();c.bindings.push(c.bindings[0]);expect(()=>validatePrivateReadConfig(c,'g03-production',user)).toThrow();
 });
 it('preserves native limits, cursor, errors and coverage without clamping',async()=>{
  const data={nextCursor:'exact-source',coverage:{complete:false},pageSize:{requested:100,effective:50}};
  const exchange=vi.fn(async(..._args:Parameters<typeof import('@/runtime/trinalum-broker-transport').unixBrokerFetch>)=>response(data));
  const b=createPrivateReadBridge(cfg(),'g03-production',user,exchange);
  const body={operation:'search',input:{query:{text:'invoice'},limit:100,cursor:'exact-input'}};
  expect(await b.request('mail',body)).toEqual(data);expect(JSON.parse(String(exchange.mock.calls[0][2].body))).toEqual({kind:'mail',body});
 });
 it('rejects foreign source results',async()=>{await expect(createPrivateReadBridge(cfg(),'g03-production',user,async()=>response({},other)).request('capabilities',{})).rejects.toMatchObject({code:'PRIVATE_READ_RESPONSE_INVALID'});});
 it('rechecks binding after source call',async()=>{const recheck=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('revoked'));await expect(createPrivateReadBridge(cfg(),'g03-production',user,async()=>response({}),recheck).request('capabilities',{})).rejects.toThrow('revoked');});
 it('propagates safe source error codes',async()=>{await expect(createPrivateReadBridge(cfg(),'g03-production',user,async()=>response({privateConnectorError:{code:'SAGE_QUERY_DENIED',status:403}})).request('sage',{operation:'read',input:{}})).rejects.toMatchObject({code:'SAGE_QUERY_DENIED'});});
 it('rejects writes and oversized input before sending',async()=>{const exchange=vi.fn();const b=createPrivateReadBridge(cfg(),'g03-production',user,exchange);await expect(b.request('mail',{operation:'draft',input:{}})).rejects.toThrow();await expect(b.request('mail',{operation:'search',input:{cursor:'x'.repeat(70000)}})).rejects.toMatchObject({code:'PRIVATE_READ_REQUEST_TOO_LARGE'});expect(exchange).not.toHaveBeenCalled();});
 it('preserves 400 vs403 vs503 and rejects unknown/forged statuses',async()=>{
  for(const status of [400,403,409,429,503]) {
   const exchange=async()=>new Response(JSON.stringify({error:'unsafe provider text'}),{status});
   await expect(createPrivateReadBridge(cfg(),'g03-production',user,exchange).request('capabilities',{})).rejects.toMatchObject({status});
   await expect(createPrivateReadBridge(cfg(),'g03-production',user,async()=>response({privateConnectorError:{code:'MAIL_ARGUMENTS_INVALID',status}})).request('mail',{operation:'read',input:{}})).rejects.toMatchObject({status,code:'MAIL_ARGUMENTS_INVALID'});
  }
  await expect(createPrivateReadBridge(cfg(),'g03-production',user,async()=>new Response('{}',{status:418})).request('capabilities',{})).rejects.toMatchObject({status:502,code:'PRIVATE_READ_RESPONSE_INVALID'});
  await expect(createPrivateReadBridge(cfg(),'g03-production',user,async()=>response({privateConnectorError:{code:'MAIL_ARGUMENTS_INVALID',status:200}})).request('capabilities',{})).rejects.toMatchObject({status:502});
  await expect(createPrivateReadBridge(cfg(),'g03-production',user,async()=>response({privateConnectorError:{code:'MAIL_ARGUMENTS_INVALID',status:400,secret:'never accepted'}})).request('capabilities',{})).rejects.toMatchObject({status:502});
 });
 it('requires actual source mailbox grant and version',()=>{expect(()=>privateMailCapability({mail:{accessVerified:false,operations:[]}})).toThrow();expect(()=>privateMailCapability({mail:{accessVerified:true,operations:['send'],connectionVersion:2}})).toThrow();expect(privateMailCapability({mail:{accessVerified:true,operations:['read'],connectionVersion:2}}).connectionVersion).toBe(2);});
});
