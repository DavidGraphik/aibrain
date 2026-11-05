// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {OutreachFinalContentPanel} from '@/components/outreach-final-content-panel';
import {OutreachWorkspacePanel} from '@/components/outreach-workspace-panel';
import {OUTREACH_FINAL_CONTENT as content,FINAL_REVIEW_CAMPAIGNS} from '@/insijets/outreach-final-content';
import type {CampaignDraft} from '@/insijets/outreach-campaigns';
const drafts=()=>FINAL_REVIEW_CAMPAIGNS.map(c=>({...structuredClone(c),id:'final-editorial:'+c.notes!.find(n=>n.startsWith('Source sequence: '))!.slice(17)}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('renders each of the 15 profile records and 75 evidence checks, with parked state and no provider calls',()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 render(<OutreachFinalContentPanel onAsk={vi.fn()} onSaved={vi.fn()}/>);
 expect(screen.getByText('15 ICP profiles · 75 signal checks · 18 sequences · 54 message bodies')).toBeInTheDocument();
 expect(screen.getByText(/proposed starting criteria derived from the annotated ICP material/)).toHaveTextContent('No criteria change automatically; the canonical source stays immutable.');
 const profile=screen.getByRole('region',{name:'Final ICP profiles'});
 for(const p of content.personas){
  fireEvent.change(screen.getByLabelText('Review ICP profile'),{target:{value:p.id}});
  expect(within(profile).getByText(p.fitAndDecisionRole)).toBeInTheDocument();
  for(const signal of p.signals){expect(within(profile).getByText(signal.requiredEvidence)).toBeInTheDocument();expect(within(profile).getAllByText(signal.freshnessRule).length).toBeGreaterThan(0);}
  if(!p.monthOneEnabled)expect(within(profile).getByText(p.name+' · 0% · parked for month one')).toBeInTheDocument();
 }
 expect(screen.getByText('Final score / 100 = mobile + PA/EA + news + checked need + route friction + FBO')).toBeInTheDocument();
 expect(fetch).not.toHaveBeenCalled();
});
it('renders all 54 exact canonical message bodies with historical eligibility and minimum cadence',()=>{
 render(<OutreachFinalContentPanel onAsk={vi.fn()} onSaved={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Full reference library · 54 messages'}));
 const library=screen.getByRole('region',{name:'Final message sequences'});
 const sequences=[...content.historicalSequences.map(s=>({id:s.id,steps:s.steps})),...content.personas.filter(p=>p.id!=='wealth_managers').map(p=>({id:p.id,steps:p.sequence.steps}))];
 for(const sequence of sequences){
  fireEvent.change(screen.getByLabelText('Review final sequence'),{target:{value:sequence.id}});
  for(const step of sequence.steps){expect([...library.querySelectorAll('pre')].some(p=>p.textContent===step.body)).toBe(true);expect(within(library).getAllByText(step.subject).length).toBeGreaterThan(0);}
 }
 fireEvent.change(screen.getByLabelText('Review final sequence'),{target:{value:'H2_EN'}});
 expect(within(library).getByText(content.historicalSequences[1].eligibilityRequirement)).toBeInTheDocument();
 expect(within(library).getByText(content.messageUseRules.cadence)).toBeInTheDocument();
});
it('saves a private final override, reads it back on rerender and resets with version checks without sending',async()=>{
 let campaigns=drafts();const onSaved=vi.fn();
 const fetch=vi.fn().mockImplementation(async(_url:string,options:{body:string})=>{
  const {action,input}=JSON.parse(options.body);const existing=campaigns.find(c=>c.id===input.id)!;
  const updated:CampaignDraft={...existing,version:existing.version+1,steps:action==='reset-final-campaign'?drafts().find(c=>c.id===input.id)!.steps:existing.steps.map((step,i)=>({...step,subject:input.subjects[i],body:input.bodies[i]}))};
  campaigns=campaigns.map(c=>c.id===updated.id?updated:c);return{ok:true,status:200,json:async()=>({result:{campaign:updated},externalDispatch:false,emailSent:false})};
 });vi.stubGlobal('fetch',fetch);
 const view=render(<OutreachFinalContentPanel campaigns={campaigns} onAsk={vi.fn()} onSaved={onSaved}/>);
 fireEvent.click(screen.getByRole('button',{name:'Full reference library · 54 messages'}));
 fireEvent.change(screen.getByLabelText('Body 2'),{target:{value:'Private final follow-up draft for review only.'}});
 expect(screen.getByLabelText('Review final sequence')).toBeDisabled();
 expect(screen.getByRole('button',{name:'Full reference library · 54 messages'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Subject 2'),{target:{value:'Revised private subject'}});
 fireEvent.click(screen.getByRole('button',{name:'Save private review draft'}));
 await waitFor(()=>expect(onSaved).toHaveBeenCalledTimes(1));
 const input=JSON.parse(fetch.mock.calls[0][1].body);expect(input).toMatchObject({action:'save-final-campaign',input:{id:'final-editorial:H1_EN',version:1,subjects:expect.arrayContaining(['Revised private subject']),bodies:expect.arrayContaining(['Private final follow-up draft for review only.'])}});
 expect(fetch).toHaveBeenCalledWith('/api/insijets/outreach/system',expect.objectContaining({method:'POST',credentials:'same-origin'}));
 view.rerender(<OutreachFinalContentPanel campaigns={campaigns} onAsk={vi.fn()} onSaved={onSaved}/>);
 expect(screen.getByLabelText('Body 2')).toHaveValue('Private final follow-up draft for review only.');
 expect(screen.getByText(/version 2 · private override/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Reset saved draft to source'}));await waitFor(()=>expect(onSaved).toHaveBeenCalledTimes(2));
 expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({action:'reset-final-campaign',input:{id:'final-editorial:H1_EN',version:2}});
 view.rerender(<OutreachFinalContentPanel campaigns={campaigns} onAsk={vi.fn()} onSaved={onSaved}/>);
 expect(screen.getByLabelText('Body 2')).toHaveValue(content.historicalSequences[0].steps[1].body);
 expect(screen.getByText(/version 3 · matches canonical source/)).toBeInTheDocument();
});
it('retains unsaved text on a conflict and allows explicit discard without external effects',async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:false,status:409,json:async()=>({error:'CAMPAIGN_DRAFT_VERSION_CHANGED'})});vi.stubGlobal('fetch',fetch);
 render(<OutreachFinalContentPanel campaigns={drafts()} onAsk={vi.fn()} onSaved={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Full reference library · 54 messages'}));
 fireEvent.change(screen.getByLabelText('Body 1'),{target:{value:'Keep this unsaved private wording.'}});
 fireEvent.click(screen.getByRole('button',{name:'Save private review draft'}));
 expect(await screen.findByRole('status')).toHaveTextContent('Your unsaved text is retained');
 expect(screen.getByLabelText('Body 1')).toHaveValue('Keep this unsaved private wording.');
 fireEvent.click(screen.getByRole('button',{name:'Discard unsaved edits'}));
 expect(screen.getByLabelText('Body 1')).toHaveValue(content.historicalSequences[0].steps[0].body);
 expect(screen.getByLabelText('Review final sequence')).not.toBeDisabled();
 expect(fetch).toHaveBeenCalledTimes(1);
});
it('keeps unsaved final edits safe from embedded refresh, close and section navigation',async()=>{
 const local={campaigns:[],finalCampaigns:drafts(),tier1:{day:'2026-10-16',timeZone:'Europe/Madrid',items:[]},readiness:{gates:[]},month:{icp:{mix:[]}}};
 const overview={status:'not_configured',checkedAt:'2026-10-16T12:00:00Z',campaigns:null,accounts:null,metrics:null};
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,status:200,json:async()=>url.endsWith('/system')?local:overview})));
 render(<OutreachWorkspacePanel onAsk={vi.fn()} onClose={vi.fn()} initialSection="strategy"/>);
 fireEvent.click(screen.getByRole('button',{name:'Full reference library · 54 messages'}));
 await screen.findByLabelText('Body 1');
 fireEvent.change(screen.getByLabelText('Body 1'),{target:{value:'An unsaved final review wording.'}});
 expect(screen.getByRole('button',{name:'Refresh outreach'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Close outreach'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Campaigns'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Body 1'),{target:{value:content.historicalSequences[0].steps[0].body}});
 expect(screen.getByRole('button',{name:'Refresh outreach'})).not.toBeDisabled();
 fireEvent.change(screen.getByLabelText('Body 1'),{target:{value:'Another unsaved wording.'}});
 fireEvent.click(screen.getByRole('button',{name:'Discard unsaved edits'}));
 expect(screen.getByRole('button',{name:'Refresh outreach'})).not.toBeDisabled();
});

it('starts with exactly six immutable pilot bodies, distinguishes audiences and keeps the full reference optional',()=>{
 const onAsk=vi.fn(); const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 render(<OutreachFinalContentPanel onAsk={onAsk} onSaved={vi.fn()}/>);
 const pilot=screen.getByRole('region',{name:'Short pilot message review'});
 const expected=[...content.historicalSequences.find(s=>s.id==='H1_EN')!.steps,...['pa_ea','business_owners'].map(id=>content.personas.find(p=>p.id===id)!.sequence.steps[0]),content.historicalSequences.find(s=>s.id==='H1_IT')!.steps[0]];
 expect([...pilot.querySelectorAll('pre')].map(item=>item.textContent)).toEqual(expected.map(step=>step.body));
 expect(pilot.querySelectorAll('details')).toHaveLength(6);
 expect([...pilot.querySelectorAll('details')].every(item=>!item.open)).toBe(true);
 expect(within(pilot).getByText(/Historical re-engagement requires Luca’s confirmation/)).toHaveTextContent('Use the Italian example only when the client confirms the contact’s language');
 expect(screen.queryByRole('region',{name:'Final message sequences'})).toBeNull();
 fireEvent.click(within(pilot).getByRole('button',{name:'Ask Brain: Review the six pilot messages'}));
 expect(onAsk).toHaveBeenCalledWith(expect.stringContaining('H1_EN steps 1–3, pa_ea step 1, business_owners step 1 and H1_IT step 1'));
 expect(onAsk.mock.calls[0][0]).toContain('Do not approve the full library, publish, enrol or send.');
 expect(fetch).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Full reference library · 54 messages'}));
 expect(screen.queryByRole('region',{name:'Short pilot message review'})).toBeNull();
 expect(screen.getByRole('region',{name:'Final message sequences'})).toBeInTheDocument();
 expect(screen.getAllByRole('button',{name:'Full reference library · 54 messages'})).toHaveLength(1);
});

it('preserves old private wording visibly and blocks a stale-source save while retaining explicit reset',()=>{
 const old=drafts();old[0]={...old[0],sourceReference:'phase1-editorial-sha256:earlier',steps:old[0].steps.map(step=>({...step,body:step.body+'\nEarlier private wording.'}))};
 render(<OutreachFinalContentPanel campaigns={old} onAsk={vi.fn()} onSaved={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Full reference library · 54 messages'}));
 expect(screen.getByText(/This private edit uses an earlier source/)).toBeInTheDocument();
 expect(screen.getByLabelText('Body 1')).toHaveValue(old[0].steps[0].body);
 fireEvent.change(screen.getByLabelText('Body 1'),{target:{value:'Attempted stale edit'}});
 expect(screen.getByRole('button',{name:'Save private review draft'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Discard unsaved edits'}));
 expect(screen.getByRole('button',{name:'Reset saved draft to source'})).not.toBeDisabled();
});
