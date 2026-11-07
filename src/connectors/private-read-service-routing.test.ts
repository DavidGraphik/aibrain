import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {InstallationConfig} from '@/config/installation-schema';
import type {AuthSession} from '@/auth/types';
vi.mock('server-only',()=>({}));
const m=vi.hoisted(()=>({bridge:vi.fn(),request:vi.fn(),catalog:vi.fn(),user:vi.fn()}));
const user='11111111-1111-4111-8111-111111111111',email='employee@example.test';
const config={installationId:'g03-production',connectors:{mail:{enabled:true,provider:'nominalia'}},paths:{usersRoot:'/unused/users',dataRoot:'/unused'}} as InstallationConfig;
vi.mock('./private-read-bridge',async original=>({...await original<typeof import('./private-read-bridge')>(),privateReadBridge:m.bridge}));
vi.mock('@/config/installation',()=>({loadInstallationConfig:async()=>config}));
vi.mock('@/auth/local-user-store',()=>({FileLocalUserStore:class{read=m.user;}}));
vi.mock('@/admin/policy-service',()=>({workspacePolicyForIdentity:async()=>({roleId:'employee',policy:{capabilities:{consult:true,execute:true}}})}));
vi.mock('@/catalog/access-service',()=>({catalogRuntimeEnforcer:m.catalog}));
import {PrivateReadBridgeError} from './private-read-bridge';
import {executeMailOperation,mailAccessForIdentity,mailCapabilityForSession,normalizeMailOperationArgs} from './mail-server-service';
import {g03SageReadForIdentity,g03SageReadBatchForIdentity,g03SageHealth,g03SageReadCapabilities,g03SageAccess,g03SageReceivingCapabilities} from './g03-sage-service';
import {handleMailDynamicToolCall} from '@/runtime/mail-dynamic-tools';
import {handleG03SageTool} from '@/runtime/g03-sage-dynamic-tools';
const session={provider:'local',tenant:{id:'g03-production',name:'G03'},user:{id:user,email,name:'Employee'},expiresAt:new Date(Date.now()+600000).toISOString()} as AuthSession;
beforeEach(()=>{vi.clearAllMocks();m.user.mockResolvedValue({userId:user,email,enabled:true});m.catalog.mockResolvedValue({allowsConnector:()=>true});m.bridge.mockResolvedValue({request:m.request});m.request.mockResolvedValue({nextCursor:'exact',coverage:{complete:false}});});
describe('existing UI tool routing to source-native connectors',()=>{
 it('uses actual source grant/version without local crypto or credentials',async()=>{m.request.mockResolvedValue({mail:{accessVerified:true,operations:['list','search','read'],connectionVersion:7}});expect((await mailAccessForIdentity(config,user)).binding).toEqual({transport:'source-native',version:7});expect(await mailCapabilityForSession(session)).toMatchObject({connectionVersion:7,effectiveOperations:['list','search','read'],disconnectUrl:null});});
 it('preserves native folders parity for a remote-authorized employee',async()=>{expect(normalizeMailOperationArgs('folders',{})).toEqual({});m.request.mockResolvedValue({folders:[{name:'INBOX'}]});expect(await executeMailOperation({config,userId:user},'folders',{})).toEqual({folders:[{name:'INBOX'}]});expect(m.request).toHaveBeenCalledWith('mail',{operation:'folders',input:{}});});
 it('routes existing mail search with native limit/cursor',async()=>{const args={query:{text:'QA'},limit:100,cursor:'source'};const result=await handleMailDynamicToolCall({namespace:'aibrain_mail',tool:'search',arguments:args,threadId:'t',turnId:'u'} as never,{config,installationId:'g03-production',userId:user,runtimeThreadId:'t',runtimeTurnId:'u',mailSelected:true});expect(result.success).toBe(true);expect(m.request).toHaveBeenCalledWith('mail',{operation:'search',input:args});});
 it('routes existing Sage discover and native batch',async()=>{const result=await handleG03SageTool({namespace:'aibrain_g03_sage',tool:'discover',arguments:{},threadId:'t',turnId:'u'} as never,{installationId:'g03-production',userId:user,session,runtimeThreadId:'t',runtimeTurnId:'u',selected:true,executeAllowed:true});expect(result.success).toBe(true);expect(m.request).toHaveBeenCalledWith('sage',{operation:'discover',input:{}},expect.any(AbortSignal));await g03SageReadBatchForIdentity('g03-production',user,{query:'Products',take:50,skip:50});expect(m.request).toHaveBeenLastCalledWith('sage',{operation:'read_batch',input:{query:'Products',take:50,skip:50}},undefined);});
 it('rejects locally revoked identity after remote read',async()=>{m.user.mockResolvedValueOnce({userId:user,email,enabled:true}).mockResolvedValueOnce({userId:user,email,enabled:false});await expect(g03SageReadForIdentity('g03-production',user,'read',{query:'Products'})).rejects.toMatchObject({code:'SAGE_ACCESS_DENIED'});});
 it('preserves source 400/403/503 in MailConnectorError and SageError',async()=>{
  for(const status of [400,403,503]) {
   m.request.mockRejectedValue(new PrivateReadBridgeError('MAIL_ARGUMENTS_INVALID',status));
   await expect(executeMailOperation({config,userId:user},'list',{})).rejects.toMatchObject({code:'MAIL_ARGUMENTS_INVALID',status});
   m.request.mockRejectedValue(new PrivateReadBridgeError('SAGE_ARGUMENTS_INVALID',status));
   await expect(g03SageReadForIdentity('g03-production',user,'read',{query:'Products'})).rejects.toMatchObject({code:'SAGE_ARGUMENTS_INVALID',status});
  }
 });
 it('uses source metadata for admission without local mail config or a Sage credential factory',async()=>{
  const saved=config.connectors;config.connectors={};
  try {
   const source={mail:{accessVerified:true,operations:['folders','list','read'],connectionVersion:9},sage:{accessVerified:true,operations:['discover','read'],queries:[{name:'Products',description:'Genuine source metadata',parameters:[]}]}};
   m.request.mockResolvedValue(source);
   expect(await mailCapabilityForSession(session)).toMatchObject({status:'connected',connectionVersion:9,effectiveOperations:['folders','list','read']});
   expect((await mailAccessForIdentity(config,user)).binding).toEqual({transport:'source-native',version:9});
   expect(await g03SageReadCapabilities('g03-production',user)).toEqual({transport:'source-native',readOperations:['discover','read'],queries:source.sage.queries,providerReachability:'not-tested',writesAllowed:false});
   expect(await g03SageHealth('g03-production',user)).toMatchObject({accessVerified:true,status:'connected',readOperations:['discover','read'],queries:source.sage.queries});
   await expect(g03SageAccess('g03-production',user)).rejects.toMatchObject({code:'SAGE_READ_ONLY',status:403});
   expect(await g03SageReceivingCapabilities('g03-production',user)).toEqual({providerWrites:false,productionWrites:false});
   await expect(executeMailOperation({config,userId:user},'draft',{})).rejects.toMatchObject({code:'MAIL_ACCESS_DENIED'});
  } finally {config.connectors=saved;}
 });
 it('does not fabricate source query metadata or swallow malformed/denied source capability',async()=>{
  m.request.mockResolvedValue({sage:{accessVerified:true,operations:['discover']}});
  expect(await g03SageReadCapabilities('g03-production',user)).toMatchObject({queries:null,readOperations:['discover']});
  m.request.mockResolvedValue({sage:{accessVerified:false,operations:[]}});
  await expect(g03SageReadCapabilities('g03-production',user)).rejects.toMatchObject({code:'SAGE_ACCESS_DENIED',status:403});
  m.request.mockResolvedValue({sage:{accessVerified:true,operations:['execute']}});
  await expect(g03SageReadCapabilities('g03-production',user)).rejects.toMatchObject({code:'PRIVATE_READ_RESPONSE_INVALID',status:502});
 });
 it('denies writes and keeps Sage independent of missing source mail grant',async()=>{await expect(executeMailOperation({config,userId:user},'draft',{})).rejects.toMatchObject({code:'MAIL_ACCESS_DENIED'});expect(m.request).not.toHaveBeenCalled();m.request.mockResolvedValue({sage:{accessVerified:true,operations:['discover','read','read_batch']},mail:{accessVerified:false,operations:[]}});expect(await g03SageHealth('g03-production',user)).toMatchObject({accessVerified:true});await expect(mailAccessForIdentity(config,user)).rejects.toThrow();});
});
