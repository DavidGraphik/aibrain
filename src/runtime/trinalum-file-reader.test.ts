import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { InstallationConfig } from '@/config/installation-schema';
import { SystemDocumentToolRunner, type DocumentToolRunner } from '@/documents/preview-service';
import { resourceLocationIndexForInstallation } from '@/library/server-resource-access';
import { persistTrinalumFile, resolveTrinalumArtifactAttachment } from './trinalum-files';
import { readTrinalumPrivateFile, type PrivateFileRead } from './trinalum-file-reader';
import { handleTrinalumTool } from './trinalum-dynamic-tools';
vi.mock('server-only',()=>({}));
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const owner='11111111-1111-4111-8111-111111111111';
const tools={pdfinfo:'/native/pdfinfo',pdftotext:'/native/pdftotext',pdftoppm:'/native/pdftoppm'};
async function fixture(blank=false,filename='original.pdf',mimeType='application/pdf'){
 const dataRoot=await mkdtemp(path.join(tmpdir(),'private-reader-test-'));roots.push(dataRoot);
 const context={installation:{installationId:'trinalum-production',paths:{dataRoot} as InstallationConfig['paths']},projectId:'11111111-1111-4111-8111-111111111112',threadId:'11111111-1111-4111-8111-111111111113',messageId:'11111111-1111-4111-8111-111111111114',storageOwnerId:owner};
 const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Helvetica);
 pdf.addPage([500,300]).drawText('Invoice TEST-19-10 | EUR 123.45',{x:20,y:250,font,size:12});
 const page=pdf.addPage([500,300]);if(!blank)page.drawText('Second page | Supplier synthetic only',{x:20,y:250,font,size:12});
 const original=Buffer.from(await pdf.save());
 const artifact=await persistTrinalumFile({filename,mimeType,content_base64:original.toString('base64'),sha256:createHash('sha256').update(original).digest('hex'),bytes:original.length},context);
 return {context,original,artifact};
}
function runner(text='First page\fSecond page\f'):DocumentToolRunner{return {run:vi.fn(async(command,_args,options)=>{expect(options.cwd).toMatch(/aibrain-turn-document-[A-Za-z0-9_-]+$/);expect(options.timeoutMs).toBe(15000);return {stdout:command===tools.pdfinfo?'Pages: 2\n':text,stderr:''};})};}
describe('private original PDF reader',()=>{
 it('exports a verified temporary-named original without conversion, then explicitly reads all pages and transfers identical bytes',async()=>{
  const f=await fixture(false,'original.tmp','application/octet-stream');const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=','base64');const textRunner=runner();
  const native:DocumentToolRunner={run:vi.fn(async(command,args,options)=>{
   if(command===tools.pdftoppm){await writeFile(String(args.at(-1))+'.png',png);return {stdout:'',stderr:''};}
   return textRunner.run(command,args,options);
  })};
  const bridge=path.join(f.context.installation.paths.dataRoot,'bridge.json');await writeFile(bridge,JSON.stringify({installationId:'trinalum-production',url:'http://127.0.0.1:18931/read',users:{[owner]:{status:'active',token:'a'.repeat(64)}}}),{mode:0o600});
  const readPrivateFile=vi.fn((input:PrivateFileRead)=>readTrinalumPrivateFile(input,f.context,{tools,runner:native}));
  const context={installationId:'trinalum-production',userId:owner,runtimeThreadId:'runtime-thread',runtimeTurnId:'runtime-turn',admitOperation:async()=>true,configPath:bridge,
   onFile:(file:Record<string,unknown>)=>persistTrinalumFile(file,f.context),readPrivateFile,
   fetcher:async()=>Response.json({kind:'file',filename:'original.tmp',mimeType:'application/octet-stream',bytes:f.original.length,sha256:createHash('sha256').update(f.original).digest('hex'),content_base64:f.original.toString('base64')})};
  const call=(tool:string,args:Record<string,unknown>)=>handleTrinalumTool({namespace:'trinalum_business',tool,arguments:args as never,threadId:'runtime-thread',turnId:'runtime-turn',callId:'export-read'},context);
  const exported=await call('mail_api',{input:{operation:'attachment'}});expect(exported.success).toBe(true);
  const saved=JSON.parse((exported.contentItems[0] as {text:string}).text);expect(saved).toMatchObject({artifact:{id:f.artifact.id,name:'original.tmp',kind:'pdf',mimeType:'application/pdf'},originalAttachment:{artifactId:f.artifact.id},reading:{status:'not_read',complete:false}});
  expect(native.run).not.toHaveBeenCalled();expect(readPrivateFile).not.toHaveBeenCalled();
  const result=await call('read_private_file',{artifactId:saved.artifact.id});expect(result.success).toBe(true);
  expect(JSON.parse((result.contentItems[0] as {text:string}).text)).toMatchObject({fileName:'original.tmp',formatVerification:'pdf_header_verified',pages:2,startPage:1,endPage:2,complete:true});expect(native.run).toHaveBeenCalledTimes(2);
  const rendered=await call('read_private_file',{artifactId:saved.artifact.id,renderPage:2,output:'image'});expect(rendered).toEqual({success:true,contentItems:[{type:'inputImage',imageUrl:`data:image/png;base64,${png.toString('base64')}`}]});expect(native.run).toHaveBeenCalledTimes(5);
  const denied=await call('read_private_file',{artifactId:saved.artifact.id,renderPage:2,output:'image',path:'/foreign/source.pdf'});expect(denied.success).toBe(false);expect(native.run).toHaveBeenCalledTimes(5);
  expect((await resolveTrinalumArtifactAttachment(saved.artifact.id,f.context)).contentBytes).toBe(f.original.toString('base64'));
 });
 it('reads a genuine temporary-named PDF with identical bytes and the same owner/thread admission',async()=>{
  const f=await fixture(false,'original.tmp','application/octet-stream');const native=runner();
  expect(f.artifact).toMatchObject({name:'original.tmp',kind:'pdf',mimeType:'application/pdf'});
  expect(await readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,runner:native})).toMatchObject({fileName:'original.tmp',formatVerification:'pdf_header_verified',status:'read',pages:2,complete:true,bytes:f.original.length});
  expect((await resolveTrinalumArtifactAttachment(f.artifact.id,f.context)).contentBytes).toBe(f.original.toString('base64'));
  await expect(readTrinalumPrivateFile({artifactId:f.artifact.id},{...f.context,storageOwnerId:'22222222-2222-4222-8222-222222222222'},{tools,runner:native})).rejects.toThrow('PRIVATE_FILE_ACCESS_DENIED');
 });
 it('reports MIME/extension-only PDF claims without decoding or invoking any converter',async()=>{
  const f=await fixture();const native=runner();const admission=vi.fn(async(fn:()=>Promise<unknown>)=>fn());
  for(const original of [Buffer.from('<html>not an original PDF</html>'),Buffer.from(Buffer.from('<html>not an original PDF</html>').toString('base64')),Buffer.from('<html><!-- %PDF-1.7 -->not an original PDF</html>')]){
   const artifact=await persistTrinalumFile({filename:'original.tmp',mimeType:'application/pdf',content_base64:original.toString('base64')},f.context);
   const result=await readTrinalumPrivateFile({artifactId:artifact.id},f.context,{tools,runner:native,conversionGate:{run:admission} as never});
   expect(result).toMatchObject({status:'unsupported_format',complete:false,formatVerification:'pdf_header_missing',originalPreserved:true});
   expect((await resolveTrinalumArtifactAttachment(artifact.id,f.context)).contentBytes).toBe(original.toString('base64'));
  }
  expect(native.run).not.toHaveBeenCalled();expect(admission).not.toHaveBeenCalled();
 });
 it('requires the exact owner, project and UI thread before invoking a converter',async()=>{
  const f=await fixture();const native=runner();for(const patch of [{storageOwnerId:'22222222-2222-4222-8222-222222222222'},{projectId:'22222222-2222-4222-8222-222222222222'},{threadId:'22222222-2222-4222-8222-222222222222'},{installation:{...f.context.installation,installationId:'arnall'}}])await expect(readTrinalumPrivateFile({artifactId:f.artifact.id},{...f.context,...patch},{tools,runner:native})).rejects.toThrow('PRIVATE_FILE_ACCESS_DENIED');
  expect(native.run).not.toHaveBeenCalled();
 });
 it('rejects tampering, paths, unknown options and invalid ranges without reading another source',async()=>{
  const f=await fixture();const native=runner();for(const input of [{artifactId:'../../file'},{artifactId:f.artifact.id,startPage:0},{artifactId:f.artifact.id,pageCount:11},{artifactId:f.artifact.id,startPage:501},{artifactId:f.artifact.id,path:'/private/foreign'}])await expect(readTrinalumPrivateFile(input,f.context,{tools,runner:native})).rejects.toThrow();
  const loc=await resourceLocationIndexForInstallation(f.context.installation).binding('generated-document',f.artifact.id);await writeFile(path.join(f.context.installation.paths.dataRoot,loc!.relativePath!),'changed');
  await expect(readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,runner:native})).rejects.toThrow('PRIVATE_FILE_SOURCE_CHANGED');expect(native.run).not.toHaveBeenCalled();
 });
 it('refuses a symlink substituted for an indexed original before conversion',async()=>{
  const f=await fixture();const native=runner();const location=await resourceLocationIndexForInstallation(f.context.installation).binding('generated-document',f.artifact.id);const target=path.join(f.context.installation.paths.dataRoot,location!.relativePath!);const outside=path.join(f.context.installation.paths.dataRoot,'outside.pdf');await writeFile(outside,f.original);await unlink(target);await symlink(outside,target);await expect(readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,runner:native})).rejects.toThrow();expect(native.run).not.toHaveBeenCalled();
 });
 it('preserves originals on conversion failure and never exposes paths or claims successful extraction',async()=>{
  const f=await fixture();const result=await readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,runner:{run:async()=>{throw Error('/private/secret provider content');}}});
  expect(result).toMatchObject({status:'extraction_unavailable',complete:false,originalPreserved:true});expect(JSON.stringify(result)).not.toContain('/private/');
  expect((await resolveTrinalumArtifactAttachment(f.artifact.id,f.context)).contentBytes).toBe(f.original.toString('base64'));
 });
 it('removes only its own temporary original when the turn aborts',async()=>{
  const f=await fixture();const controller=new AbortController();let work='';
  await expect(readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,signal:controller.signal,runner:{run:async(_cmd,_args,options)=>{work=options.cwd;controller.abort();throw Error('aborted');}}})).rejects.toThrow('aborted');
  expect(work).toContain('aibrain-turn-document-');await expect(access(work)).rejects.toMatchObject({code:'ENOENT'});expect((await resolveTrinalumArtifactAttachment(f.artifact.id,f.context)).contentBytes).toBe(f.original.toString('base64'));
 });
 it('reports partial, blank and truncated extraction honestly and uses conversion admission',async()=>{
  const f=await fixture();const admission=vi.fn();const gate={run:async<T>(fn:()=>T|Promise<T>):Promise<T>=>{admission();return await fn();}};
  const partial=await readTrinalumPrivateFile({artifactId:f.artifact.id,pageCount:1},f.context,{tools,runner:runner('First\f'),conversionGate:gate});expect(partial).toMatchObject({startPage:1,endPage:1,nextPage:2,complete:false,untrustedContent:true});expect(admission).toHaveBeenCalledOnce();
  expect(await readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,runner:runner('First\f\f')})).toMatchObject({emptyPages:[2],complete:false});
  expect(await readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,runner:runner('X'.repeat(100001)+'\fSecond\f')})).toMatchObject({textTruncated:true,complete:false});
  expect(await readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,runner:{run:async()=>({stdout:'Pages: 501\n',stderr:''})}})).toMatchObject({status:'page_limit',pages:501,complete:false});
 });
 it('uses the visible same-name order rather than registration order without exposing another owner/project/thread',async()=>{
  const f=await fixture();
  const add=async(context:typeof f.context,suffix:string)=>{
   const bytes=Buffer.concat([f.original,Buffer.from('\n% '+suffix+'\n')]);
   return persistTrinalumFile({filename:'original.pdf',mimeType:'application/pdf',content_base64:bytes.toString('base64')},context);
  };
  const second=await add({...f.context,messageId:'11111111-1111-4111-8111-111111111115'},'second original');
  const hidden=[await add({...f.context,storageOwnerId:'22222222-2222-4222-8222-222222222222'},'foreign owner'),
   await add({...f.context,projectId:'22222222-2222-4222-8222-222222222223'},'foreign project'),
   await add({...f.context,threadId:'22222222-2222-4222-8222-222222222224'},'foreign conversation')];
  const result=await readTrinalumPrivateFile({artifactId:second.id},f.context,{tools,runner:runner(),visibleArtifactIds:[second.id,f.artifact.id]});
  expect(result).toMatchObject({artifactId:second.id,bytes:second.size,selectedFileNumber:1,sameNameOriginalsTotal:2,
   originalOrdering:'visible_conversation_same_name_order',sameNameOriginalsTruncated:false,
   sameNameOriginals:[{fileNumber:1,artifactId:second.id,bytes:second.size,selected:true},
    {fileNumber:2,artifactId:f.artifact.id,bytes:f.original.length,selected:false}]});
  expect(JSON.stringify(result)).toContain('Findings apply only to the selected');
  for(const artifact of hidden)expect(JSON.stringify(result)).not.toContain(artifact.id);
  const unknown=await readTrinalumPrivateFile({artifactId:second.id},f.context,{tools,runner:runner()});
  expect(unknown).toMatchObject({selectedFileNumber:null,originalOrdering:'visible_order_not_fully_available',
   sameNameOriginals:[{fileNumber:null,artifactId:f.artifact.id},{fileNumber:null,artifactId:second.id}]});
  const partial=await readTrinalumPrivateFile({artifactId:second.id},f.context,{tools,runner:runner(),visibleArtifactIds:[f.artifact.id]});
  expect(partial).toMatchObject({selectedFileNumber:null,originalOrdering:'visible_order_not_fully_available',
   sameNameOriginals:[{fileNumber:1,artifactId:f.artifact.id},{fileNumber:null,artifactId:second.id}]});

  expect((await resolveTrinalumArtifactAttachment(second.id,f.context)).contentBytes).not.toBe(f.original.toString('base64'));
 });
 it('loads visible thread order only when same-name originals need disambiguation',async()=>{
  const f=await fixture();const order=vi.fn(async()=>[f.artifact.id]);
  await readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,runner:runner(),visibleArtifactIds:order});
  expect(order).not.toHaveBeenCalled();
 });
 it('does not call a zero-exit malformed-stream parse a blank original or a complete read',async()=>{
  const f=await fixture();
  const result=await readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,runner:{run:async command=>({
   stdout:command===tools.pdfinfo?'Pages: 2\n':'\f\f',
   stderr:command===tools.pdftotext?'Syntax Error: Bad block header in flate stream at /private/secret\nSyntax Error: Embedded font file may be invalid':''})}});
  expect(result).toMatchObject({status:'read_with_parser_warnings',complete:false,emptyPages:[1,2],contentIntegrity:'not_verified_by_parser',
   parserWarnings:['pdf_content_decode_warning','pdf_font_decode_warning']});
  expect(JSON.stringify(result)).toContain('does not establish that the original pages are blank');
  expect(JSON.stringify(result)).not.toContain('/private/secret');
  expect((await resolveTrinalumArtifactAttachment(f.artifact.id,f.context)).contentBytes).toBe(f.original.toString('base64'));
 });
 it('retains decoded text but never marks a parser-warning result complete',async()=>{
  const f=await fixture();const native=runner();const warned:DocumentToolRunner={run:async(command,args,options)=>({
   ...await native.run(command,args,options),stderr:command===tools.pdfinfo?'Syntax Error: invalid xref at /private/secret':''})};
  const result=await readTrinalumPrivateFile({artifactId:f.artifact.id},f.context,{tools,runner:warned});
  expect(result).toMatchObject({status:'read_with_parser_warnings',complete:false,emptyPages:[],parserWarnings:['pdf_content_decode_warning']});
  expect('text' in result&&result.text).toContain('First page');expect(JSON.stringify(result)).not.toContain('/private/secret');
 });
});
const nativeTools={pdfinfo:process.env.AIBRAIN_TEST_PDFINFO!,pdftotext:process.env.AIBRAIN_TEST_PDFTOTEXT!,pdftoppm:process.env.AIBRAIN_TEST_PDFTOPPM!};
it.runIf(Object.values(nativeTools).every(Boolean))('extracts and renders actual original PDF bytes with native Poppler and transfers the identical original',async()=>{
 const f=await fixture(true);const system=new SystemDocumentToolRunner();const native:DocumentToolRunner={run:(cmd,args,options)=>system.run(cmd,args,{...options,env:{...options.env,...(process.env.AIBRAIN_TEST_PDF_LIBRARY_PATH?{DYLD_FALLBACK_LIBRARY_PATH:process.env.AIBRAIN_TEST_PDF_LIBRARY_PATH}:{})}})};
 const result=await readTrinalumPrivateFile({artifactId:f.artifact.id,pageCount:1},f.context,{tools:nativeTools,runner:native});expect(result).toMatchObject({status:'read',pages:2,nextPage:2,complete:false});expect('text' in result&&result.text).toContain('TEST-19-10');expect('text' in result&&result.text).toContain('123.45');
 const second=await readTrinalumPrivateFile({artifactId:f.artifact.id,startPage:2,renderPage:2},f.context,{tools:nativeTools,runner:native});expect(second).toMatchObject({status:'read',emptyPages:[2],renderedPage:2,complete:false});expect('png' in second&&Buffer.isBuffer(second.png)&&second.png.length).toBeGreaterThan(100);
 const bridge=path.join(f.context.installation.paths.dataRoot,'bridge.json');await writeFile(bridge,JSON.stringify({installationId:'trinalum-production',url:'http://127.0.0.1:18931/read',users:{[owner]:{status:'active',token:'a'.repeat(64)}}}));
 const projected=await handleTrinalumTool({namespace:'trinalum_business',tool:'read_private_file',arguments:{artifactId:f.artifact.id,renderPage:2},threadId:'runtime-thread',turnId:'runtime-turn',callId:'render'}, {installationId:'trinalum-production',userId:owner,runtimeThreadId:'runtime-thread',runtimeTurnId:'runtime-turn',admitOperation:async()=>true,configPath:bridge,readPrivateFile:async()=>second});expect(projected.success).toBe(true);expect(projected.contentItems[1]).toMatchObject({type:'inputImage',imageUrl:expect.stringMatching(/^data:image\/png;base64,iVBOR/)});expect((projected.contentItems[0] as {text:string}).text).not.toContain('"type":"Buffer"');
 const location=await resourceLocationIndexForInstallation(f.context.installation).binding('generated-document',f.artifact.id);expect(await readFile(path.join(f.context.installation.paths.dataRoot,location!.relativePath!))).toEqual(f.original);expect((await resolveTrinalumArtifactAttachment(f.artifact.id,f.context)).contentBytes).toBe(f.original.toString('base64'));
});

describe('private connector workbook reading',()=>{
 it('reads a real XLSX original through the existing paginated parser and tool with unchanged bytes and explicit complete coverage',async()=>{
  const {generateLocalDocument}=await import('./documents/local-document-generator');
  const workbook=await generateLocalDocument({format:'xlsx',title:'Synthetic workbook',content:'Synthetic saved values',rows:[['Grade','EUR/t'],['SYNTHETIC-A',1234],['SYNTHETIC-B',2345]]});
  const f=await fixture();const artifact=await persistTrinalumFile({filename:'prices.xlsx',mimeType:'application/vnd.ms-excel',content_base64:workbook.data.toString('base64')},f.context);
  const native:DocumentToolRunner={run:vi.fn(async(command,args,options)=>{
   expect(command).toBe('/usr/local/bin/aibrain-g03-paged-spreadsheet');expect(args[0]).toBe('.xlsx');
   const source=await readFile(path.join(options.cwd,'source.xlsx'));expect(source.equals(workbook.data)).toBe(true);
   return {stdout:JSON.stringify({ok:true,sourceSha256:workbook.sha256,page:Number(args[1]),parts:2,text:Number(args[1])===1?'Sheet1 A1:B2: Grade EUR/t SYNTHETIC-A 1234':'Sheet1 A3:B3: SYNTHETIC-B 2345'}),stderr:''};
  })};
  const gate={run:async<T>(fn:()=>T|Promise<T>)=>fn()};
  const bridge=path.join(f.context.installation.paths.dataRoot,'bridge.json');await writeFile(bridge,JSON.stringify({installationId:'trinalum-production',url:'http://127.0.0.1:18931/read',users:{[owner]:{status:'active',token:'a'.repeat(64)}}}),{mode:0o600});
  const readPrivateFile=(input:PrivateFileRead)=>readTrinalumPrivateFile(input,f.context,{tools,runner:native,conversionGate:gate});
  const result=await handleTrinalumTool({namespace:'trinalum_business',tool:'read_private_file',arguments:{artifactId:artifact.id,startPage:1,pageCount:1,output:'text'},threadId:'runtime-thread',turnId:'runtime-turn',callId:'workbook'}, {installationId:'trinalum-production',userId:owner,runtimeThreadId:'runtime-thread',runtimeTurnId:'runtime-turn',admitOperation:async()=>true,configPath:bridge,readPrivateFile});
  expect(result.success).toBe(true);expect(JSON.parse((result.contentItems[0] as {text:string}).text)).toMatchObject({status:'read',formatVerification:'spreadsheet_container_verified',pages:2,nextPage:2,complete:false});
  const rest=await readPrivateFile({artifactId:artifact.id,startPage:2,pageCount:1});expect(rest).toMatchObject({nextPage:null,complete:false});expect("text" in rest ? rest.text : null).toContain('SYNTHETIC-B');
  const all=await readPrivateFile({artifactId:artifact.id});expect(all).toMatchObject({complete:true,nextPage:null});expect("text" in all ? all.text : null).toContain('EUR/t');
  expect((await resolveTrinalumArtifactAttachment(artifact.id,f.context)).contentBytes).toBe(workbook.data.toString('base64'));
  await expect(readTrinalumPrivateFile({artifactId:artifact.id},{...f.context,threadId:'foreign'},{tools,runner:native,conversionGate:gate})).rejects.toThrow('PRIVATE_FILE_ACCESS_DENIED');
  await expect(readPrivateFile({artifactId:artifact.id,renderPage:1})).rejects.toThrow('PRIVATE_FILE_RENDER_UNAVAILABLE');
 });
 it('keeps malformed or non-workbook ZIP originals intact and does not claim successful parsing',async()=>{
  const f=await fixture();const bytes=Buffer.concat([Buffer.from('504b0304','hex'),Buffer.from('not a workbook')]);
  const artifact=await persistTrinalumFile({filename:'broken.xlsx',content_base64:bytes.toString('base64')},f.context);
  const native:DocumentToolRunner={run:vi.fn(async()=>({stdout:JSON.stringify({ok:false,reason:'INVALID_WORKBOOK'}),stderr:''}))};
  await expect(readTrinalumPrivateFile({artifactId:artifact.id},f.context,{tools,runner:native,conversionGate:{run:async fn=>fn()}})).rejects.toThrow('SERVER_SPREADSHEET_UNAVAILABLE');
  expect((await resolveTrinalumArtifactAttachment(artifact.id,f.context)).contentBytes).toBe(bytes.toString('base64'));
 });
});
