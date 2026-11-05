import { conversationHistory } from '@/workbench/internal';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/auth/types';
import type { ChatMessage } from '@/lib/chat-contract';
import { loadInstallationConfig } from '@/config/installation';
import { UserProvisioner } from '@/users/provisioner';
import { FileWorkbenchStore } from '@/workbench/filesystem-store';
import { createProject, createThread, updateProject, updateThread } from '@/workbench/store';
import { FileDocumentStagingStore } from '@/documents/staging-store';
import { ResourceLockManager } from '@/storage/resource-lock';
import { resourceLocationIndexForInstallation } from '@/library/server-resource-access';
import { readTrinalumPrivateFile } from './trinalum-file-reader';
import { openConversationAttachment, referenceHistoricalPdf, searchConversationAttachments, type ConversationAttachmentContext } from './conversation-attachments';
import { conversationToolsForInstallation, handleConversationDynamicToolCall } from './conversation-dynamic-tools';
import { createAttachmentReviewer } from './documents/attachment-review';
import { TranslationProgress } from './documents/translation-progress';
import { generatedPngFixture } from '../../tests/helpers/png-fixture';
vi.mock('server-only',()=>({}));
const roots:string[]=[];const previous=process.env.AIBRAIN_INSTALLATION_CONFIG;
afterEach(async()=>{if(previous===undefined)delete process.env.AIBRAIN_INSTALLATION_CONFIG;else process.env.AIBRAIN_INSTALLATION_CONFIG=previous;vi.restoreAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const message=(role:'user'|'assistant',text=''):ChatMessage=>({id:randomUUID(),role,createdAt:'2026-10-27T13:51:58.539Z',status:'complete',content:text,activity:[],plan:[],approvals:[],diff:'',attachments:[],artifacts:[]});
async function fixture(installationId='trinalum-production'){
 const root=await mkdtemp(path.join(os.tmpdir(),'historical-upload-'));roots.push(root);const dataRoot=path.join(root,'data');await mkdir(dataRoot,{mode:0o700});
 const cp=path.join(root,'installation.json');await writeFile(cp,JSON.stringify({schemaVersion:1,installationId,companyName:'Synthetic',companySlug:'synthetic',publicUrl:'http://localhost:3000',branding:{productName:'AiBrain',logoPath:'/logo.svg',faviconPath:'/favicon.ico',accentColor:'#111111'},paths:{dataRoot,companyContextRoot:path.join(dataRoot,'company'),usersRoot:path.join(dataRoot,'users'),sourceReadRoot:path.join(root,'source'),publishWriteRoot:path.join(root,'publish'),backupsRoot:path.join(dataRoot,'backups')}}));process.env.AIBRAIN_INSTALLATION_CONFIG=cp;
 const installation=await loadInstallationConfig(),user=randomUUID(),foreign=randomUUID();
 const sessions=[user,foreign].map((id,i):AuthSession=>({provider:'local',user:{id,name:`Synthetic${i}`,email:`synthetic${i}@example.test`},tenant:{id:installationId,name:'Synthetic'},expiresAt:'2099-01-01T00:00:00Z'}));
 const provisioner=new UserProvisioner(installation);for(const s of sessions)await provisioner.provision({userId:s.user.id,email:s.user.email,displayName:s.user.name});
 const store=FileWorkbenchStore.fromInstallation(installation),project=await createProject(sessions[0],'Source private'),source=await createThread(sessions[0],project.id,'Unrelated title'),destProject=await createProject(sessions[0],'Destination private'),dest=await createThread(sessions[0],destProject.id,'Current chat');
 const emitArtifact=vi.fn(async()=>{}),authorizeDocuments=vi.fn(async()=>true);
 const context:ConversationAttachmentContext={installation,session:sessions[0],projectId:destProject.id,threadId:dest.id,messageId:randomUUID(),authorizeDocuments,emitArtifact};
 async function upload(name='offer.pdf',bytes=Buffer.from('%PDF-1.7\nSynthetic original\n%%EOF\n'),who=0,thread=source){
  const owner=sessions[who].user.id,stagingRoot=path.join(installation.paths.usersRoot,owner,'staging');const staging=new FileDocumentStagingStore(stagingRoot,new ResourceLockManager({rootDirectory:path.join(stagingRoot,'.locks')}));const id=randomUUID(),human=message('user','Human upload, not authorization');human.attachments=[{id,name,mimeType:'application/pdf',size:bytes.length}];
  const document=await staging.stage({threadId:thread.id,uploadId:id,validated:{kind:'pdf',fileName:name,mediaType:'application/pdf',size:bytes.length,sha256:sha(bytes),officeEntries:null},data:bytes});await store.beginThreadTurn(owner,thread.id,human,message('assistant','Secret historical chat body MUST NOT be returned'));
  return {document,human,bytes,reference:{threadId:thread.id,messageId:human.id,uploadId:id},file:path.join(stagingRoot,document.relativePath),metadata:path.join(stagingRoot,'threads',thread.id,'uploads',id,'upload.json')};
 }
 return {root,installation,store,sessions,user,foreign,source,project,dest,destProject,context,upload};
}
it('retrieves exact own archived human upload across private projects, preserves original and reuses its private artifact across turns',async()=>{
 const f=await fixture(),u=await f.upload();await updateThread(f.sessions[0],f.source.id,{status:'archived'});await updateProject(f.sessions[0],f.project.id,{status:'archived'});const before=await readFile(u.file),metadata=await readFile(u.metadata);
 const page=await searchConversationAttachments({fileName:'OFFER',since:'2026-10-27T00:00:00+01:00',before:'2026-10-28T00:00:00+01:00'},f.context);
 expect(page).toMatchObject({complete:true});expect(page.results).toEqual([expect.objectContaining({...u.reference,fileName:'offer.pdf',bytes:u.bytes.length,sha256:sha(u.bytes)})]);expect(JSON.stringify(page)).not.toContain('Secret historical chat body');
 const opened=await openConversationAttachment(u.reference,f.context),again=await openConversationAttachment(u.reference,{...f.context,messageId:randomUUID()});
 expect(opened).toMatchObject({originalPreserved:true,reused:false,sha256:sha(u.bytes),reading:{status:'not_read'}});expect(again).toMatchObject({reused:true,artifact:{id:opened.artifact.id}});expect(f.context.emitArtifact).toHaveBeenCalledTimes(2);
 expect(await readFile(u.file)).toEqual(before);expect(await readFile(u.metadata)).toEqual(metadata);const index=await resourceLocationIndexForInstallation(f.installation).binding('generated-document',opened.artifact.id);
 expect(index).toMatchObject({storageOwnerId:f.user,projectId:f.destProject.id,threadId:f.dest.id,size:u.bytes.length,sha256:sha(u.bytes)});expect((await stat(path.join(f.installation.paths.dataRoot,index!.relativePath!))).mode&0o777).toBe(0o600);
 const runner={run:vi.fn(async(_c:string,args:string[])=>args.length===1?{stdout:'Pages: 2\n',stderr:'',exitCode:0}:{stdout:'page1\fpage2\f',stderr:'',exitCode:0})};
 const readContext={installation:f.installation,storageOwnerId:f.user,projectId:f.destProject.id,threadId:f.dest.id,messageId:f.context.messageId};
 expect(await readTrinalumPrivateFile({artifactId:opened.artifact.id},readContext,{tools:{pdfinfo:'/tools/info',pdftotext:'/tools/text',pdftoppm:'/tools/render'},runner})).toMatchObject({sha256:sha(u.bytes),pages:2,complete:true});
 await expect(readTrinalumPrivateFile({artifactId:opened.artifact.id},{...readContext,threadId:f.source.id},{tools:{pdfinfo:'/tools/info',pdftotext:'/tools/text',pdftoppm:'/tools/render'},runner})).rejects.toThrow('ACCESS_DENIED');
});
it('paginates metadata without duplicate originals, binds filters/actor/destination, and distinguishes equal names with different bytes',async()=>{
 const f=await fixture();const a=await f.upload(),b=await f.upload('offer.pdf',Buffer.from('%PDF-1.7\nDistinct version\n%%EOF\n'));const first=await searchConversationAttachments({fileName:'offer',limit:1},f.context);expect(first.complete).toBe(false);expect(first.nextCursor).not.toBeNull();
 const second=await searchConversationAttachments({fileName:'offer',limit:1,cursor:first.nextCursor},f.context);expect(new Set([...first.results,...second.results].map(r=>r.uploadId)).size).toBe(2);expect(new Set([...first.results,...second.results].map(r=>r.sha256))).toEqual(new Set([sha(a.bytes),sha(b.bytes)]));
 for(const args of [{fileName:'another',cursor:first.nextCursor},{fileName:'offer',since:'2026-10-27T00:00:00Z',cursor:first.nextCursor},{fileName:'offer',cursor:'bad'},{fileName:'offer',cursor:first.nextCursor,ownerId:f.foreign}])await expect(searchConversationAttachments(args,f.context)).rejects.toThrow('ARGUMENTS_OR_CURSOR_INVALID');
 const other=await createThread(f.sessions[0],f.destProject.id,'Other destination');await expect(searchConversationAttachments({fileName:'offer',cursor:first.nextCursor},{...f.context,threadId:other.id})).rejects.toThrow('CURSOR_INVALID');
 const dates=await searchConversationAttachments({fileName:'offer',since:'2026-10-28T00:00:00Z'},f.context);expect(dates.results).toEqual([]);
});
it('never discovers foreign/shared-other-owner uploads or reads a guessed foreign source store',async()=>{
 const f=await fixture(),p=await createProject(f.sessions[1],'Foreign shared'),t=await createThread(f.sessions[1],p.id,'Foreign');const u=await f.upload('foreign.pdf',undefined,1,t);
 await updateProject(f.sessions[1],p.id,{sharing:{visibility:'shared',members:[{id:randomUUID(),email:f.sessions[0].user.email,name:'Viewer',role:'viewer',status:'active',addedAt:new Date().toISOString()}]}});
 const spy=vi.spyOn(FileWorkbenchStore.prototype,'loadAccessSnapshot');expect((await searchConversationAttachments({fileName:'foreign'},f.context)).results).toEqual([]);await expect(openConversationAttachment(u.reference,f.context)).rejects.toThrow('INACCESSIBLE');expect(spy.mock.calls.map(a=>a[0])).not.toContain(f.foreign);expect(f.context.emitArtifact).not.toHaveBeenCalled();
});
it.each(['shared','foreign','archived','denied','expired','tenant'] as const)('rejects an unsafe destination/session before source bytes or publication: %s',async(change)=>{
 const f=await fixture(),u=await f.upload();let context=f.context;
 if(change==='shared')await updateProject(f.sessions[0],f.destProject.id,{sharing:{visibility:'shared',members:[]}});
 if(change==='foreign'){const p=await createProject(f.sessions[1],'Foreign private'),t=await createThread(f.sessions[1],p.id,'Other');context={...context,projectId:p.id,threadId:t.id};}
 if(change==='archived')await updateProject(f.sessions[0],f.destProject.id,{status:'archived'});
 if(change==='denied')vi.mocked(f.context.authorizeDocuments).mockResolvedValue(false);
 if(change==='expired')context={...context,session:{...context.session,expiresAt:'2000-01-01T00:00:00Z'}};
 if(change==='tenant')context={...context,session:{...context.session,tenant:{id:'other',name:'Other'}}};
 await expect(openConversationAttachment(u.reference,context)).rejects.toThrow('INACCESSIBLE');expect(f.context.emitArtifact).not.toHaveBeenCalled();
});
it.each(['wrong-message','wrong-upload','source-revoked','removed'] as const)('requires current source access and exact human attachment membership: %s',async(change)=>{
 const f=await fixture(),u=await f.upload();let ref=u.reference;
 if(change==='wrong-message')ref={...ref,messageId:randomUUID()};if(change==='wrong-upload')ref={...ref,uploadId:randomUUID()};
 if(change==='source-revoked')vi.mocked(f.context.authorizeDocuments).mockImplementation(async p=>p!==f.project.id);
 if(change==='removed'){const stateFile=path.join(f.installation.paths.usersRoot,f.user,'state/workbench.json');const state=JSON.parse(await readFile(stateFile,'utf8'));state.threads=state.threads.filter((t:{id:string})=>t.id!==f.source.id);await writeFile(stateFile,JSON.stringify(state),{mode:0o600});}
 await expect(openConversationAttachment(ref,f.context)).rejects.toThrow('INACCESSIBLE');expect(f.context.emitArtifact).not.toHaveBeenCalled();
});
it.each(['missing','hash','metadata-hash','metadata-path','symlink-metadata','symlink-file','symlink-directory','hardlink','public','false-pdf'] as const)('refuses missing/corrupt/unsafe original without emitting a replacement: %s',async(change)=>{
 const f=await fixture(),u=await f.upload();
 if(change==='missing')await rm(u.file);
 if(change==='hash')await writeFile(u.file,Buffer.from('x'.repeat(u.bytes.length)),{mode:0o600});
 if(change==='metadata-hash'){const m=JSON.parse(await readFile(u.metadata,'utf8'));m.sha256='0'.repeat(64);await writeFile(u.metadata,JSON.stringify(m),{mode:0o600});}
 if(change==='metadata-path'){const m=JSON.parse(await readFile(u.metadata,'utf8'));m.relativePath='threads/'+f.source.id+'/uploads/'+randomUUID()+'/offer.pdf';await writeFile(u.metadata,JSON.stringify(m),{mode:0o600});}
 if(change==='symlink-metadata'){await rename(u.metadata,u.metadata+'.original');await symlink(u.metadata+'.original',u.metadata);}
 if(change==='symlink-file'){await rename(u.file,u.file+'.original');await symlink(u.file+'.original',u.file);}
 if(change==='symlink-directory'){const directory=path.dirname(u.file);await rename(directory,directory+'.original');await symlink(directory+'.original',directory);}
 if(change==='hardlink')await link(u.file,u.file+'.linked');if(change==='public')await chmod(u.file,0o644);
 if(change==='false-pdf'){const b=Buffer.from('<html>not PDF</html>'.padEnd(u.bytes.length,'x'));await writeFile(u.file,b,{mode:0o600});const m=JSON.parse(await readFile(u.metadata,'utf8'));m.size=b.length;m.sha256=sha(b);await writeFile(u.metadata,JSON.stringify(m),{mode:0o600});}
 await expect(openConversationAttachment(u.reference,f.context)).rejects.toThrow();expect(f.context.emitArtifact).not.toHaveBeenCalled();
});
it('rechecks permissions after resolving bytes and blocks revocation without any artifact emission',async()=>{
 const f=await fixture(),u=await f.upload();let checks=0;vi.mocked(f.context.authorizeDocuments).mockImplementation(async()=>++checks<4);await expect(openConversationAttachment(u.reference,f.context)).rejects.toThrow('INACCESSIBLE');expect(f.context.emitArtifact).not.toHaveBeenCalled();expect(await readdir(path.join(f.installation.paths.dataRoot,'trinalum-connector-files')).catch(()=>[])).toEqual([]);
});
it('does not expose project private keys, workspace files, assistant-only staging or previous chat bodies',async()=>{
 const f=await fixture(),u=await f.upload('actual.pdf');const workspace=path.join(f.installation.paths.usersRoot,f.user,'workspace/projects',f.project.id);await mkdir(workspace,{recursive:true,mode:0o700});await writeFile(path.join(workspace,'clave-exp40.txt'),'secret-key-for-project-only',{mode:0o600});
 const orphan=path.dirname(u.metadata).replace(u.reference.uploadId,randomUUID());await mkdir(orphan,{mode:0o700});const metadata=JSON.parse(await readFile(u.metadata,'utf8'));metadata.uploadId=path.basename(orphan);metadata.fileName='clave-exp40.pdf';metadata.relativePath=`threads/${f.source.id}/uploads/${metadata.uploadId}/clave-exp40.pdf`;await writeFile(path.join(orphan,'upload.json'),JSON.stringify(metadata),{mode:0o600});await writeFile(path.join(orphan,'clave-exp40.pdf'),u.bytes,{mode:0o600});
 const page=await searchConversationAttachments({fileName:'clave-exp40'},f.context);expect(page.results).toEqual([]);expect(JSON.stringify(page)).not.toContain('secret-key-for-project-only');expect(JSON.stringify(page)).not.toContain('Secret historical chat body');await expect(openConversationAttachment({threadId:f.source.id,messageId:u.human.id,uploadId:metadata.uploadId},f.context)).rejects.toThrow('INACCESSIBLE');
});
it('offers Trinalum only attachment tools and rejects general history even with a valid session',async()=>{
 const f=await fixture();const trinalum=conversationToolsForInstallation('trinalum-production',true);expect(trinalum.flatMap(t=>t.type==='namespace'?t.tools.map(x=>x.name):[])).toEqual(['search_attachments','open_attachment']);expect(conversationToolsForInstallation('trinalum-production',false)).toEqual([]);expect(conversationToolsForInstallation('g03-production',true).flatMap(t=>t.type==='namespace'?t.tools.map(x=>x.name):[])).toEqual(['list','read','search_attachments','reference_historical_pdf']);expect(conversationToolsForInstallation('g03-production',false).flatMap(t=>t.type==='namespace'?t.tools.map(x=>x.name):[])).toEqual(['list','read']);expect(conversationToolsForInstallation('g03-qa',true).flatMap(t=>t.type==='namespace'?t.tools.map(x=>x.name):[])).toEqual(['list','read']);
 for(const tool of ['list','read']){const result=await handleConversationDynamicToolCall({namespace:'aibrain_conversations',tool,arguments:{threadId:f.source.id},threadId:'runtime',turnId:'turn',callId:'call'},{session:f.sessions[0],installationId:'trinalum-production',userId:f.user,runtimeThreadId:'runtime',runtimeTurnId:'turn',allowHistory:true,attachments:f.context});expect(result).toMatchObject({success:false});}
});
it('bounds a page to100staged metadata records and continues without re-reading chat bodies for unmatched filenames',async()=>{
 const f=await fixture(),u=await f.upload();const root=path.dirname(path.dirname(u.file));const metadata=JSON.parse(await readFile(u.metadata,'utf8'));
 for(let i=0;i<100;i++){const id=randomUUID(),dir=path.join(root,id);await mkdir(dir,{mode:0o700});await writeFile(path.join(dir,'upload.json'),JSON.stringify({...metadata,uploadId:id,fileName:`unrelated-${i}.pdf`,relativePath:`threads/${f.source.id}/uploads/${id}/unrelated-${i}.pdf`}),{mode:0o600});}
 const reader=vi.spyOn(FileWorkbenchStore.prototype,'getThread');const first=await searchConversationAttachments({fileName:'no-such-original'},f.context);expect(first.examinedUploads).toBe(100);expect(first.complete).toBe(false);expect(first.nextCursor).not.toBeNull();const second=await searchConversationAttachments({fileName:'no-such-original',cursor:first.nextCursor},f.context);expect(second.examinedUploads).toBe(1);expect(second.complete).toBe(true);expect(first.results).toEqual([]);expect(second.results).toEqual([]);expect(reader).not.toHaveBeenCalled();
});

it('rejects paths, owner arguments, invalid dates and pagination bounds before metadata search',async()=>{
 const f=await fixture();
 for(const args of [{fileName:'../private'},{fileName:'x'},{fileName:'offer',ownerId:f.foreign},{fileName:'offer',since:'2026-02-30T00:00:00Z'},{fileName:'offer',before:'2026-10-27T00:00:00'},{fileName:'offer',since:'2026-10-28T00:00:00Z',before:'2026-10-27T00:00:00Z'},{fileName:'offer',limit:21},{fileName:'offer',limit:0}])await expect(searchConversationAttachments(args,f.context)).rejects.toThrow('ARGUMENTS_OR_CURSOR_INVALID');
 await expect(openConversationAttachment({threadId:f.source.id,messageId:randomUUID(),uploadId:randomUUID(),path:'/private/source'},f.context)).rejects.toThrow('ARGUMENTS_OR_CURSOR_INVALID');
});

it('routes the new runtime tools through authenticated context and emits only the verified current-chat artifact',async()=>{
 const f=await fixture(),u=await f.upload();
 const context={session:f.sessions[0],installationId:'trinalum-production',userId:f.user,runtimeThreadId:'runtime',runtimeTurnId:'turn',allowHistory:false,attachments:f.context};
 const invoke=(tool:string,args:Record<string,string>)=>handleConversationDynamicToolCall({namespace:'aibrain_conversations',tool,arguments:args,threadId:'runtime',turnId:'turn',callId:randomUUID()},context);
 const search=await invoke('search_attachments',{fileName:'offer'});expect(search.success).toBe(true);const text=search.contentItems[0];expect(text.type).toBe('inputText');
 const opened=await invoke('open_attachment',u.reference);expect(opened.success).toBe(true);expect(f.context.emitArtifact).toHaveBeenCalledWith(expect.objectContaining({provenance:'source-read',url:expect.stringContaining('/api/threads/'+f.dest.id+'/connector-files/')}));
 const invalid=await handleConversationDynamicToolCall({namespace:'aibrain_conversations',tool:'open_attachment',arguments:u.reference,threadId:'runtime',turnId:'foreign-turn',callId:randomUUID()},context);expect(invalid.success).toBe(false);expect(f.context.emitArtifact).toHaveBeenCalledTimes(1);
});

it('preserves a stored original on a no-upload runtime bootstrap while metadata alone cannot authorize another chat',async()=>{
 const f=await fixture(),u=await f.upload(),opened=await openConversationAttachment(u.reference,f.context);const assistant=message('assistant','Recovered original');assistant.artifacts=[opened.artifact];await f.store.beginThreadTurn(f.user,f.dest.id,message('user','Show original'),assistant);await f.store.beginThreadTurn(f.user,f.dest.id,message('user','Compare its dates; no new upload'),message('assistant','Pending comparison'));
 const bootstrap=await f.store.getThreadConversationHistory(f.user,f.dest.id);expect(bootstrap).toContain(opened.artifact.id);expect(bootstrap).toContain('not_revalidated_by_history_formatter');expect(bootstrap).toContain('Compare its dates; no new upload');
 const source=await f.store.getThread(f.user,f.source.id);source.messages[1].artifacts=[{...opened.artifact,url:`/api/threads/${f.source.id}/connector-files/${opened.artifact.id}`}];const forgedHistory=conversationHistory({...source,runtimeThreadToken:null});expect(forgedHistory).toContain(opened.artifact.id);
 const runner={run:vi.fn()};await expect(readTrinalumPrivateFile({artifactId:opened.artifact.id},{installation:f.installation,storageOwnerId:f.user,projectId:f.project.id,threadId:f.source.id,messageId:randomUUID()},{tools:{pdfinfo:'/tools/info',pdftotext:'/tools/text',pdftoppm:'/tools/render'},runner})).rejects.toThrow('ACCESS_DENIED');expect(runner.run).not.toHaveBeenCalled();
});

it('references the same owned G03 PDF without a copy or source-chat change and resumes translation on a later turn',async()=>{
 const f=await fixture('g03-production'),u=await f.upload();
 const before=await f.store.getThread(f.user,f.source.id),original=await readFile(u.file);
 const makeReview=()=>createAttachmentReviewer({documents:[],translationRequested:true,previews:{
  read:async()=>({sourceSha256:sha(u.bytes),files:['document.pdf'],pages:2} as never),renderPage:async()=>generatedPngFixture(),
 }});
 const first=makeReview();const c={...f.context,registerHistoricalPdf:(doc:Parameters<typeof first.referenceHistoricalPdf>[0],verify:()=>Promise<void>)=>first.referenceHistoricalPdf(doc,verify)};
 const found=await searchConversationAttachments({fileName:'offer'},c);expect(found.results).toHaveLength(1);
 const link=await referenceHistoricalPdf(u.reference,c);expect(link).toMatchObject({originalCopied:false,sourceConversationModified:false,sha256:sha(u.bytes)});
 expect(f.context.emitArtifact).not.toHaveBeenCalled();await first('offer.pdf',1);
 const firstSource=await first.translationSource('offer.pdf');const progress=new TranslationProgress(await realpath(f.root),{installationId:'g03-production',userId:f.user,threadId:f.dest.id,...firstSource,targetLanguage:'català'});
 await progress.save(first.translationInspection('offer.pdf',1),'first page');
 const second=makeReview();await referenceHistoricalPdf(u.reference,{...f.context,registerHistoricalPdf:(doc,verify)=>second.referenceHistoricalPdf(doc,verify)});
 const nextSource=await second.translationSource('offer.pdf');const resumed=new TranslationProgress(await realpath(f.root),{installationId:'g03-production',userId:f.user,threadId:f.dest.id,...nextSource,targetLanguage:'Catalan'});
 expect((await resumed.status()).savedPages).toEqual([1]);await second('offer.pdf',2);await resumed.save(second.translationInspection('offer.pdf',2),'second page');
 expect((await resumed.assemble()).text).toContain('first page\n\n[Página 2]\nsecond page');
 expect(await readFile(u.file)).toEqual(original);expect(await f.store.getThread(f.user,f.source.id)).toEqual(before);
 expect(await readdir(path.join(f.installation.paths.dataRoot,'trinalum-connector-files')).catch(()=>[])).toEqual([]);
 await expect(openConversationAttachment(u.reference,c)).rejects.toThrow();
});

it('denies historical PDF use to a different account and rechecks a permission revoked during rendering',async()=>{
 const f=await fixture('g03-production'),u=await f.upload();let permitted=true;const reviewer=createAttachmentReviewer({documents:[],previews:{
  read:async()=>({sourceSha256:sha(u.bytes),files:['document.pdf'],pages:1} as never),renderPage:async()=>{permitted=false;return generatedPngFixture();},
 }});
 const c={...f.context,authorizeDocuments:async()=>permitted,registerHistoricalPdf:(doc:Parameters<typeof reviewer.referenceHistoricalPdf>[0],verify:()=>Promise<void>)=>reviewer.referenceHistoricalPdf(doc,verify)};
 await expect(referenceHistoricalPdf(u.reference,{...c,session:f.sessions[1]})).rejects.toThrow();
 await referenceHistoricalPdf(u.reference,c);
 await expect(reviewer('offer.pdf',1)).rejects.toThrow();expect(reviewer.coverage().documents[0].suppliedPages).toEqual([]);
});

it('refuses a historical original changed after reference and never releases a page',async()=>{
 const f=await fixture('g03-production'),u=await f.upload();const renderPage=vi.fn(async()=>generatedPngFixture());
 const reviewer=createAttachmentReviewer({documents:[],previews:{read:async()=>({sourceSha256:sha(u.bytes),files:['document.pdf'],pages:1} as never),renderPage}});
 await referenceHistoricalPdf(u.reference,{...f.context,registerHistoricalPdf:(doc,verify)=>reviewer.referenceHistoricalPdf(doc,verify)});
 await writeFile(u.file,Buffer.from('x'.repeat(u.bytes.length)),{mode:0o600});
 await expect(reviewer('offer.pdf',1)).rejects.toThrow();expect(renderPage).not.toHaveBeenCalled();
});
