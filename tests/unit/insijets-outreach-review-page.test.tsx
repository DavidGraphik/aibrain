import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const mocks=vi.hoisted(()=>({session:vi.fn(),admin:vi.fn(),configuration:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/auth/session',()=>({getSession:mocks.session}));vi.mock('@/admin/server-service',()=>({isWorkspaceAdmin:mocks.admin}));vi.mock('@/insijets/operator-server',()=>({loadOperatorConfiguration:mocks.configuration}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');}}));
import OutreachReviewPage from '@/app/outreach/page';
import {OutreachOperatorStore} from '@/insijets/operator-runtime';
import {prepareOutreachBatch} from '@/insijets/outreach-preparation';
let root:string;
const actor={actorId:'verified-local-owner',installationId:'insijets-demo',email:'operator@example.invalid',provider:'local' as const,canManageWorkspace:true};
const session={provider:'local',expiresAt:new Date(Date.now()+86400000).toISOString(),tenant:{id:'insijets-demo'},user:{id:actor.actorId,email:actor.email}};
const configuration=()=>({enabled:true,installationId:'insijets-demo',storageRoot:root,approvedResearchOrigins:['https://example.test'],approvedVerificationProviders:['synthetic-verifier']});
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'insijets-review-page-'));vi.clearAllMocks();mocks.session.mockResolvedValue(session);mocks.admin.mockResolvedValue(true);mocks.configuration.mockResolvedValue(configuration());});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
it('actual product review page denies foreign tenant, role, expired/local-demo and anonymous before configuration or SQLite',async()=>{
 for(const denied of [null,{...session,provider:'demo'},{...session,tenant:{id:'foreign'}},{...session,expiresAt:new Date(0).toISOString()},{...session,user:{id:actor.actorId,email:'other-admin@example.test'}}]){mocks.session.mockResolvedValue(denied);await expect(OutreachReviewPage()).rejects.toThrow('NOT_FOUND');}
 mocks.session.mockResolvedValue(session);mocks.admin.mockResolvedValue(false);await expect(OutreachReviewPage()).rejects.toThrow('NOT_FOUND');expect(mocks.configuration).not.toHaveBeenCalled();expect(existsSync(join(root,'insijets-outreach-preparation'))).toBe(false);
});
it('actual authenticated review page shows stored exact drafts, unknown metrics and holds after store restart without send/call controls',async()=>{
 const now=Date.now();const policy={installationId:'insijets-demo',execution:'synthetic-fixture' as const,sourceApproved:true,allowedCountries:['IT'],allowedPersonas:['tour-manager'],allowedSources:['fixture-source'],maxCredits:1,maxCalls:2,verificationCostCredits:0,suppressedEmailHashes:[],sendingAccountReference:'synthetic-account',allowedResearchOrigins:['https://example.test']};
 const result=await prepareOutreachBatch([{id:'fixture-account',company:'Synthetic company',country:'IT',persona:'tour-manager',sourceUrl:'https://example.test/team',signalDate:new Date(now-86400000).toISOString(),fitReviewed:true}],policy,[{id:'fixture-source',costCredits:0,enrich:async()=>({email:'fixture@example.test',firstName:'Fixture',persona:'tour-manager'})}],async()=>({status:'valid' as const,provider:'synthetic-verifier',checkedAt:new Date(now).toISOString()}),now);
 let store=new OutreachOperatorStore(configuration(),actor);try{store.execute({action:'stage-draft',lead:result.leads[0]});store.execute({action:'queue-prepare',id:'fixture-call',draftId:result.leads[0].id,provider:'acefone'});store.execute({action:'record-reply',id:'fixture-reply',draftId:result.leads[0].id,kind:'positive',sourceReference:'fixture-source'});}finally{store.close();}
 store=new OutreachOperatorStore(configuration(),actor);store.close();
 const html=renderToStaticMarkup(await OutreachReviewPage());expect(html).toContain('InsiJets outreach review');expect(html).toContain('fixture@example.test');expect(html).toContain('A travel contact for your team');expect(html).toContain('Follow-ups held for human review.');expect(html).toContain('No report supplied. Results are unknown.');expect(html).toContain('acefone');expect(html).toContain('held');expect(html).toContain('No email approval.');expect(html).not.toContain('<button');expect(html).not.toContain('onclick');
});
