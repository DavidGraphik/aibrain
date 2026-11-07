import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { readRegularFileWithin } from '@/security/safe-file';

/** Root-owned G03 employee policy; never supplied by a chat or browser request. */
export async function serverUserRoots(installationId: string, dataRoot: string, userId?: string, ownerUid = 0): Promise<string[] | null> {
  if (installationId !== 'g03-production') return null;
  if (!userId) return [];
  const directory=path.join(dataRoot,'locks');
  const metadata=await lstat(path.join(directory,'server-access.json'));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid!==ownerUid || (metadata.mode & 0o022)) throw Error('Política d’accés no vàlida.');
  const policy=JSON.parse((await readRegularFileWithin(directory,'server-access.json',65536)).toString('utf8'));
  if(policy.schemaVersion!==1 || policy.installationId!==installationId) throw Error('Política d’accés no vàlida.');
  const roots=policy.users?.[userId];
  if(!Array.isArray(roots) || roots.length>30 || !roots.every(r=>typeof r==='string' && /^server-g03\/[A-Z](?:\/[^?\\]+)*$/.test(r))) return [];
  return roots;
}
export function serverPathAllowed(candidate: string, roots: string[] | null, ancestors=false): boolean {
  if(roots===null) return true;
  const normalize=(s:string)=>decodeURIComponent(s.split('?')[0]).normalize('NFC').replace(/\/$/,'').toLowerCase();
  const value=normalize(candidate);
  if(value.split('/').some(s=>s==='.' || s==='..' || s.includes('\\'))) return false;
  return roots.some(root=>{const allowed=normalize(root);return value===allowed || value.startsWith(allowed+'/') || ancestors && allowed.startsWith(value+'/');});
}
