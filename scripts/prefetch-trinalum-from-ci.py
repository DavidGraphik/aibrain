"""CI-only package transport using an ephemeral repository token and forced-command key."""
import json, os, pathlib, subprocess, tempfile

def main():
    release=json.loads(pathlib.Path('release.json').read_text())
    if release['revision']!=os.environ['RELEASE_SHA']: raise RuntimeError('TRINALUM_RELEASE_MISMATCH')
    with tempfile.TemporaryDirectory(prefix='trinalum-production-ci-prefetch-') as directory:
        root=pathlib.Path(directory); key=root/'key'; hosts=root/'known_hosts'
        key.write_text(os.environ['TRINALUM_PREFETCH_SSH_KEY'].strip()+'\n');key.chmod(0o600)
        hosts.write_text(os.environ['TRINALUM_PREFETCH_KNOWN_HOSTS'].strip()+'\n');hosts.chmod(0o600)
        result=subprocess.run(['ssh','-T','-i',str(key),'-o','IdentitiesOnly=yes','-o','BatchMode=yes',
            '-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(hosts),'-o','ConnectTimeout=20',
            'root@167.233.199.11','trinalum-production-image-prefetch-v1'],
            input=json.dumps({**release,'token':os.environ['GH_TOKEN']}),text=True,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=1900)
        expected='TRINALUM_OWNER_IMAGES_CACHED revision='+release['revision']
        if result.returncode or result.stdout.strip()!=expected:
            import re
            safe=result.stdout.strip()
            if re.fullmatch('TRINALUM_[A-Z_]+',safe): print(safe)
            print('TRINALUM_CI_PREFETCH_EXIT='+str(result.returncode))
            for signature in ['error in libcrypto','Permission denied','Host key verification failed','Connection timed out','No route to host']:
                if signature in result.stderr: print('TRINALUM_SSH_FAILURE='+signature)
            raise RuntimeError('TRINALUM_CI_PREFETCH_FAILED')
        print(expected)

if __name__=='__main__':
    try: main()
    except Exception:
        print('TRINALUM_CI_PREFETCH_FAILED');raise SystemExit(1)
