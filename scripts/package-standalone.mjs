#!/usr/bin/env node
// Packages an existing Linux build. Does not install, build, deploy or read credentials.
import {createReadStream} from 'node:fs';
import {lstat, open, readFile, readdir, realpath, mkdir, writeFile, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const LIMITS = Object.freeze({archiveBytes:128*1024**2,payloadBytes:220*1024**2,artifactBytes:150_000_000,files:25000});
const need=(ok,code)=>{if(!ok)throw new Error(code);};
const inside=(root,target)=>{const p=path.relative(root,target);return p===''||(!p.startsWith('..'+path.sep)&&p!=='..'&&!path.isAbsolute(p));};
const posix=p=>p.split(path.sep).join('/');
const fingerprint=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
export async function digest(filename){const h=createHash('sha256');for await(const chunk of createReadStream(filename))h.update(chunk);return h.digest('hex');}

export function safePackagePath(name){
  need(typeof name==='string'&&name.startsWith('candidate/')&&!/[\\\x00-\x1f\x7f]/u.test(name),'PACKAGE_PATH_INVALID');
  const parts=name.split('/');need(!parts.some(x=>x===''||x==='.'||x==='..'),'PACKAGE_PATH_INVALID');
  need(!parts.some(x=>x==='.git'||x==='.DS_Store'||x==='__MACOSX'||x.startsWith('.env')||/\.private(?:\.|$)/i.test(x)
    ||/^(?:auth|credentials|cookies)\.json$/i.test(x)),'PRIVATE_OR_HOST_FILE_IN_PACKAGE');
  need(!/\.(?:dylib|dll|exe)$/i.test(name),'NON_LINUX_BINARY_IN_PACKAGE');
  if(name.startsWith('candidate/node_modules/'))need(!/(?:^|[\/@-])(?:darwin|win32)(?:[-/]|$)/i.test(name),'NON_LINUX_DEPENDENCY_IN_PACKAGE');
}

async function checkNative(filename,name,arch){
  const f=await open(filename,'r');const bytes=Buffer.alloc(20);let count;
  try{({bytesRead:count}=await f.read(bytes,0,bytes.length,0));}finally{await f.close();}
  const magic=count>=4?bytes.subarray(0,4).toString('hex'):'';
  need(!['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic),'MACH_O_BINARY_IN_PACKAGE');
  if(magic==='7f454c46'){
    need(count>=20&&[1,2].includes(bytes[5]),'ELF_HEADER_INVALID');
    const machine=bytes[5]===1?bytes.readUInt16LE(18):bytes.readUInt16BE(18);
    need(machine===({x64:62,arm64:183})[arch],'ELF_ARCHITECTURE_MISMATCH');return true;
  }
  need(!name.endsWith('.node'),'NATIVE_ADDON_NOT_LINUX_ELF');return false;
}

export async function collectStandalone(root,{arch='x64'}={}){
  root=await realpath(root);need(['x64','arm64'].includes(arch),'UNSUPPORTED_ARCHITECTURE');
  const files=new Map();let payloadBytes=0,nativeFiles=0;
  async function walk(source,target,ancestors=new Set()){
    safePackagePath(target);
    const actual=await realpath(source);need(inside(root,actual),'INPUT_SYMLINK_ESCAPES_PROJECT');
    safePackagePath('candidate/'+posix(path.relative(root,actual)));
    const s=await lstat(actual,{bigint:true});
    if(s.isDirectory()){
      need(!ancestors.has(actual),'INPUT_SYMLINK_CYCLE');
      const next=new Set(ancestors).add(actual);
      for(const name of (await readdir(actual)).sort()){
        if(target==='candidate/.next'&&name==='cache')continue;
        await walk(path.join(actual,name),target+'/'+name,next);
      }
      return;
    }
    need(s.isFile()&&s.size<=BigInt(LIMITS.payloadBytes),'INPUT_NOT_REGULAR_OR_TOO_LARGE');
    const record={path:target,source:actual,bytes:Number(s.size),mode:0o644|Number(s.mode&0o111n),sha256:await digest(actual)};
    need(fingerprint(s)===fingerprint(await lstat(actual,{bigint:true})),'INPUT_CHANGED_DURING_HASH');
    if(files.has(target)){
      const previous=files.get(target);need(previous.sha256===record.sha256&&previous.bytes===record.bytes,'OVERLAY_DIFFERS_FROM_BUILD');return;
    }
    if(await checkNative(actual,target,arch))nativeFiles++;
    record.identity=fingerprint(s);
    payloadBytes+=record.bytes;need(payloadBytes<=LIMITS.payloadBytes&&files.size<LIMITS.files,'PACKAGE_PAYLOAD_LIMIT');
    files.set(target,record);
  }
  for(const [source,target] of [['.next/standalone','candidate'],['.next/static','candidate/.next/static'],['public','candidate/public'],['skills','candidate/skills']]){
    if(target==='candidate'){
      const base=path.join(root,source);need((await lstat(base)).isDirectory(),'STANDALONE_BUILD_MISSING');
      for(const name of (await readdir(base)).sort())await walk(path.join(base,name),'candidate/'+name);
    }else await walk(path.join(root,source),target);
  }
  await walk(path.join(root,'dist/automation-worker.mjs'),'candidate/automation-worker.mjs');
  for(const required of ['candidate/server.js','candidate/package.json','candidate/.next/BUILD_ID','candidate/automation-worker.mjs'])need(files.has(required),'REQUIRED_RUNTIME_FILE_MISSING');
  const buildId=(await readFile(path.join(root,'.next/BUILD_ID'),'utf8')).trim();
  need(buildId&&buildId===(await readFile(files.get('candidate/.next/BUILD_ID').source,'utf8')).trim(),'BUILD_ID_MISMATCH');
  const tracing=await verifyTracing(root,files);
  return {files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path,'en')),payloadBytes,buildId,nativeFiles,tracing};
}

export async function verifyTracing(root,files){
  const traces=[path.join(root,'.next/next-server.js.nft.json')];
  async function visit(dir){for(const name of (await readdir(dir)).sort()){
    const filename=path.join(dir,name),s=await lstat(filename);
    need(!s.isSymbolicLink(),'TRACE_SYMLINK_NOT_ALLOWED');
    if(s.isDirectory())await visit(filename);else if(name.endsWith('.nft.json'))traces.push(filename);
  }}
  await visit(path.join(root,'.next/server'));
  need(traces.length>1,'ROUTE_TRACES_MISSING');
  const checked=new Set();let directories=0;
  for(const trace of traces){
    const data=await readFile(trace);need(data.length<=8*1024**2,'TRACE_TOO_LARGE');
    const value=JSON.parse(data);need(Array.isArray(value.files),'TRACE_FILES_INVALID');
    need(!value.additionalRoots?.length,'TRACE_ADDITIONAL_ROOTS_NOT_SUPPORTED');
    for(const item of value.files){
      need(typeof item==='string'&&!path.isAbsolute(item),'TRACE_PATH_INVALID');
      const source=path.resolve(path.dirname(trace),item);need(inside(root,source),'TRACED_FILE_OUTSIDE_PROJECT');
      const actual=await realpath(source);need(inside(root,actual),'TRACED_SYMLINK_OUTSIDE_PROJECT');
      const target='candidate/'+posix(path.relative(root,source));safePackagePath(target);
      const s=await stat(actual);
      if(s.isDirectory()){
        need([...files.keys()].some(name=>name.startsWith(target+'/')),'TRACED_DIRECTORY_MISSING');directories++;continue;
      }
      need(s.isFile()&&files.has(target),'TRACED_FILE_MISSING:'+target);
      if(!checked.has(target)){
        const packed=files.get(target);need(packed.bytes===s.size&&packed.sha256===await digest(actual),'TRACED_FILE_DIFFERS:'+target);checked.add(target);
      }
    }
  }
  return {traceCount:traces.length,verifiedFiles:checked.size,directoryReferences:directories};
}

// Python's standard tarfile handles long/UTF-8 PAX paths. It streams inputs,
// writes regular entries only and verifies every entry before publishing a file.
const ARCHIVE_PYTHON=String.raw`
import gzip,hashlib,json,os,pathlib,stat,sys,tarfile
p=json.load(sys.stdin);out=pathlib.Path(p['archive']);temporary=out.with_suffix(out.suffix+'.partial')
assert not out.exists() and not temporary.exists()
class LimitedWriter:
 def __init__(self,stream):self.stream=stream;self.count=0
 def write(self,data):
  assert self.count+len(data)<=p['maxArchiveBytes'],'ARCHIVE_SIZE_LIMIT'
  n=self.stream.write(data);self.count+=n;return n
 def flush(self):self.stream.flush()
with open(temporary,'xb') as stream:
 os.chmod(temporary,0o600)
 with gzip.GzipFile(filename='',mode='wb',fileobj=LimitedWriter(stream),mtime=0) as zipped:
  with tarfile.open(fileobj=zipped,mode='w|',format=tarfile.PAX_FORMAT) as archive:
   for row in p['files']:
    fd=os.open(row['source'],os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as source:
     s=os.fstat(source.fileno());identity=':'.join(str(x) for x in [s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns])
     assert stat.S_ISREG(s.st_mode) and identity==row['identity'],'SOURCE_CHANGED'
     h=hashlib.sha256()
     class Reader:
      def read(self,n=-1):
       value=source.read(n);h.update(value);return value
     item=tarfile.TarInfo(row['path']);item.size=row['bytes'];item.mode=row['mode'];item.mtime=p['epoch'];item.uid=item.gid=0
     archive.addfile(item,Reader());assert h.hexdigest()==row['sha256'],'SOURCE_HASH_CHANGED'
expected={r['path']:r for r in p['files']};seen=set()
with tarfile.open(temporary,'r:gz') as archive:
 for item in archive:
  assert item.isfile() and item.name in expected and item.name not in seen,'UNEXPECTED_ARCHIVE_ENTRY'
  row=expected[item.name];assert item.size==row['bytes'] and item.mode==row['mode'],'ARCHIVE_METADATA_MISMATCH'
  h=hashlib.sha256()
  with archive.extractfile(item) as data:
   for block in iter(lambda:data.read(1024*1024),b''):h.update(block)
  assert h.hexdigest()==row['sha256'],'ARCHIVE_READBACK_MISMATCH'
  seen.add(item.name)
assert seen==set(expected),'ARCHIVE_INCOMPLETE'
os.rename(temporary,out)
print(json.dumps({'integrityReadbackCount':len(seen),'archiveBytes':out.stat().st_size}))
`;

export async function writeArchive(archive,files,{epoch=0,maxArchiveBytes=LIMITS.archiveBytes}={}){
  return await new Promise((resolve,reject)=>{
    const child=spawn('python3',['-B','-c',ARCHIVE_PYTHON],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr=(stderr+x).slice(-4000);});
    child.on('error',reject);child.stdin.on('error',()=>{});
    child.on('close',code=>{try{need(code===0,'ARCHIVE_WRITE_OR_READBACK_FAILED');resolve(JSON.parse(stdout));}catch(e){reject(new Error(e.message,{cause:stderr}));}});
    child.stdin.end(JSON.stringify({archive,files,epoch,maxArchiveBytes}));
  });
}

export async function packageStandalone({root=process.cwd(),output,sha,repository,arch=process.arch}){
  need(process.platform==='linux','LINUX_BUILD_REQUIRED');
  need(/^[a-f0-9]{40}$/.test(sha??''),'EXACT_CANDIDATE_SHA_REQUIRED');
  need(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository??''),'REPOSITORY_REQUIRED');
  root=await realpath(root);output=path.resolve(output);
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  need(git('rev-parse','HEAD')===sha&&!git('status','--porcelain'),'CLEAN_EXACT_SOURCE_REQUIRED');
  const epoch=Number(git('show','-s','--format=%ct','HEAD'));need(Number.isSafeInteger(epoch)&&epoch>0,'COMMIT_EPOCH_INVALID');
  const bundle=await collectStandalone(root,{arch});
  await mkdir(output,{mode:0o700}); // Existing output refuses a second package in this run.
  const archiveName=`candidate-${sha}-linux-${arch}.tar.gz`,manifestName=`candidate-${sha}-manifest.json`;
  const archive=path.join(output,archiveName),readback=await writeArchive(archive,bundle.files,{epoch});
  const manifest={schemaVersion:1,createdAt:new Date().toISOString(),head:sha,candidateSha:sha,repo:repository,
    remote:`https://github.com/${repository}.git`,buildId:bundle.buildId,platform:'linux',architecture:arch,nodeVersion:process.version,
    archive:archiveName,archiveBytes:readback.archiveBytes,archiveSha256:await digest(archive),payloadBytes:bundle.payloadBytes,
    fileCount:bundle.files.length,integrityReadbackCount:readback.integrityReadbackCount,tracing:bundle.tracing,
    nativeFilesVerified:bundle.nativeFiles,files:bundle.files.map(({path,bytes,sha256,mode})=>({path,bytes,sha256,mode}))};
  const manifestBytes=JSON.stringify(manifest,null,2)+'\n';
  need(manifest.archiveBytes+Buffer.byteLength(manifestBytes)+1024<LIMITS.artifactBytes,'ARTIFACT_SIZE_LIMIT');
  await writeFile(path.join(output,manifestName),manifestBytes,{flag:'wx',mode:0o600});
  const manifestSha=createHash('sha256').update(manifestBytes).digest('hex');
  await writeFile(path.join(output,'SHA256SUMS'),`${manifest.archiveSha256}  ${archiveName}\n${manifestSha}  ${manifestName}\n`,{flag:'wx',mode:0o600});
  return {head:sha,archive:archiveName,archiveBytes:manifest.archiveBytes,archiveSha256:manifest.archiveSha256,manifest:manifestName,
    manifestSha256:manifestSha,payloadBytes:manifest.payloadBytes,fileCount:manifest.fileCount,integrityReadbackCount:manifest.integrityReadbackCount,tracing:manifest.tracing};
}

async function main(){
  const args=process.argv.slice(2),options={repository:process.env.GITHUB_REPOSITORY};
  for(let i=0;i<args.length;i+=2){need(['--sha','--output','--repository'].includes(args[i])&&args[i+1],'USAGE: --sha SHA40 --output DIRECTORY [--repository OWNER/REPO]');options[args[i].slice(2)]=args[i+1];}
  need(options.output,'OUTPUT_DIRECTORY_REQUIRED');console.log(JSON.stringify(await packageStandalone(options)));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
