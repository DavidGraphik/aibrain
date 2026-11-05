import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,chmod,lstat,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {assertCleanExactSource,collectStandalone,digest,LIMITS,packageStandalone,safePackagePath,writeArchive} from './package-standalone.mjs';

async function put(root,name,value){const p=path.join(root,name);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,value);return p;}
async function fixture(t){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'standalone-package-test-')));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [name,value] of Object.entries({
    '.next/standalone/server.js':'console.log("synthetic")',
    '.next/standalone/package.json':'{"name":"synthetic"}',
    '.next/standalone/.next/BUILD_ID':'synthetic-build',
    '.next/BUILD_ID':'synthetic-build',
    'node_modules/dep/index.js':'module.exports=1',
    '.next/standalone/node_modules/dep/index.js':'module.exports=1',
    '.next/next-server.js.nft.json':'{"version":1,"files":["../node_modules/dep/index.js"]}',
    '.next/server/route.js.nft.json':'{"version":1,"files":["../../node_modules/dep/index.js"]}',
    'public/icon.txt':'public-asset', 'skills/example/SKILL.md':'synthetic-skill',
    'dist/automation-worker.mjs':'console.log("synthetic worker")',
  }))await put(root,name,value);
  return root;
}

async function sourceFixture(t){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'standalone-source-test-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  await put(root,'tracked.txt','synthetic tracked source');
  git('init','-q');git('add','.');git('-c','user.name=Synthetic test','-c','user.email=test@example.invalid','commit','-qm','synthetic source','--no-gpg-sign');
  return {root,git,sha:git('rev-parse','HEAD')};
}

test('exact source check rejects tracked changes, hidden untracked files and a different commit on every host',async t=>{
  const {root,git,sha}=await sourceFixture(t);assert.doesNotThrow(()=>assertCleanExactSource(root,sha));
  await put(root,'tracked.txt','SYNTHETIC_CONTENT_MUST_NOT_BE_LOGGED');
  assert.throws(()=>assertCleanExactSource(root,sha),error=>error.message.includes('CLEAN_EXACT_SOURCE_REQUIRED')&&error.message.includes('tracked.txt')&&!error.message.includes('SYNTHETIC_CONTENT_MUST_NOT_BE_LOGGED'));
  await put(root,'tracked.txt','synthetic tracked source');
  git('config','status.showUntrackedFiles','no');
  await put(root,'generated.pyc','SYNTHETIC_BYTECODE_MUST_NOT_BE_LOGGED');
  assert.throws(()=>assertCleanExactSource(root,sha),error=>error.message.includes('generated.pyc')&&!error.message.includes('SYNTHETIC_BYTECODE_MUST_NOT_BE_LOGGED'));
  await rm(path.join(root,'generated.pyc'));
  assert.throws(()=>assertCleanExactSource(root,'0'.repeat(40)),error=>error.message.includes(sha)&&error.message.includes('"changedPathCount":0'));
});

test('dirty diagnostics bound and escape filenames without accepting any changed path',async t=>{
  const {root,sha}=await sourceFixture(t);
  for(let i=0;i<28;i++)await put(root,`untracked-${String(i).padStart(2,'0')}\n.txt`,'synthetic');
  assert.throws(()=>assertCleanExactSource(root,sha),error=>{
    const detail=JSON.parse(error.message.slice('CLEAN_EXACT_SOURCE_REQUIRED '.length));
    assert.equal(detail.changedPathCount,28);assert.equal(detail.changedPaths.length,24);assert.equal(detail.pathsTruncated,true);
    assert.ok(!error.message.includes('\n'));return true;
  });
});

test('the CI Python setting prevents the real import cache that would dirty the Linux checkout',async t=>{
  const {root,git}=await sourceFixture(t);
  await put(root,'generated_module.py','synthetic_value = 1\n');git('add','.');
  git('-c','user.name=Synthetic test','-c','user.email=test@example.invalid','commit','-qm','synthetic module','--no-gpg-sign');
  const sha=git('rev-parse','HEAD');
  const env={...process.env};delete env.PYTHONDONTWRITEBYTECODE;delete env.PYTHONPYCACHEPREFIX;delete env.PYTHONPATH;
  // Apple Python redirects caches outside the project; use Python's Linux
  // default location explicitly so this regression also runs on a Mac.
  const command=['-S','-c','import sys; sys.pycache_prefix = None; import generated_module'];
  execFileSync('python3',command,{cwd:root,env,stdio:['ignore','pipe','pipe']});
  assert.throws(()=>assertCleanExactSource(root,sha),/__pycache__/);
  await rm(path.join(root,'__pycache__'),{recursive:true});
  const workflow=await readFile(new URL('../.github/workflows/quality.yml',import.meta.url),'utf8');
  const setting=workflow.match(/^      PYTHONDONTWRITEBYTECODE: ['"]?(1)['"]?\s*$/m)?.[1];assert.equal(setting,'1');
  execFileSync('python3',command,{cwd:root,env:{...env,PYTHONDONTWRITEBYTECODE:setting},stdio:['ignore','pipe','pipe']});
  assert.doesNotThrow(()=>assertCleanExactSource(root,sha));
});

test('keeps traced dependencies, static/public/skills and independent worker',async t=>{
  const root=await fixture(t);await put(root,'.next/static/chunks/chunk.js','chunk');
  const result=await collectStandalone(root);
  const names=result.files.map(x=>x.path);
  for(const name of ['candidate/node_modules/dep/index.js','candidate/.next/static/chunks/chunk.js','candidate/public/icon.txt',
    'candidate/skills/example/SKILL.md','candidate/automation-worker.mjs'])assert.ok(names.includes(name));
  assert.equal(result.tracing.traceCount,2);assert.equal(result.tracing.verifiedFiles,1);
  assert.equal(result.files.reduce((n,x)=>n+x.bytes,0),result.payloadBytes);
});

test('a missing traced dependency fails instead of publishing a partial package',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.next/static'),{recursive:true});
  await rm(path.join(root,'.next/standalone/node_modules/dep/index.js'));
  await assert.rejects(collectStandalone(root),/TRACED_FILE_MISSING/);
});

test('a stale traced copy fails hash parity',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.next/static'),{recursive:true});
  await put(root,'node_modules/dep/index.js','changed-after-build');
  await assert.rejects(collectStandalone(root),/TRACED_FILE_DIFFERS/);
});

test('resolves an internal dependency symlink into regular archive bytes',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.next/static'),{recursive:true});
  const target=path.join(root,'.next/standalone/node_modules/dep/index.js');await rm(target);
  await symlink(path.join(root,'node_modules/dep/index.js'),target);
  const result=await collectStandalone(root);const file=result.files.find(x=>x.path==='candidate/node_modules/dep/index.js');
  assert.equal(file.source,path.join(root,'node_modules/dep/index.js'));
  const archive=path.join(root,'small.tar.gz');const proof=await writeArchive(archive,result.files);
  assert.equal(proof.integrityReadbackCount,result.files.length);assert.ok(proof.archiveBytes<10000);
});

test('rejects symlink escape and private files',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.next/static'),{recursive:true});
  await symlink(os.tmpdir(),path.join(root,'public/escape'));
  await assert.rejects(collectStandalone(root),/INPUT_SYMLINK_ESCAPES_PROJECT/);
  for(const name of ['candidate/.env.production','candidate/auth.json','candidate/settings.private.json','candidate/../escape',
    'candidate/node_modules/@next/swc-darwin-arm64/package.json'])assert.throws(()=>safePackagePath(name));
});

test('rejects native Mac and mismatched Linux addons',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.next/static'),{recursive:true});
  const addon='.next/standalone/node_modules/dep/addon.node';
  await put(root,addon,Buffer.from('cffaedfe00000000','hex'));
  await assert.rejects(collectStandalone(root),/MACH_O/);
  const elf=Buffer.alloc(20);elf.write('\x7fELF',0,'binary');elf[5]=1;elf.writeUInt16LE(183,18);
  await put(root,addon,elf);await assert.rejects(collectStandalone(root,{arch:'x64'}),/ARCHITECTURE_MISMATCH/);
  elf.writeUInt16LE(62,18);await put(root,addon,elf);
  assert.equal((await collectStandalone(root,{arch:'x64'})).nativeFiles,1);
});

test('archive readback covers UTF-8 long paths and executable modes, and refuses overwrite',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.next/static'),{recursive:true});
  const long='public/'+('á'.repeat(70))+'.txt';await put(root,long,'long-path-content');
  await chmod(path.join(root,'dist/automation-worker.mjs'),0o755);
  const result=await collectStandalone(root),archive=path.join(root,'small.tar.gz');
  const proof=await writeArchive(archive,result.files,{epoch:123});
  assert.equal(proof.integrityReadbackCount,result.files.length);
  assert.equal(result.files.find(x=>x.path==='candidate/automation-worker.mjs').mode,0o755);
  assert.equal((await digest(archive)).length,64);
  await assert.rejects(writeArchive(archive,result.files),/ARCHIVE_WRITE_OR_READBACK_FAILED/);
});

test('modified sources and compressed size overflow never publish a final archive',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.next/static'),{recursive:true});
  const result=await collectStandalone(root);await put(root,'public/icon.txt','changed');
  const changed=path.join(root,'changed.tar.gz');await assert.rejects(writeArchive(changed,result.files),/ARCHIVE_WRITE_OR_READBACK_FAILED/);
  await assert.rejects(lstat(changed),{code:'ENOENT'});
  const fresh=await collectStandalone(root);const limited=path.join(root,'limited.tar.gz');
  await assert.rejects(writeArchive(limited,fresh.files,{maxArchiveBytes:8}),/ARCHIVE_WRITE_OR_READBACK_FAILED/);
  await assert.rejects(lstat(limited),{code:'ENOENT'});
  assert.ok(LIMITS.archiveBytes<LIMITS.artifactBytes);
});

test('Linux package binds the clean commit, manifest, checksums and modes; other hosts refuse',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.next/static'),{recursive:true});
  const output=path.join(root,'packaged');
  if(process.platform!=='linux'){
    await assert.rejects(packageStandalone({root,output,sha:'a'.repeat(40),repository:'example/project'}),/LINUX_BUILD_REQUIRED/);
    await assert.rejects(lstat(output),{code:'ENOENT'});return;
  }
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');git('add','.');git('-c','user.name=Synthetic test','-c','user.email=test@example.invalid','commit','-qm','synthetic fixture','--no-gpg-sign');
  const sha=git('rev-parse','HEAD'),result=await packageStandalone({root,output,sha,repository:'example/project'});
  const manifest=JSON.parse(await readFile(path.join(output,result.manifest),'utf8'));
  assert.equal(manifest.head,sha);assert.equal(manifest.candidateSha,sha);
  assert.equal(manifest.integrityReadbackCount,manifest.fileCount);
  assert.equal(manifest.archiveSha256,await digest(path.join(output,result.archive)));
  assert.ok(manifest.files.every(x=>Number.isSafeInteger(x.mode)&&!('source'in x)));
  assert.equal(manifest.payloadBytes,manifest.files.reduce((n,x)=>n+x.bytes,0));
  assert.ok(!JSON.stringify(manifest).includes(root));
  const checksums=await readFile(path.join(output,'SHA256SUMS'),'utf8');
  assert.ok(checksums.includes(result.manifestSha256)&&checksums.includes(result.archiveSha256));
});
