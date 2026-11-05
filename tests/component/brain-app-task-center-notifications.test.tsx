// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '../render-spanish';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ComponentProps} from 'react';
import type {TaskCenterPanel} from '@/components/task-center-panel';
import type {AuthSession} from '@/auth/types';
import type {TaskCenterItem,TaskCenterPayload} from '@/task-center/contracts';
import {baseBrainManifest} from '@/config/brain';
import {initialRuntimeStatus} from '@/lib/runtime-status';
const mocks=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('@/ui/use-runtime-status',()=>({useRuntimeStatus:()=>initialRuntimeStatus}));
vi.mock('@/ui/use-stored-response',()=>({useStoredResponse:()=>null}));
vi.mock('@/components/chat-workspace',()=>({ChatWorkspace:()=>null}));
vi.mock('@/components/sidebar',()=>({Sidebar:()=>null}));
vi.mock('@/components/browser-panel',()=>({BrowserPanel:()=>null}));
vi.mock('@/components/command-palette',()=>({CommandPalette:()=>null}));
vi.mock('@/components/customization-panel',()=>({CustomizationPanel:()=>null}));
vi.mock('@/components/details-panel',()=>({DetailsPanel:()=>null}));
vi.mock('@/components/document-preview-panel',()=>({DocumentPreviewPanel:()=>null}));
vi.mock('@/components/project-panel',()=>({ProjectPanel:()=>null}));
vi.mock('@/components/automations-panel',()=>({AutomationsPanel:()=>null}));
vi.mock('@/components/workbench-dialogs',()=>({ConfirmDialog:()=>null,TextDialog:()=>null}));
vi.mock('@/components/task-center-panel',()=>({TaskCenterPanel:(p:ComponentProps<typeof TaskCenterPanel>)=><output data-testid="committed-task-statuses">{p.tasks.map(t=>`${t.threadTitle}:${t.status}`).join(',')}</output>}));
import {BrainApp} from '@/components/brain-app';
const session:AuthSession={provider:'local',user:{id:'qa-notifications',name:'QA',email:'qa@example.test'},tenant:{id:'qa-notifications',name:'QA'},expiresAt:'2030-01-01T00:00:00Z'};
const task=(id:string,status:TaskCenterItem['status']):TaskCenterItem=>({id:`018f5f68-4a6e-7abc-8def-0123456789${id==='historical'?'11':'21'}.018f5f68-4a6e-7abc-8def-0123456789${id==='historical'?'12':'22'}`,threadId:`018f5f68-4a6e-7abc-8def-0123456789${id==='historical'?'11':'21'}`,projectId:'own-project',threadTitle:id,projectName:'Own QA',status,title:id,detail:'Synthetic',createdAt:'2026-08-30T10:00:00Z',updatedAt:'2026-08-30T10:00:01Z',unread:status!=='running'});
const payload=(tasks:TaskCenterItem[]):TaskCenterPayload=>({tasks,readTaskIds:[],preferences:{inApp:true,desktop:true},continuity:'worker_required'});
const notifications:Array<{title:string;options?:NotificationOptions}>=[];
function mount(){render(<BrainApp manifest={baseBrainManifest} session={session} branding={{installationId:session.tenant.id,companyName:'QA',companySlug:'qa',publicUrl:'https://example.test',productName:'QA',logoPath:'',faviconPath:'',accentColor:'blue'}} initialWorkbench={{persistence:'filesystem',projects:[],threads:[]}}/>);}
const polls=()=>mocks.fetch.mock.calls.filter(([url])=>url==='/api/task-center').length;
beforeEach(()=>{
 localStorage.clear();mocks.fetch.mockReset();notifications.length=0;
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
 vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>window.setTimeout(()=>fn(0),0));vi.stubGlobal('cancelAnimationFrame',(id:number)=>window.clearTimeout(id));
 vi.stubGlobal('fetch',mocks.fetch);
 vi.stubGlobal('Notification',class{static permission='granted';constructor(title:string,options?:NotificationOptions){notifications.push({title,options});}close(){}});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('committed task-center notification transitions',()=>{
 it('does not notify historical initial results but notifies a new completed result without observing it running',async()=>{
  let next=payload([task('historical','completed')]);mocks.fetch.mockImplementation(async(url:string)=>Response.json(url==='/api/task-center'?next:{}));
  mount();await waitFor(()=>expect(screen.getByTestId('committed-task-statuses')).toHaveTextContent('historical:completed'));expect(notifications).toHaveLength(0);
  next=payload([task('fresh','completed'),task('historical','completed')]);fireEvent(window,new Event('focus'));
  await waitFor(()=>expect(notifications).toHaveLength(1));expect(notifications[0].options?.body).toBe('fresh');
 });
 it('coalesces focus during an unfinished response and accepts the next focus after its UI state is committed',async()=>{
  let resolve!: (r:Response)=>void;let requested=false;let stage=0;
  mocks.fetch.mockImplementation(async(url:string)=>{
   if(url!=='/api/task-center')return Response.json({});
   if(stage===1){requested=true;return new Promise<Response>(r=>{resolve=r;});}
   return Response.json(payload(stage===2?[task('fresh','completed')]:[]));
  });
  mount();await waitFor(()=>expect(polls()).toBe(1));await act(async()=>{});
  stage=1;fireEvent(window,new Event('focus'));await waitFor(()=>expect(requested).toBe(true));const pendingPolls=polls();
  stage=2;fireEvent(window,new Event('focus'));expect(polls()).toBe(pendingPolls);expect(notifications).toHaveLength(0);
  await act(async()=>resolve(Response.json(payload([task('fresh','running')]))));
  await waitFor(()=>expect(screen.getByTestId('committed-task-statuses')).toHaveTextContent('fresh:running'));
  fireEvent(window,new Event('focus'));await waitFor(()=>expect(notifications).toHaveLength(1));expect(notifications[0].options?.body).toBe('fresh');
 });
});
