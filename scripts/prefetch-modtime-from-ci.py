"""CI-only package transport using an ephemeral repository token and forced-command key."""
import json, os, pathlib, re, subprocess, tempfile

def main():
    release=json.loads(pathlib.Path('release.json').read_text())
    if release['revision']!=os.environ['RELEASE_SHA']: raise RuntimeError('MODTIME_RELEASE_MISMATCH')
    with tempfile.TemporaryDirectory(prefix='modtime-ci-prefetch-') as directory:
        root=pathlib.Path(directory); key=root/'key'; hosts=root/'known_hosts'
        key.write_text(os.environ['MODTIME_PREFETCH_SSH_KEY'].strip()+'\n');key.chmod(0o600)
        hosts.write_text(os.environ['MODTIME_PREFETCH_KNOWN_HOSTS'].strip()+'\n');hosts.chmod(0o600)
        result=subprocess.run(['ssh','-T','-i',str(key),'-o','IdentitiesOnly=yes','-o','BatchMode=yes',
            '-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(hosts),'-o','ConnectTimeout=20',
            'root@46.62.215.84','modtime-image-prefetch-v1'],
            input=json.dumps({**release,'token':os.environ['GH_TOKEN']}),text=True,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=1900)
        expected='MODTIME_OWNER_IMAGES_CACHED revision='+release['revision']
        if result.returncode or result.stdout.strip()!=expected:
            # Only fixed diagnostic categories, never SSH/provider output or credentials.
            for marker,code in [('error in libcrypto','KEY_FORMAT'),('Permission denied','SSH_AUTH'),('Host key verification failed','HOST_IDENTITY'),('Connection timed out','NETWORK_TIMEOUT')]:
                if marker in result.stderr: print('MODTIME_PREFETCH_DIAGNOSTIC_'+code)
            if re.fullmatch(r'MODTIME_(?:PREFETCH_[A-Z_]+|OWNER_IMAGES_CACHED revision=[0-9a-f]{40})',result.stdout.strip()):
                print('MODTIME_REMOTE_FAILURE='+result.stdout.strip())
            raise RuntimeError('MODTIME_CI_PREFETCH_FAILED')
        print(expected)

if __name__=='__main__':
    try: main()
    except Exception:
        print('MODTIME_CI_PREFETCH_FAILED');raise SystemExit(1)
