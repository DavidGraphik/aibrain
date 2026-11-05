import {expect,it,vi,beforeEach} from 'vitest';
const state=vi.hoisted(()=>({session:{provider:'local',tenant:{id:'g03-production'},user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'quality@example.invalid',name:'Rafa'}},records:new Map<string,unknown>(),origin:true}));
vi.mock('server-only',()=>({}));
vi.mock('./welcome-chat',()=>({createWelcomeChat:vi.fn(async()=>({id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}))}));
vi.mock('@/auth/session',()=>({getSession:async()=>state.session}));
vi.mock('@/auth/request-security',()=>({isSameOriginMutation:async()=>state.origin}));
vi.mock('./access',()=>({productContext:async(s:typeof state.session)=>({actor:s.user.id,store:{read:async(k:string)=>state.records.get(k),mutate:async(k:string,initial:()=>unknown,action:(v:unknown)=>unknown)=>{const v=state.records.get(k)||initial();const out=action(v);state.records.set(k,v);return out}}})}));
import {GET,POST} from '@/app/api/g03/welcome/route';
beforeEach(()=>{state.records.clear();state.origin=true;state.session.user.id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';state.session.user.email='quality@example.invalid'});
it('saves first-use acknowledgement only for the authenticated person',async()=>{
 expect(await (await GET(new Request('https://factory-brain.example/api/g03/welcome'))).json()).toMatchObject({seen:false,department:'Qualitat'});
 expect((await POST(new Request('https://factory-brain.example/api/g03/welcome',{method:'POST',body:JSON.stringify({seen:true})}))).status).toBe(200);
 expect(await (await GET(new Request('https://factory-brain.example/api/g03/welcome'))).json()).toMatchObject({seen:true});
 state.session.user.id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';state.session.user.email='other@example.test';
 expect(await (await GET(new Request('https://factory-brain.example/api/g03/welcome'))).json()).toMatchObject({seen:false,department:'el teu departament'});
});
it('rejects cross-origin acknowledgement and user-controlled target identities',async()=>{
 state.origin=false;
 expect((await POST(new Request('https://factory-brain.example/api/g03/welcome',{method:'POST',body:'{"seen":true}'}))).status).toBe(403);
 state.origin=true;
 expect((await POST(new Request('https://factory-brain.example/api/g03/welcome',{method:'POST',body:'{"seen":true,"actor":"another-user"}'}))).status).toBe(400);
 expect(state.records.size).toBe(0);
});

it('creates the private welcome chat once, including previously acknowledged panels',async()=>{
 const req=(body:unknown)=>new Request('https://factory-brain.example/api/g03/welcome',{method:'POST',body:JSON.stringify(body)});
 await POST(req({seen:true}));
 expect(await (await POST(req({openChat:true}))).json()).toMatchObject({created:true,threadId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});
 expect(await (await POST(req({openChat:true}))).json()).toMatchObject({created:false});
 state.origin=false;
 expect((await POST(req({openChat:true}))).status).toBe(403);
 state.origin=true;
 expect((await POST(req({openChat:true,actor:'another-user'}))).status).toBe(400);
});
