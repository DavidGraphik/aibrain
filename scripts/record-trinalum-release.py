"""CI-only portable layer inventory, bound to the immutable published digests."""
import importlib.util,json,os,pathlib,subprocess,re,tarfile,gzip,hashlib,tempfile
root=pathlib.Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('prefetch',root/'deployments/trinalum/prefetch-owner-images.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class PrefixedReader:
    def __init__(self,prefix,stream):self.prefix=prefix;self.stream=stream
    def read(self,size=-1):
        if size<0:
            result=self.prefix+self.stream.read();self.prefix=b'';return result
        result=self.prefix[:size];self.prefix=self.prefix[len(result):]
        return result+self.stream.read(size-len(result)) if len(result)<size else result

class MeasuredReader:
    def __init__(self,stream):self.stream=stream;self.digest=hashlib.sha256();self.length=0
    def read(self,size=-1):
        block=self.stream.read(size);self.digest.update(block);self.length+=len(block)
        if self.length>16*1024**3:raise RuntimeError('Layer exceeds bounded image size')
        return block

def allocation_from_tar(source):
    # Account for data blocks, inodes, directory entries and implicit parents.
    # Never equate canonical tar padding with actual filesystem allocation.
    allocation=0;parents=set();regular={};links=[];aliases={};valid=True
    try:
        with tarfile.open(fileobj=source,mode='r|') as layer:
            for entry in layer:
                name=pathlib.PurePosixPath(entry.name)
                if name.is_absolute() or '..' in name.parts:raise RuntimeError('Unsafe layer member')
                parents.update(str(p) for p in name.parents if str(p)!='.')
                if entry.size<0 or entry.size>16*1024**3:raise RuntimeError('Invalid layer member size')
                if sum(len(k.encode('utf8','surrogateescape'))+len(v.encode('utf8','surrogateescape')) for k,v in entry.pax_headers.items())>4096:
                    raise RuntimeError('Layer extended metadata exceeds allocation contract')
                allocation+=8192
                if entry.isfile():
                    allocation+=((entry.size+4095)//4096)*4096;regular[str(name)]=entry.size
                elif entry.islnk():
                    target=str(pathlib.PurePosixPath(entry.linkname.lstrip('/')))
                    links.append(target);aliases[str(name)]=target
                elif not (entry.isdir() or entry.issym() or entry.isdev() or entry.isfifo()):
                    raise RuntimeError('Unsupported layer member type')
    except tarfile.ReadError:valid=False
    while source.read(1024*1024):pass
    return {'baseAllocation':allocation+8192*len(parents),'regular':regular,'links':links,'aliases':aliases,'valid':valid}

def layers_from_archive(stream,wanted,with_allocation=False):
    found={}
    with tarfile.open(fileobj=stream,mode='r|') as archive:
        for member in archive:
            if not member.isfile():continue
            raw=archive.extractfile(member);prefix=raw.read(2)
            source=PrefixedReader(prefix,raw)
            if prefix==b'\x1f\x8b':source=gzip.GzipFile(fileobj=source)
            measured=MeasuredReader(source)
            sizing=allocation_from_tar(measured) if with_allocation else None
            if not with_allocation:
                while measured.read(1024*1024):pass
            length=measured.length;diff='sha256:'+measured.digest.hexdigest()
            if diff in wanted:
                if with_allocation and not sizing['valid']:raise RuntimeError('RootFS layer is not a valid tar')
                item={'unpackedBytes':length,**sizing} if with_allocation else length
                if diff in found and found[diff]!=item:raise RuntimeError('Conflicting canonical layer')
                found[diff]=item
    if set(found)!=set(wanted):raise RuntimeError('Canonical saved layers do not match every RootFS diff ID')
    return found

def portable_layers(image,inspection,with_allocation=False):
    ids=inspection['RootFS']['Layers']
    # Export the inspected local platform image, rather than the registry index
    # (which may also reference unattached attestations or unpulled platforms).
    if inspection.get('Os')!='linux' or inspection.get('Architecture')!='amd64' or not re.fullmatch('sha256:[0-9a-f]{64}',inspection.get('Id','')):
        raise RuntimeError('Exact local amd64 image required for canonical export')
    error_stream=tempfile.TemporaryFile()
    process=subprocess.Popen(['docker','image','save','--platform=linux/amd64',inspection['Id']],stdout=subprocess.PIPE,stderr=error_stream)
    try:
        try:lengths=layers_from_archive(process.stdout,set(ids),with_allocation=with_allocation)
        except Exception as error:
            if process.poll() is None:process.terminate()
            process.wait(timeout=30)
            error_stream.seek(0)
            diagnostic=error_stream.read(2048).decode('utf8','replace').strip()
            raise RuntimeError('Canonical Docker export failed: '+diagnostic) from error
        # Drain tar padding before closing the pipe; do not interrupt Docker.
        while process.stdout.read(1024*1024):pass
        if process.wait(timeout=30)!=0:
            error_stream.seek(0)
            raise RuntimeError('Docker image export failed: '+error_stream.read(2048).decode('utf8','replace').strip())
        if not with_allocation:return [{'diffId':diff,'unpackedBytes':lengths[diff]} for diff in ids]
        maximum=max((n for sizing in lengths.values() for n in sizing['regular'].values()),default=0)
        targets={};aliases={}
        for sizing in lengths.values():
            for name,size in sizing['regular'].items():targets[name]=max(size,targets.get(name,0))
            for name,target in sizing.get('aliases',{}).items():aliases.setdefault(name,set()).add(target)
        def link_bound(target,seen=frozenset()):
            if target in seen:return maximum
            candidates=[targets[target]] if target in targets else []
            candidates.extend(link_bound(alias,seen|{target}) for alias in aliases.get(target,[]))
            return max(candidates,default=maximum)
        return [{'diffId':diff,'unpackedBytes':lengths[diff]['unpackedBytes'],
                 # Reserve a full copy per hard link, even though normal
                 # extraction shares its inode. Resolve every possible image
                 # version of its target; unknown/cyclic aliases use the
                 # largest regular file in the whole image.
                 'allocationBytes':max(4096,lengths[diff]['baseAllocation']+sum(((link_bound(target)+4095)//4096)*4096 for target in lengths[diff]['links']))} for diff in ids]
    finally:
        if process.poll() is None:process.terminate();process.wait()
        process.stdout.close();error_stream.close()

def registry_manifest(image):
    manifest=json.loads(module.command('docker','buildx','imagetools','inspect',image,'--raw',timeout=120))
    if 'manifests' in manifest:
        choices=[x for x in manifest['manifests'] if x.get('platform',{}).get('os')=='linux' and x['platform'].get('architecture')=='amd64']
        if len(choices)!=1 or not re.fullmatch('sha256:[0-9a-f]{64}',choices[0]['digest']): raise RuntimeError('Unique immutable amd64 manifest required')
        manifest=json.loads(module.command('docker','buildx','imagetools','inspect',image.split('@')[0]+'@'+choices[0]['digest'],'--raw',timeout=120))
    return manifest

def record():
    value={'schemaVersion':4,'revision':os.environ['RELEASE_SHA']}
    for key,repo,digest in [('image','APP_REPOSITORY','APP_DIGEST'),('egressImage','EGRESS_REPOSITORY','EGRESS_DIGEST')]:
        image=os.environ[repo]+'@'+os.environ[digest]
        inspection=json.loads(module.command('docker','image','inspect',image,timeout=30))[0]
        labels=inspection['Config'].get('Labels',{})
        if labels.get('org.opencontainers.image.source')!=module.SOURCE or labels.get('org.opencontainers.image.revision')!=value['revision']: raise RuntimeError('Image identity mismatch')
        layers=portable_layers(image,inspection,with_allocation=True)
        compressed=registry_manifest(image)['layers']
        if len(layers)!=len(compressed): raise RuntimeError('Registry and local layer count differ')
        for layer,descriptor in zip(layers,compressed):
            if type(descriptor.get('size')) is not int or descriptor['size']<=0: raise RuntimeError('Invalid registry layer size')
            layer['compressedBytes']=descriptor['size']
        value.update({key:image,key+'Bytes':sum(x['unpackedBytes'] for x in layers),key+'Layers':layers})
    module.validate({**value,'token':'validation-placeholder-token-123'})
    encoded=json.dumps(value)
    if len(encoded.encode())+4096>32768: raise RuntimeError('Layer inventory exceeds transport limit')
    target=root/'release.json';target.write_text(encoded);target.chmod(0o600)

if __name__=='__main__':record()
