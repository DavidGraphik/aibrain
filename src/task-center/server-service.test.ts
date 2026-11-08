import {beforeEach,expect,it,vi} from 'vitest';
import type {AuthSession} from '@/auth/types';
import type {ChatMessage} from '@/lib/chat-contract';
import type {WorkbenchSnapshot,WorkbenchThread} from '@/workbench/types';
import {deriveTaskCenterItems,DEFAULT_TASK_NOTIFICATION_PREFERENCES,taskCenterId} from './contracts';
import {WorkbenchNotFoundError} from '@/workbench/errors';

vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({load:vi.fn(),get:vi.fn(),quiet:vi.fn(),storeLoad:vi.fn(),storeUpdate:vi.fn()}));
vi.mock('@/workbench/store',()=>({loadWorkbench:mocks.load,createWorkbenchThreadReader:async (session:AuthSession)=>(id:string)=>mocks.get(session,id)}));
vi.mock('@/automations/thread-access',()=>({quietAutomationResultMessageIds:mocks.quiet}));
vi.mock('@/config/installation',()=>({loadInstallationConfig:async()=>({installationId:'qa'})}));
vi.mock('@/task-center/file-store',()=>({FileTaskCenterStore:{fromInstallation:()=>({load:mocks.storeLoad,update:mocks.storeUpdate})}}));
import {getTaskCenter,updateTaskCenter} from './server-service';
const session={provider:'local',user:{id:'owner'},tenant:{id:'qa'}} as AuthSession;
const message=(id:string,role:'user'|'assistant',status:string,content='Result')=>({id,role,status,content,createdAt:'2030-01-01T09:00:00.000Z',activity:[],approvals:[]}) as unknown as ChatMessage;
const thread=(id:string,messages:ChatMessage[])=>({id,projectId:'project',title:id,status:'active',messages,updatedAt:'2030-01-01T10:00:00.000Z'}) as WorkbenchThread;
let threads:WorkbenchThread[];
let metadata:WorkbenchSnapshot;
beforeEach(()=>{
 vi.clearAllMocks();
 threads=[thread('own',[message('u1','user','complete'),message('a1','assistant','complete')]),thread('shared',[message('u2','user','complete'),{...message('a2','assistant','streaming'),activity:[{id:'run',kind:'system',status:'running',label:'Real work'}]}]),thread('quiet',[message('u3','user','complete'),message('a3','assistant','complete')])];
 metadata={persistence:'filesystem',projects:[{id:'project',name:'Project'}],threads:threads.map(t=>({...t,messages:[],historyLoaded:false}))} as unknown as WorkbenchSnapshot;
 mocks.load.mockImplementation(async(_session,metadataOnly)=>{if(metadataOnly!==true)throw Error('Full history hydration forbidden');return metadata;});
 mocks.get.mockImplementation(async(_session,id)=>threads.find(t=>t.id===id));
 mocks.quiet.mockResolvedValue([{threadId:'quiet',messageId:'a3'}]);
 mocks.storeLoad.mockResolvedValue({readTaskIds:[taskCenterId('own','a1')],preferences:DEFAULT_TASK_NOTIFICATION_PREFERENCES});
 mocks.storeUpdate.mockImplementation(async()=>({readTaskIds:[taskCenterId('shared','a2')],preferences:DEFAULT_TASK_NOTIFICATION_PREFERENCES}));
});
it('preserves exact task statuses/order/read state while reading only one currently authorized thread at a time',async()=>{
 let active=0,peak=0;
 mocks.get.mockImplementation(async(actor,id)=>{expect(actor).toBe(session);active++;peak=Math.max(peak,active);await Promise.resolve();active--;return threads.find(t=>t.id===id);});
 const result=await getTaskCenter(session);
 const expected=deriveTaskCenterItems({projects:metadata.projects,threads},[taskCenterId('own','a1')]).filter(t=>t.id!==taskCenterId('quiet','a3'));
 expect(result.tasks).toEqual(expected);expect(peak).toBe(1);
 expect(mocks.load).toHaveBeenCalledWith(session,true);expect(mocks.get.mock.calls.map(c=>c[1])).toEqual(['own','shared','quiet']);
 expect(JSON.stringify(result)).not.toContain('messages');
});
it('PATCH uses the same bounded read and updated read-state',async()=>{
 const patch={markRead:[taskCenterId('shared','a2')]};const result=await updateTaskCenter(session,patch);
 expect(mocks.storeUpdate).toHaveBeenCalledWith(session.user.id,patch);expect(mocks.load).toHaveBeenCalledWith(session,true);
 expect(result.tasks).toEqual(deriveTaskCenterItems({projects:metadata.projects,threads},patch.markRead).filter(t=>t.threadId!=='quiet'));
});
it('skips a thread whose access was revoked after metadata without falling back to owner-wide history',async()=>{
 mocks.get.mockImplementation(async(_session,id)=>{if(id==='shared')throw new WorkbenchNotFoundError();return threads.find(t=>t.id===id);});
 const result=await getTaskCenter(session);expect(result.tasks.map(t=>t.threadId)).toEqual(['own']);expect(mocks.load).toHaveBeenCalledTimes(1);
});
it('keeps genuine corruption/read failures visible instead of returning an empty success',async()=>{
 mocks.get.mockRejectedValue(Error('History integrity failed'));
 await expect(getTaskCenter(session)).rejects.toThrow('History integrity failed');expect(mocks.load).toHaveBeenCalledWith(session,true);
});

it('keeps archived conversations and projects out of the active task center without deleting their histories',async()=>{
 metadata.projects.push({...metadata.projects[0],id:'archived-project',status:'archived'});
 metadata.threads[0].status='archived';
 metadata.threads[1].projectId='archived-project';
 const original=JSON.stringify(threads);
 const result=await getTaskCenter(session);
 expect(result.tasks).toEqual([]);
 expect(mocks.get.mock.calls.map(call=>call[1])).toEqual(['quiet']);
 expect(JSON.stringify(threads)).toBe(original);
});

it('omits a conversation archived after the metadata directory was read',async()=>{
 mocks.get.mockImplementation(async(_session,id)=>({...threads.find(thread=>thread.id===id),status:'archived'}));
 expect((await getTaskCenter(session)).tasks).toEqual([]);
});

it('returns small task DTOs even when the selected assistant has large content and tool data',async()=>{
 threads[0].messages[1]={...threads[0].messages[1],content:'A'.repeat(1024*1024),toolResults:[{id:'large',output:'B'.repeat(1024*1024)}]} as unknown as ChatMessage;
 const result=await getTaskCenter(session);expect(result.tasks.find(item=>item.threadId==='own')!.title).toHaveLength(90);
 expect(JSON.stringify(result).length).toBeLessThan(3000);
});
