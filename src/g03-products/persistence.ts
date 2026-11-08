import { lstat, open, mkdir, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, ResourceLockManager } from '@/storage';
import { ProductError, requireProduct } from './contracts';
import {compressSnapshot,readSnapshot,writeSnapshot} from './version-storage';
function validateKey(key:string){requireProduct(/^(production|production-design|sage-receiving|production-view-[a-f0-9]{64}|(?:app|welcome)-[a-f0-9-]{36})$/.test(key),'Identificador invàlid.');}
export class ProductStore {
  private locks: ResourceLockManager;
  constructor(readonly root: string, readonly installationId: string) { requireProduct(path.isAbsolute(root), 'Ruta invàlida.'); this.locks = new ResourceLockManager({ rootDirectory: path.join(root, '.locks') }); }
  async read<T>(key: string): Promise<T | null> {
    validateKey(key);
    const file = path.join(this.root, `${key}.json`);
    try { const stat = await lstat(file); requireProduct(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 32 * 1024 * 1024, 'Dades insegures.', 503); const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { const v = JSON.parse(await handle.readFile('utf8')); requireProduct(v.installationId === this.installationId && v.schemaVersion === 1, 'Dades d’una altra instal·lació.', 403); return v.value as T; } finally { await handle.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; if (error instanceof ProductError) throw error; throw new ProductError(503, 'No es poden llegir les dades.'); }
  }
  async readVersion<T>(key:string,revision:number):Promise<T>{
    validateKey(key);requireProduct(Number.isSafeInteger(revision)&&revision>=0,'Revisió invàlida.');
    const v=JSON.parse((await readSnapshot(path.join(this.root,'versions',key,`${revision}.json`))).toString('utf8'));
    requireProduct(v.installationId===this.installationId&&v.schemaVersion===1,'Dades d’una altra instal·lació.',403);
    requireProduct(v.value?.revision===revision,'Revisió inconsistent.',503);return v.value as T;
  }
  async migrateVersions(key:string,options:{apply?:boolean;limit?:number;onResult?:(result:Awaited<ReturnType<typeof compressSnapshot>>)=>void|Promise<void>}={}){
    validateKey(key);const limit=options.limit??Number.MAX_SAFE_INTEGER;requireProduct(Number.isSafeInteger(limit)&&limit>0,'Límit invàlid.');
    const directory=path.join(this.root,'versions',key);
    try{const metadata=await lstat(directory);requireProduct(metadata.isDirectory()&&!metadata.isSymbolicLink(),'Directori de versions insegur.',503);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const files=(await readdir(directory)).filter(file=>/^(0|[1-9][0-9]*)\.json$/.test(file)).sort((a,b)=>Number(a.split('.')[0])-Number(b.split('.')[0])).slice(0,limit);
    const results=[];
    for(const file of files){const result=await this.locks.withLock(key,async lease=>{
      const original=JSON.parse((await readSnapshot(path.join(directory,file))).toString('utf8'));
      requireProduct(original.schemaVersion===1&&original.installationId===this.installationId,'Dades d’una altra instal·lació.',403);
      requireProduct(original.value?.revision===Number(file.split('.')[0]),'Revisió inconsistent.',503);
      return compressSnapshot(path.join(directory,file),()=>lease.assertHeld(),options.apply===true);
    });results.push(result);await options.onResult?.(result);}
    return results;
  }
  async mutate<T extends { revision: number }, R>(key: string, initial: () => T, action: (value: T) => R, expected?: number): Promise<R> {
    validateKey(key);
    return this.locks.withLock(key, async lease => {
      const old = await this.read<T>(key), value = old ? structuredClone(old) : initial();
      if (expected !== undefined) requireProduct(value.revision === expected, 'Algú ha canviat les dades. Actualitza abans de tornar a desar.', 409);
      const result = action(value); value.revision += 1;
      const encode = (v: T) => JSON.stringify({ schemaVersion: 1, installationId: this.installationId, value: v });
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if (old) { const backup = path.join(this.root, 'versions', key, `${old.revision}.json`); await lease.assertHeld(); await writeSnapshot(backup, Buffer.from(encode(old))); }
      const encoded=encode(value); requireProduct(Buffer.byteLength(encoded)<=32*1024*1024,'Límit d’emmagatzematge assolit.',409);
      await lease.assertHeld(); await atomicWriteFile(path.join(this.root, `${key}.json`), encoded); return result;
    });
  }
}
