import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,unlink} from 'node:fs/promises';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import path from 'node:path';
import {atomicWriteFile,fsyncDirectory} from '@/storage';
import {requireProduct} from './contracts';
const compress=promisify(gzip),expand=promisify(gunzip);
const MAX_BYTES=32*1024*1024;
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export async function readVersionBytes(file:string,compressed=false){
 const metadata=await lstat(file);
 requireProduct(metadata.isFile()&&!metadata.isSymbolicLink()&&metadata.nlink===1&&metadata.size<=MAX_BYTES+65536,'Versió insegura.',503);
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const current=await handle.stat();requireProduct(current.ino===metadata.ino&&current.dev===metadata.dev&&current.size===metadata.size,'La versió ha canviat.',409);
  const bytes=await handle.readFile();const result=compressed?await expand(bytes,{maxOutputLength:MAX_BYTES}):bytes;
  requireProduct(result.length<=MAX_BYTES,'Versió massa gran.',503);return {bytes:result,metadata};
 }finally{await handle.close();}
}
async function optionalVersion(file:string,compressed=false){try{return await readVersionBytes(file,compressed);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
export async function readSnapshot(file:string){
 const plain=await optionalVersion(file);if(plain)return plain.bytes;
 return (await readVersionBytes(`${file}.gz`,true)).bytes;
}
/** Caller holds the product key lock. Never replace an existing, different revision. */
export async function writeSnapshot(file:string,bytes:Buffer){
 requireProduct(bytes.length<=MAX_BYTES,'Versió massa gran.',503);
 const plain=await optionalVersion(file),zipped=await optionalVersion(`${file}.gz`,true);
 for(const existing of [plain,zipped])if(existing)requireProduct(sha256(existing.bytes)===sha256(bytes),'La còpia històrica no coincideix.',409);
 if(plain||zipped)return;
 const compressed=await compress(bytes);
 requireProduct(sha256(await expand(compressed,{maxOutputLength:MAX_BYTES}))===sha256(bytes),'Verificació de versió fallida.',503);
 await atomicWriteFile(`${file}.gz`,compressed);
 requireProduct(sha256((await readVersionBytes(`${file}.gz`,true)).bytes)===sha256(bytes),'Verificació de còpia fallida.',503);
}
/** One original is removed only after its durable gzip has been read and verified. */
export async function compressSnapshot(file:string,assertHeld:()=>Promise<void>,apply:boolean){
 const original=await readVersionBytes(file);const digest=sha256(original.bytes);
 const existing=await optionalVersion(`${file}.gz`,true);
 if(existing)requireProduct(sha256(existing.bytes)===digest,'La còpia comprimida no coincideix amb l’original.',409);
 const compressed=existing?null:await compress(original.bytes);
 if(compressed)requireProduct(sha256(await expand(compressed,{maxOutputLength:MAX_BYTES}))===digest,'Verificació de versió fallida.',503);
 const compressedBytes=existing?(await lstat(`${file}.gz`)).size:compressed!.length;
 const result={file:path.basename(file),sha256:digest,originalBytes:original.bytes.length,compressedBytes,savedBytes:original.bytes.length-compressedBytes,applied:apply};
 if(!apply)return result;
 await assertHeld();if(compressed)await atomicWriteFile(`${file}.gz`,compressed);
 requireProduct(sha256((await readVersionBytes(`${file}.gz`,true)).bytes)===digest,'Verificació de còpia fallida.',503);
 const current=await readVersionBytes(file);
 requireProduct(current.metadata.ino===original.metadata.ino&&current.metadata.dev===original.metadata.dev&&current.metadata.mtimeMs===original.metadata.mtimeMs&&sha256(current.bytes)===digest,'L’original ha canviat.',409);
 await assertHeld();await unlink(file);await fsyncDirectory(path.dirname(file));return result;
}
