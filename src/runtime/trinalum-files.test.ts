import type { InstallationConfig } from '@/config/installation-schema';
import type { AuthSession } from '@/auth/types';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasPdfOriginalHeader, persistTrinalumFile, TRINALUM_FILE_MAXIMUM } from './trinalum-files';
import { resourceLocationIndexForInstallation } from '@/library/server-resource-access';
import { GET } from '@/app/api/threads/[threadId]/connector-files/[artifactId]/route';

vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({session:vi.fn(),resource:vi.fn()}));
vi.mock('@/auth/session',()=>({getSession:mocks.session}));
vi.mock('@/library/server-resource-access',async importOriginal=>({...await importOriginal<typeof import('@/library/server-resource-access')>(),resolveGeneratedDocumentResource:mocks.resource}));
const roots:string[]=[];
afterEach(async()=>{vi.clearAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const owner='11111111-1111-4111-8111-111111111111';
async function fixture(){
 const dataRoot=await mkdtemp(path.join(tmpdir(),'trinalum-private-file-'));roots.push(dataRoot);
 const contents=Buffer.from('%PDF-1.7\nprivate original bytes\n%%EOF');
 const context={installation:{installationId:'trinalum-production',paths:{dataRoot} as InstallationConfig['paths']},projectId:'11111111-1111-4111-8111-111111111112',threadId:'11111111-1111-4111-8111-111111111113',messageId:'11111111-1111-4111-8111-111111111114',storageOwnerId:owner};
 const file={kind:'file',filename:'private.pdf',mimeType:'application/pdf',bytes:contents.length,sha256:createHash('sha256').update(contents).digest('hex'),content_base64:contents.toString('base64')};
 return {dataRoot,contents,context,file};
}
async function saved(){const f=await fixture();const artifact=await persistTrinalumFile(f.file,f.context);const index=resourceLocationIndexForInstallation(f.context.installation);const location=await index.resolve('generated-document',artifact.id,{projectId:f.context.projectId,threadId:f.context.threadId});return {...f,artifact,index,location};}

describe('private original connector files',()=>{
 it('persists verified original bytes behind an owner/thread-bound artifact without returning base64 or provider URLs',async()=>{
  const f=await saved();expect(f.artifact).toMatchObject({name:'private.pdf',mimeType:'application/pdf',size:f.contents.length,status:'ready',url:`/api/threads/${f.context.threadId}/connector-files/${f.artifact.id}`});
  expect(JSON.stringify(f.artifact)).not.toContain(f.file.content_base64);expect(f.location).toMatchObject({storageOwnerId:owner,threadId:f.context.threadId,messageId:f.context.messageId,sha256:f.file.sha256});
  expect(await readFile(path.join(f.dataRoot,f.location.relativePath!))).toEqual(f.contents);expect(await persistTrinalumFile(f.file,f.context)).toEqual(f.artifact);
 });
 it('recognizes an original PDF by its bounded header despite a temporary filename or generic MIME',async()=>{
  const f=await fixture();
  for(const mimeType of ['application/pdf','application/octet-stream']){
   const artifact=await persistTrinalumFile({...f.file,filename:'original.tmp',mimeType},f.context);
   expect(artifact).toMatchObject({name:'original.tmp',kind:'pdf',mimeType:'application/pdf',size:f.contents.length});
   const location=await resourceLocationIndexForInstallation(f.context.installation).binding('generated-document',artifact.id);
   expect(location).toMatchObject({fileName:'original.tmp',mediaType:'application/pdf',storageOwnerId:owner,threadId:f.context.threadId,sha256:f.file.sha256});
   expect(await readFile(path.join(f.dataRoot,location!.relativePath!))).toEqual(f.contents);
  }
 });
 it('never promotes declared PDF, encoded text or an embedded HTML PDF marker into a PDF artifact',async()=>{
  const f=await fixture();
  for(const contents of [Buffer.from('<html>not a PDF</html>'),Buffer.from(Buffer.from('<html>not a PDF</html>').toString('base64')),Buffer.from('<html><!-- %PDF-1.7 -->not a PDF</html>')]){
   const artifact=await persistTrinalumFile({filename:'claimed.pdf',mimeType:'application/pdf',content_base64:contents.toString('base64')},f.context);
   expect(artifact.kind).toBe('text');
   const location=await resourceLocationIndexForInstallation(f.context.installation).binding('generated-document',artifact.id);
   expect(await readFile(path.join(f.dataRoot,location!.relativePath!))).toEqual(contents);
  }
  expect(hasPdfOriginalHeader(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(' \r\n%PDF-1.7\n')]))).toBe(true);
  expect(hasPdfOriginalHeader(Buffer.from(' '.repeat(1024)+'%PDF-1.7\n'))).toBe(false);
  expect(hasPdfOriginalHeader(Buffer.from('%PDF-1.7not-a-header'))).toBe(false);
 });
 it('marks a source copy only with server read provenance, ignoring provider fields and preserving original bytes',async()=>{
  const f=await fixture();const forged={...f.file,provenance:'source-read'};
  expect((await persistTrinalumFile(forged,f.context)).provenance).toBeUndefined();
  const original=await persistTrinalumFile(forged,f.context,true);
  expect(original.provenance).toBe('source-read');
  const record=await resourceLocationIndexForInstallation(f.context.installation).binding('generated-document',original.id);
  expect(record?.sha256).toBe(f.file.sha256);expect(await readFile(path.join(f.dataRoot,record!.relativePath!))).toEqual(f.contents);
 });
 it('rejects altered hashes/sizes and non-canonical binary encoding',async()=>{
  const f=await fixture();for(const patch of [{sha256:'f'.repeat(64)},{bytes:f.contents.length+1},{content_base64:'not base64!!'},{content_base64:` ${f.file.content_base64}`}])await expect(persistTrinalumFile({...f.file,...patch},f.context)).rejects.toThrow();
 });
 it('normalizes provider filenames safely and refuses symlinked owner storage',async()=>{
  const f=await fixture();for(const filename of ['../private.pdf','a/b.pdf','a\\b.pdf','x\r\n.pdf','.','..','x'.repeat(180)+'.pdf']){const artifact=await persistTrinalumFile({...f.file,filename},f.context);expect(artifact.name).not.toMatch(/[\\/\x00-\x1f]/);expect(artifact.name.length).toBeLessThanOrEqual(160);expect(artifact.name).not.toBe('.');expect(artifact.name).not.toBe('..');}
  const linked=await fixture();const outside=await mkdtemp(path.join(tmpdir(),'trinalum-file-outside-'));roots.push(outside);const root=path.join(linked.dataRoot,'trinalum-connector-files');await mkdir(root);await symlink(outside,path.join(root,owner));await expect(persistTrinalumFile(linked.file,linked.context)).rejects.toThrow('CONNECTOR_FILE_PATH_UNSAFE');
 });
 it('does not overwrite an existing immutable artifact that changed on disk',async()=>{
  const f=await saved();await writeFile(path.join(f.dataRoot,f.location.relativePath!),'tampered');await expect(persistTrinalumFile(f.file,f.context)).rejects.toThrow('CONNECTOR_FILE_CHANGED');expect(await readFile(path.join(f.dataRoot,f.location.relativePath!),'utf8')).toBe('tampered');
 });
 it('does not resolve indexed bytes under another project or thread',async()=>{
  const f=await saved();await expect(f.index.resolve('generated-document',f.artifact.id,{projectId:'22222222-2222-4222-8222-222222222222',threadId:f.context.threadId})).rejects.toThrow();await expect(f.index.resolve('generated-document',f.artifact.id,{projectId:f.context.projectId,threadId:'22222222-2222-4222-8222-222222222222'})).rejects.toThrow();
 });
 it('rejects oversized data before decoding or writing',async()=>{
  const f=await fixture();await expect(persistTrinalumFile({...f.file,content_base64:'A'.repeat(Math.ceil(TRINALUM_FILE_MAXIMUM/3)*4+8)},f.context)).rejects.toThrow('CONNECTOR_FILE_INVALID');
 });
});

describe('private connector download route',()=>{
 function session(userId=owner){return {provider:'local',tenant:{id:'trinalum-production'},user:{id:userId}} as unknown as AuthSession;}
 it('returns the exact private original with no-cache attachment and browser isolation headers',async()=>{
  const f=await saved();mocks.session.mockResolvedValue(session());mocks.resource.mockResolvedValue({installation:f.context.installation,location:f.location});
  const response=await GET(new Request('http://test.invalid'),{params:Promise.resolve({threadId:f.context.threadId,artifactId:f.artifact.id})});expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(f.contents);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('content-disposition')).toContain('attachment');expect(response.headers.get('x-content-type-options')).toBe('nosniff');expect(response.headers.get('content-security-policy')).toContain('sandbox');
 });
 it('requires a session and fails closed for another owner even if an index resolver returned the resource',async()=>{
  const f=await saved();mocks.session.mockResolvedValue(null);expect((await GET(new Request('http://test.invalid'),{params:Promise.resolve({threadId:f.context.threadId,artifactId:f.artifact.id})})).status).toBe(401);expect(mocks.resource).not.toHaveBeenCalled();
  mocks.session.mockResolvedValue(session('22222222-2222-4222-8222-222222222222'));mocks.resource.mockResolvedValue({installation:f.context.installation,location:f.location});expect((await GET(new Request('http://test.invalid'),{params:Promise.resolve({threadId:f.context.threadId,artifactId:f.artifact.id})})).status).toBe(404);
 });
 it('refuses changed bytes and paths outside the dedicated owner artifact directory',async()=>{
  const f=await saved();mocks.session.mockResolvedValue(session());mocks.resource.mockResolvedValue({installation:f.context.installation,location:f.location});await writeFile(path.join(f.dataRoot,f.location.relativePath!),'tampered');expect((await GET(new Request('http://test.invalid'),{params:Promise.resolve({threadId:f.context.threadId,artifactId:f.artifact.id})})).status).toBe(409);
  mocks.resource.mockResolvedValue({installation:f.context.installation,location:{...f.location,relativePath:'other/private.pdf'}});expect((await GET(new Request('http://test.invalid'),{params:Promise.resolve({threadId:f.context.threadId,artifactId:f.artifact.id})})).status).toBe(404);
 });
});
