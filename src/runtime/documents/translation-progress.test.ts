import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranslationProgress, verifyTranslatedDocx } from "./translation-progress";
import { generateLocalDocument } from "./local-document-generator";
import { validateUploadedDocument } from "@/documents/upload-validation";

const roots: string[]=[];
const source={installationId:"g03-production",userId:"10000000-0000-4000-8000-000000000001",threadId:"20000000-0000-4000-8000-000000000002",uploadId:"30000000-0000-4000-8000-000000000003",sourceSha256:"a".repeat(64),pages:64,targetLanguage:"català"};
const inspection=(page:number)=>({page,pages:64,sourceSha256:source.sourceSha256,imageSha256:"b".repeat(64)});
async function fixture(){const root=await realpath(await mkdtemp(path.join(tmpdir(),"translation-progress-")));roots.push(root);return {root,progress:new TranslationProgress(root,source)};}
afterEach(async()=>{vi.useRealTimers();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe("private bounded translation progress",()=>{
 it("recognizes common language aliases across turns without merging regional variants",async()=>{
  const {root}=await fixture();const initial=new TranslationProgress(root,{...source,targetLanguage:'español'});
  await initial.save(inspection(1),'traducción guardada');
  for(const targetLanguage of ['castellano','Spanish','ESPAÑOL','es']){
   const resumed=new TranslationProgress(root,{...source,targetLanguage});expect(resumed.key).toBe(initial.key);expect((await resumed.status()).savedPages).toEqual([1]);
  }
  expect(new TranslationProgress(root,{...source,targetLanguage:'es-AR'}).key).not.toBe(initial.key);
  expect(new TranslationProgress(root,{...source,targetLanguage:'Catalan'}).key).toBe(new TranslationProgress(root,{...source,targetLanguage:'català'}).key);
 });
 it("continues after a turn boundary and assembles only exact saved page content in order",async()=>{
  const {root,progress}=await fixture();
  for(let page=1;page<=50;page++) await progress.save(inspection(page),`synthetic translation ${page}`);
  await expect(progress.assemble()).rejects.toMatchObject({code:"TRANSLATION_INCOMPLETE"});
  const resumed=new TranslationProgress(root,source);expect(await resumed.status()).toMatchObject({pendingCount:14,pendingPages:Array.from({length:14},(_,i)=>i+51)});
  for(let page=51;page<=64;page++)await resumed.save(inspection(page),`synthetic translation ${page}`);
  const result=await resumed.assemble();expect(result.coverage.complete).toBe(true);
  expect(result.text).toContain('[Página 1]\nsynthetic translation 1');expect(result.text).toContain('[Página 64]\nsynthetic translation 64');
  expect(result.text.indexOf('[Página 63]')).toBeLessThan(result.text.indexOf('[Página 64]'));
 });
 it("isolates user, thread, upload, hash and target language; rejects changed source",async()=>{
  const {root,progress}=await fixture();await progress.save(inspection(51),'translated page');
  for(const patch of [{userId:'10000000-0000-4000-8000-000000000002'},{threadId:'20000000-0000-4000-8000-000000000003'},{uploadId:'30000000-0000-4000-8000-000000000004'},{sourceSha256:'c'.repeat(64)},{targetLanguage:'English'}]){
   const other=new TranslationProgress(root,{...source,...patch});expect((await other.status()).pendingCount).toBe(64);
  }
  await expect(progress.save({...inspection(52),sourceSha256:'c'.repeat(64)},'wrong source')).rejects.toMatchObject({code:'TRANSLATION_PROGRESS_INVALID'});
 });
 it("makes identical retries idempotent, rejects conflicting updates and preserves data under concurrency",async()=>{
  const {progress}=await fixture();
  await Promise.all(Array.from({length:8},()=>progress.save(inspection(1),'same')));
  await expect(progress.save(inspection(1),'different')).rejects.toMatchObject({code:'TRANSLATION_PAGE_CONFLICT'});
  await Promise.all(Array.from({length:8},(_,i)=>progress.save(inspection(i+2),`page ${i+2}`)));
  expect((await progress.status()).savedPages).toEqual([1,2,3,4,5,6,7,8,9]);
  const previous=await progress.page(1);
  await progress.save(inspection(1),'corrected',previous.translationSha256);
  await expect(progress.save(inspection(1),'stale edit',previous.translationSha256)).rejects.toMatchObject({code:'TRANSLATION_PAGE_CONFLICT'});
  expect((await progress.page(1)).translation).toBe('corrected');
 });
 it("refuses a corrupted stored translation and does not credit it",async()=>{
  const {root,progress}=await fixture();await progress.save(inspection(1),'original');
  const file=path.join(root,'document-translation-progress',`${progress.key}.json`);const body=JSON.parse(await readFile(file,'utf8'));body.pages[0].translation='modified';await writeFile(file,JSON.stringify(body));
  await expect(progress.assemble()).rejects.toMatchObject({code:'TRANSLATION_PROGRESS_INVALID'});
 });
 it("retains a full long translation beyond the former 200 KB and 5,000-line limits",async()=>{
  const {root}=await fixture();const long={...source,pages:20};const progress=new TranslationProgress(root,long);
  for(let page=1;page<=long.pages;page++) {
   const text=Array.from({length:300},(_,line)=>`P${page} L${line} `+createHash('sha256').update(`${page}:${line}`).digest('hex')).join('\n');
   await progress.save({...inspection(page),pages:long.pages},text);
  }
  const result=await progress.assemble();
  expect(Buffer.byteLength(result.text)).toBeGreaterThan(200_000);
  expect(result.text.split('\n').length).toBeGreaterThan(5_000);
  const generated=await generateLocalDocument({format:'docx',title:'Traducción larga',content:result.text,verbatim:true});
  await expect(verifyTranslatedDocx(generated.data,'Traducción larga',result.text)).resolves.toBeUndefined();
  expect(validateUploadedDocument({fileName:'traduccion.docx',declaredMimeType:generated.mimeType,data:generated.data}).kind).toBe('docx');
 },20000);
 it("rejects an oversized translation rather than silently truncating it",async()=>{
  await expect(generateLocalDocument({format:'docx',title:'large',content:'x'.repeat(4_000_001),verbatim:true})).rejects.toMatchObject({code:'LOCAL_DOCUMENT_INPUT_INVALID'});
  await expect(generateLocalDocument({format:'docx',title:'large',content:Array(50_001).fill('x').join('\n'),verbatim:true})).rejects.toMatchObject({code:'LOCAL_DOCUMENT_INPUT_INVALID'});
 });
 it("accepts a legitimate highly repetitive translation without weakening archive validation",async()=>{
  const content=Array(8_000).fill('Same value and repeated table entry').join('\n');
  expect(Buffer.byteLength(content)).toBeGreaterThan(200_000);
  const generated=await generateLocalDocument({format:'docx',title:'Repeated table',content,verbatim:true});
  await expect(verifyTranslatedDocx(generated.data,'Repeated table',content)).resolves.toBeUndefined();
  expect(validateUploadedDocument({fileName:'repetitive.docx',declaredMimeType:generated.mimeType,data:generated.data}).kind).toBe('docx');
 });
 it("renders identical Word bytes across retry times",async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const input={format:'docx' as const,title:'Translation',content:'[Página 1]\n- text',verbatim:true};
  const one=await generateLocalDocument(input);vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
  const two=await generateLocalDocument(input);expect(two.data.equals(one.data)).toBe(true);
 });
});
