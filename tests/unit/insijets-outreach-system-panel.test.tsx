// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {OutreachSystemPanel} from '@/components/outreach-system-panel';
import {DEMO_CAMPAIGNS,OUTREACH_READINESS} from '@/insijets/outreach-campaigns';
import {OUTREACH_SOURCING_SPEC} from '@/insijets/outreach-sourcing-spec';
import {planOutreachMonth} from '@/insijets/outreach-month-plan';
const initial=()=>({readiness:OUTREACH_READINESS,sourcing:OUTREACH_SOURCING_SPEC,campaigns:structuredClone(DEMO_CAMPAIGNS),month:planOutreachMonth(),tier1:{day:'2026-10-15',timeZone:'Europe/Madrid' as const,mode:'local-manual-linkedin-review' as const,items:[],counts:{selected:0,available:0,heldOrExpired:0},created:false,emailSent:false as const,notificationSent:false as const,linkedinAction:false as const,schedulerInstalled:false as const,providerDispatch:false as const,crmHistoricalRead:false as const,crmWrite:false as const,campaignActivated:false as const}});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('renders the delivered historical demo without assigning identity or granting send and preserves calendar cadence',()=>{
 render(<OutreachSystemPanel initial={initial()}/>);
 expect(screen.getByRole('heading',{name:'Outreach System'})).toBeInTheDocument();
 expect(screen.getByLabelText('Subject')).toHaveValue('Revisiting your travel plans');
 expect(screen.getByText(/Message 3 · \+17 calendar days/)).toBeInTheDocument();
 expect(screen.getByText(/Sending account: unassigned/)).toBeInTheDocument();
 expect(screen.getByText('Continuous')).toBeInTheDocument();
 expect(screen.getByText('Lead qualification · historical first')).toBeInTheDocument();
 expect(screen.getByText(/15 ICP profiles \/ segments · 18 reusable draft sequences · 54 draft messages/)).toHaveTextContent('not individual people or a contact limit');
 expect(screen.queryByText('75')).toBeNull();expect(screen.queryByText('150')).toBeNull();
 expect(screen.queryByRole('button',{name:/^send|activate|extract/i})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/Art and galleries/}));
 expect(screen.getByText(/Parked for month one/)).toBeInTheDocument();
});
it('preserves unsaved work, saves only a versioned local draft and handles a stale revision visibly',async()=>{
 const data=initial();const fetch=vi.fn().mockResolvedValueOnce({ok:false,json:async()=>({error:'CAMPAIGN_DRAFT_VERSION_CHANGED'})}).mockResolvedValueOnce({ok:true,json:async()=>({result:{campaign:{...data.campaigns[0],subject:'Synthetic edited subject',version:2}}})});vi.stubGlobal('fetch',fetch);
 render(<OutreachSystemPanel initial={data}/>);fireEvent.change(screen.getByLabelText('Subject'),{target:{value:'Synthetic edited subject'}});
 expect(screen.getByRole('button',{name:/Art and galleries/})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Save review draft'}));await screen.findByText('This draft changed. Refresh before saving.');
 fireEvent.click(screen.getByRole('button',{name:'Save review draft'}));await screen.findByText('Draft saved for review. Sending remains disabled.');
 expect(screen.getByText('Draft v2')).toBeInTheDocument();
 const sent=JSON.parse(fetch.mock.calls[0][1].body);expect(sent.action).toBe('save-campaign');expect(sent.input.version).toBe(1);expect(sent.input.bodies).toHaveLength(3);expect(sent.input).not.toHaveProperty('approved');
});
it('keeps numerical contact counts illustrative, separates the SOW baseline and preserves the empty manual Tier1 workflow',async()=>{
 const data=initial();vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({result:data.tier1})}));render(<OutreachSystemPanel initial={data}/>);
 fireEvent.click(screen.getByRole('button',{name:'Illustrative scenario'}));expect(screen.getByText(/Tuesday–Thursday sending windows/)).toHaveTextContent('not a lead target or contracted capacity');
 expect(screen.getByRole('heading',{name:'Illustrative month-one scenario'})).toBeInTheDocument();
 expect(screen.getByText(/SOW planning reference: approximately 5,760 emails\/month/)).toHaveTextContent('after safe, verified warm-up');
 expect(screen.getByText(/SOW planning reference:/)).toHaveTextContent('4 sending days/week × 15 emails/mailbox/day × 24 mailboxes × 4 weeks');
 expect(screen.getByText(/SOW planning reference:/)).toHaveTextContent('not a launch-volume promise, a new contracted cap or permission to send');
 expect(screen.getByText('Illustrative historical first contacts')).toBeInTheDocument();expect(screen.getByText('Illustrative month-one emails')).toBeInTheDocument();
 for(const [index,value] of [5,10,15,20].entries())expect(screen.getByLabelText(`Week ${index+1} · total emails/day`)).toHaveValue(value);
 expect(screen.getByText(/Middle East: 0%/)).toBeInTheDocument();expect(screen.getByRole('heading',{name:'Research instructions · no extraction'})).toBeInTheDocument();expect(screen.getByText('18%')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Daily Tier 1'}));expect(screen.getByText('No eligible contacts staged')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:/Prepare today.s five/}));await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('No notification or LinkedIn action was sent.'));
 expect(screen.queryByRole('button',{name:/send notification|connect on linkedin/i})).toBeNull();
});
