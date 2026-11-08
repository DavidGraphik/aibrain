import {describe,it,expect} from 'vitest';
import {assertResearchProviderPolicy,prepareResearchPlan,type ResearchPlanInput} from '../../src/insijets/outreach-research-plan';

const input:ResearchPlanInput={targetQualifiedContacts:1000,audience:'new',tier:'standard'};
describe('AI Brain research preparation',()=>{
 it('allocates the exact qualified-contact target using the reconciled working mix with retired and pending lanes, independent of sending capacity',()=>{
  const plan=prepareResearchPlan(input);
  expect(plan.target).toMatchObject({count:1000,unit:'qualified-verified-contacts'});
  expect(plan.icp.allocations).toHaveLength(15);
  expect(plan.icp.allocations.reduce((sum,item)=>sum+item.contacts,0)).toBe(1000);
  expect(plan.icp.allocations.find(item=>item.id==='business-owners')?.contacts).toBe(180);
  expect(plan.icp.allocations.filter(item=>['art','yachting','politicians','wealth-managers','pet-relocation'].includes(item.id)).every(item=>item.contacts===0)).toBe(true);
  expect(plan.icp.allocations.find(item=>item.id==='family-offices')?.contacts).toBe(130);
  expect(plan.geography).toMatchObject({europePercent:100,middleEastPercent:0});
  expect(prepareResearchPlan({...input,targetQualifiedContacts:1}).icp.allocations.find(item=>item.contacts===1)?.id).toBe('pa-ea');
  expect(prepareResearchPlan(input)).toEqual(plan);
 });
 it('enforces Clay Tier 1 only before any plan is prepared and allows an optional Tier 1 route',()=>{
  expect(()=>prepareResearchPlan({...input,providers:['clay']})).toThrow('CLAY_REQUIRES_TIER1');
  expect(()=>assertResearchProviderPolicy('standard','clay')).toThrow('CLAY_REQUIRES_TIER1');
  const tier1=prepareResearchPlan({...input,tier:'tier1',providers:['apollo','clay','prospeo']});
  expect(tier1.phases.some(phase=>phase.id==='tier1-enrichment')).toBe(true);
  expect(tier1.sourcePolicy.directSources).toEqual(['apollo','prospeo']);
  expect(prepareResearchPlan({...input,tier:'tier1'}).phases.some(phase=>phase.id==='tier1-enrichment')).toBe(false);
  expect(prepareResearchPlan({...input,providers:['prospeo','apollo']}).id).toBe(prepareResearchPlan(input).id);
 });
 it('keeps historical work separate and never turns a supplied campaign or budget into live readiness',()=>{
  const plan=prepareResearchPlan({...input,audience:'historical',campaignId:'campaign_42',budgetCredits:2000});
  expect(plan.icp.allocations).toEqual([]);
  expect(plan.icp.selection).toBe('client-controlled-historical-cohort');
  expect(plan.requiredBindings.map(binding=>binding.id)).toContain('historical-cohort');
  expect(plan.phases[0].title).toBe('Receive the client-controlled historical cohort');
  expect(()=>prepareResearchPlan({...input,audience:'historical',personaId:'pa-ea'})).toThrow('HISTORICAL_COHORT_MUST_REMAIN_SEPARATE');
  expect(plan).toMatchObject({status:'prepared',executionStatus:'blocked',liveReady:false,providerDispatch:false,paidLookupsApproved:false,crmHistoricalRead:false,crmWrite:false,leadExtraction:false,campaignEnrollment:false,campaignActivated:false,emailSent:false,schedulerInstalled:false});
  expect(plan.budget).toMatchObject({requestedCreditCeiling:2000,approvedCreditCeiling:null,estimatedCredits:null,estimatedPrice:null,unitsVerified:false});
  expect(plan.requiredBindings.every(binding=>binding.status==='pending')).toBe(true);
  expect(plan.phases.every(phase=>phase.executionStatus==='blocked')).toBe(true);
 });
 it('orders qualification before contact lookup, independent verification before final scoring and correct campaign placement',()=>{
  const plan=prepareResearchPlan({...input,personaId:'executives',targetQualifiedContacts:137});
  expect(plan.icp.allocations).toEqual([{id:'executives',percent:100,contacts:137}]);
  expect(plan.phases.map(phase=>phase.id)).toEqual(['account-discovery','provisional-qualification','people-lookup','independent-verification','final-qualification','campaign-enrollment','outcome-report']);
  expect(plan.ownership).toMatchObject({durableCustomerRecords:'client-crm',selectedContacts:'mapped-instantly-campaign',workingMaterial:'temporary-private-brain-documents',separateProspectDatabase:false});
  expect(plan.outcomePolicy).toMatchObject({reportShortfalls:true,padQuota:false,changeIcpSilently:false,raiseBudgetSilently:false});
  expect(prepareResearchPlan({...input,personaId:'art'}).requiredBindings.map(binding=>binding.id)).toContain('parked-persona');
 });
 it.each([
  {targetQualifiedContacts:0},{targetQualifiedContacts:1.5},{targetQualifiedContacts:10001},{targetQualifiedContacts:NaN},
  {budgetCredits:-1},{budgetCredits:Infinity},{budgetCredits:100001},{personaId:'unknown'},
  {campaignId:'person@example.com'},{campaignId:'https://example.com/campaign'},
  {providers:['apollo','apollo']},{providers:['unknown']},{audience:'other'},{tier:'other'},
  {contacts:[{email:'person@example.com'}]},{approved:true},
 ])('rejects unbounded, personal-data and permission-shaped input: %j',patch=>{
  expect(()=>prepareResearchPlan({...input,...patch} as ResearchPlanInput)).toThrow('BOUNDED_RESEARCH_PLAN_INPUT_REQUIRED');
 });
});
