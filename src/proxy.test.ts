import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('server-only',()=>({}));
const state=vi.hoisted(()=>({record:null as null|Record<string,unknown>,active:true,read:vi.fn()}));
vi.mock('@/auth/auth-context',()=>({createLocalSessionContext:async()=>({installation:{installationId:'g03-qa'},sessions:{
  read:state.read,isActiveBinding:async()=>state.active,
}})}));
import { proxy } from './proxy';
const id='30000000-0000-4000-8000-000000000001',other='30000000-0000-4000-8000-000000000002';
const cookie='QA_PREVIEW_'+'a'.repeat(32);
const req=(path:string,method='POST',value=cookie)=>new NextRequest(`https://g03.example${path}`,{method,headers:{cookie:`__Host-aibrain-session=${value}`}});
beforeEach(()=>{state.active=true;state.record={userId:other,sessionIdHash:'a'.repeat(64),support:{preview:{threadId:other,appId:id}}};state.read.mockReset().mockImplementation(async()=>state.record?{record:state.record}:null);});
describe('synthetic support session request boundary',()=>{
  it('allows only the bound chat, preview endpoint and logout to mutate',async()=>{
    for(const path of ['/api/chat',`/api/g03/production/preview?id=${id}`,'/api/auth/logout']) expect((await proxy(req(path))).status).toBe(200);
    for(const path of ['/api/g03/production',`/api/g03/production/preview?id=${other}`,'/api/mail/send','/api/g03/sage','/api/files/example.png','/untrusted-action'])
      expect((await proxy(req(path))).status).toBe(403);
  });
  it('fails closed for an expired, revoked, missing or ordinary session with the preview marker',async()=>{
    state.record=null;expect((await proxy(req('/api/chat'))).status).toBe(403);
    state.record={userId:other,sessionIdHash:'a'.repeat(64),support:{}};expect((await proxy(req('/api/chat'))).status).toBe(403);
    state.record={userId:other,sessionIdHash:'a'.repeat(64),support:{preview:{threadId:other,appId:id}}};state.active=false;
    expect((await proxy(req('/api/chat'))).status).toBe(403);
  });
  it('blocks GET callback and proxy routes that may modify external state',async()=>{
    for(const path of ['/api/connectors/gmail/oauth/callback','/api/connectors/composio/gmail/callback',
      '/api/insijets/cms/api/action','/api/horaria-events/webhook','/api/g03/production',`/api/threads/${id}`])
      expect((await proxy(req(path,'GET'))).status).toBe(403);
    for(const path of ['/api/auth/session',`/api/threads/${other}`,`/api/g03/production/preview?id=${id}`])
      expect((await proxy(req(path,'GET'))).status).toBe(200);
  });
  it('leaves ordinary sessions on the existing fast path',async()=>{
    expect((await proxy(req('/api/g03/production','POST','ordinary-session'))).status).toBe(200);
    expect(state.read).not.toHaveBeenCalled();
  });
});
