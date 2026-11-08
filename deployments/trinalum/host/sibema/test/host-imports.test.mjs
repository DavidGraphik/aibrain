import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

async function modules(directory){
 const entries=await readdir(directory,{withFileTypes:true});
 const result=[];
 for(const entry of entries){
  const location=new URL(entry.name+(entry.isDirectory()?'/':''),directory);
  if(entry.isDirectory())result.push(...await modules(location));
  else if(entry.name.endsWith('.mjs'))result.push(location);
 }
 return result;
}

test('host packages close static and literal dynamic module dependencies',async()=>{
 let dynamic=0;
 for(const packageName of ['sibema','outlook']){
  const root=new URL(`../../${packageName}/`,import.meta.url);
  let manifest;
  try{manifest=JSON.parse(await readFile(new URL('package.json',root),'utf8'));}
  catch(error){if(packageName==='outlook'&&error.code==='ENOENT')continue;throw error;}
  const files=[...await modules(new URL('bin/',root)),...await modules(new URL('lib/',root))];
  for(const file of files){
   const source=await readFile(file,'utf8');
   // Both `from './x.mjs'` and `import('./x.mjs')` are installation dependencies.
   const literals=[
    ...Array.from(source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[\w*$\s{},]+\s+from\s+)?(['"])([^'"]+)\1/g),match=>({specifier:match[2],dynamic:false})),
    ...Array.from(source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g),match=>({specifier:match[2],dynamic:true})),
   ];
   for(const item of literals){
    const {specifier}=item;if(item.dynamic)dynamic++;
    if(specifier.startsWith('.')){
     const target=new URL(specifier,file);
     assert.equal((await stat(target).catch(()=>null))?.isFile(),true,`Missing ${specifier} imported by ${fileURLToPath(file)}`);
    }else if(!specifier.startsWith('node:')){
     const name=specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];
     assert.ok(manifest.dependencies?.[name],`${name} imported by ${fileURLToPath(file)} is not declared by ${packageName}`);
    }
   }
  }
 }
 assert.ok(dynamic>0,'The check must inspect literal dynamic imports too');
});
