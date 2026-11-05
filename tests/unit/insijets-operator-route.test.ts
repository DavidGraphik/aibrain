import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const mocks=vi.hoisted(()=>({session:vi.fn(),admin:vi.fn(),origin:vi.fn(),configuration:vi.fn()}));
vi.mock('@/auth/session',()=>({getSession:mocks.session}));
vi.mock('@/admin/server-service',()=>({isWorkspaceAdmin:mocks.admin}));
vi.mock('@/auth/request-security',()=>({isSameOriginMutation:mocks.origin}));
vi.mock('@/insijets/operator-server',()=>({loadOperatorConfiguration:mocks.configuration}));
import {GET,POST} from '@/app/api/insijets/outreach/route';
let root:string;
const session={provider:'local',expiresAt:new Date(Date.now()+86400000).toISOString(),tenant:{id:'insijets-demo'},user:{id:'verified-owner',email:'operator@example.invalid'}};
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'insijets-next-operator-'));vi.clearAllMocks();mocks.session.mockResolvedValue(session);mocks.admin.mockResolvedValue(true);mocks.origin.mockResolvedValue(true);mocks.configuration.mockResolvedValue({enabled:true,installationId:'insijets-demo',storageRoot:root,approvedResearchOrigins:[],approvedVerificationProviders:[]});});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
const request=(method='GET',body?:unknown,query='')=>new Request('https://brain.example.test/api/insijets/outreach'+query,{method,headers:{'Content-Type':'application/json',Origin:'https://brain.example.test'},...(body?{body:JSON.stringify(body)}:{})});
it('real Next wrapper exposes prepared catalog and enforces durable role/tenant/CSRF before touching configuration or store',async()=>{
 let response=await GET(request());expect(response.status).toBe(200);expect((await response.json()).catalog.emailSent).toBe(false);expect(existsSync(join(root,'insijets-outreach-preparation'))).toBe(false);
 mocks.configuration.mockClear();mocks.session.mockResolvedValue({...session,tenant:{id:'foreign'}});expect((await GET(request())).status).toBe(403);expect(mocks.configuration).not.toHaveBeenCalled();
 mocks.session.mockResolvedValue(session);mocks.admin.mockResolvedValue(false);expect((await GET(request())).status).toBe(403);expect(mocks.configuration).not.toHaveBeenCalled();
 mocks.admin.mockResolvedValue(true);mocks.origin.mockResolvedValue(false);expect((await POST(request('POST',{action:'record-metrics'}))).status).toBe(403);expect(mocks.configuration).not.toHaveBeenCalled();
});
it('real Next wrapper persists supplied aggregate reports and returns null unknowns without granting any external effect',async()=>{
 const now=new Date().toISOString();const response=await POST(request('POST',{action:'record-metrics',id:'fixture-week',counts:{attempted:10,hardBounces:1},periodStart:now,periodEnd:now,sourceKind:'synthetic-fixture',sourceReference:'fixture-source'}));expect(response.status).toBe(200);
 const read=await GET(request('GET',undefined,'?view=metrics'));expect(read.status).toBe(200);expect(read.headers.get('cache-control')).toBe('private, no-store');const report=await read.json();expect(report.items[0].data.hardBounceRate).toBe(.1);expect(report.items[0].data.principalPositiveReplyRate).toBeNull();expect(report.items[0].data.sourceVerified).toBe(false);expect(report.crmWrite).toBe(false);expect(report.emailSent).toBe(false);expect(report.callPlaced).toBe(false);
});
