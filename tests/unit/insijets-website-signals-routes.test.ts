import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHmac,randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const mocked=vi.hoisted(()=>({session:vi.fn(),configuration:vi.fn(),admin:vi.fn()}));
vi.mock('@/admin/server-service',()=>({isWorkspaceAdmin:mocked.admin}));
vi.mock('@/auth/session',()=>({getSession:mocked.session}));
vi.mock('@/insijets/website-signals-server',()=>({loadWebsiteSignalConfiguration:mocked.configuration}));
import {POST} from '@/app/api/insijets/website-signals/route';
import {GET as review} from '@/app/api/insijets/website-signals/review/route';
let root:string;
const config=()=>({enabled:true,activationApproved:true,installationId:'insijets-demo',clientAccountReference:'fixture-insijets',signingKey:'x'.repeat(32),storageRoot:root});
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'insijets-route-'));vi.clearAllMocks();mocked.admin.mockResolvedValue(true);mocked.configuration.mockResolvedValue(config());mocked.session.mockResolvedValue(null);});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
it('real base route rejects unsigned, wrong-key and foreign-tenant requests before storage',async()=>{
 const input={version:1,installationId:'insijets-demo',clientAccountReference:'fixture-insijets',operationId:randomUUID(),action:'record',event:{version:1,requestId:randomUUID(),kind:'enquiry',email:'fixture@example.test',locale:'en',occurredAt:new Date().toISOString(),consent:{requestProcessing:true,aiSignals:true}}};
 const request=(body:typeof input,key?:string)=>{const raw=JSON.stringify(body),at=String(Date.now()),nonce=randomUUID();return new Request('https://brain.example.test/api/insijets/website-signals',{method:'POST',headers:{'Content-Type':'application/json',...(key?{'X-Insijets-Timestamp':at,'X-Insijets-Nonce':nonce,'X-Insijets-Signature':createHmac('sha256',key).update(`${at}.${nonce}.${raw}`).digest('hex')}:{})},body:raw});};
 expect((await POST(request(input))).status).toBe(401);expect((await POST(request(input,'wrong'.repeat(8)))).status).toBe(401);expect((await POST(request({...input,installationId:'foreign'},config().signingKey))).status).toBe(403);expect(existsSync(join(root,'insijets-website-signals'))).toBe(false);
 expect((await POST(request(input,config().signingKey))).status).toBe(201);
 expect((await review()).status).toBe(401);
 mocked.session.mockResolvedValue({tenant:{id:'foreign'},user:{email:'operator@example.invalid'}});expect((await review()).status).toBe(403);
 mocked.session.mockResolvedValue({tenant:{id:'insijets-demo'},user:{email:'other-admin@example.test'}});expect((await review()).status).toBe(403);
 expect(mocked.admin).not.toHaveBeenCalled();
 mocked.session.mockResolvedValue({tenant:{id:'insijets-demo'},user:{email:'operator@example.invalid'}});mocked.admin.mockResolvedValue(false);expect((await review()).status).toBe(403);mocked.admin.mockResolvedValue(true);
 for(const email of ['operator@example.invalid','cms-owner@example.invalid']){mocked.session.mockResolvedValue({tenant:{id:'insijets-demo'},user:{email}});const response=await review();expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');const body=await response.json();expect(body.items).toHaveLength(1);expect(body.items[0].event.email).toBe('fixture@example.test');expect(body.historicalCRMRead).toBe(false);}
});
