import {it,expect} from 'vitest';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {runOutreachSyntheticAcceptance} from '../../src/insijets/outreach-synthetic-acceptance';
import type {OperatorActor} from '../../src/insijets/operator-runtime';
const actor:OperatorActor={actorId:'synthetic-owner',installationId:'insijets-demo',email:'operator@example.invalid',provider:'local',canManageWorkspace:true};
it('runs actual private persistence and canonical workflow for ten permitted synthetic profiles, then reopens without provider effects',async()=>{
 const dir=mkdtempSync(path.join(realpathSync(tmpdir()),'outreach-synthetic-acceptance-'));
 try{const configuration={enabled:true,installationId:'insijets-demo',storageRoot:dir,approvedResearchOrigins:[],approvedVerificationProviders:[]};
 const first=await runOutreachSyntheticAcceptance(configuration,actor,{runId:'fixture'});
 expect(first).toMatchObject({profilesTested:10,preparedContacts:10,preparedSequenceSteps:30,inertCRMPayloads:10,held:0,privatePersistedReadback:true,idempotentReplay:true,providerCallsDuringReplay:0,providerCallsThisInvocation:30,realProviderCalls:0,realCreditsSpent:0,productionBindingsConfigured:false,crmWrite:false,emailSent:false,campaignActivated:false});expect(JSON.stringify(first)).not.toContain('@example.invalid');expect(JSON.stringify(first)).not.toContain(dir);
 const second=await runOutreachSyntheticAcceptance(configuration,actor,{runId:'fixture'});expect(second.previouslyPrepared).toBe(true);expect(second.providerCallsThisInvocation).toBe(0);expect(second.reviewResultDigest).toBe(first.reviewResultDigest);expect(second.reviewExpiresAt).toBe(first.reviewExpiresAt);
 const another=await runOutreachSyntheticAcceptance(configuration,actor,{runId:'another-fixture'});expect(another.preparedContacts).toBe(10);
 await expect(runOutreachSyntheticAcceptance(configuration,{...actor,canManageWorkspace:false},{runId:'denied'})).rejects.toThrow();await expect(runOutreachSyntheticAcceptance(configuration,actor,{runId:'../arbitrary'})).rejects.toThrow('INPUT_DENIED');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
