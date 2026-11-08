#!/usr/bin/env python3
"""Capture one pinned Codex request against a loopback-only fictional provider.

No real authentication or model endpoint is used. Report metadata only; never
print headers, request input, CLI output or inherited context. This is an
explicit integration probe, not a claim of semantic or deployment acceptance.
"""
import argparse
import importlib.util
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time

EXPECTED_VERSION='codex-cli 0.162.1'
spec=importlib.util.spec_from_file_location('knowledge_codex_config',Path(__file__).resolve().parents[1]/'infra/hetzner/knowledge-codex-config.py')
settings=importlib.util.module_from_spec(spec);spec.loader.exec_module(settings)


def probe(binary,model,app_server=False):
    binary=Path(binary)
    if not binary.is_absolute() or not binary.is_file():raise ValueError('ABSOLUTE_CODEX_BINARY_REQUIRED')
    with tempfile.TemporaryDirectory(prefix='aibrain-codex-isolation-') as temporary:
        root=Path(temporary);home=root/'home';work=root/'work'
        home.mkdir(mode=0o700);work.mkdir(mode=0o700)
        catalog_path=root/'models.json'
        catalog_path.write_text(json.dumps(settings.catalog(model)))
        # This process has its own intended HOME/CODEX_HOME. The calling shell's
        # environment and every existing user home remain unchanged.
        env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'HOME':str(home),'CODEX_HOME':str(home),
            'AIBRAIN_KNOWLEDGE_FIXTURE_TOKEN':'fictional-not-a-real-key'}
        version=subprocess.run([str(binary),'--version'],env=env,capture_output=True,timeout=5).stdout.decode().strip()
        if version!=EXPECTED_VERSION:return {'versionMatches':False,'requestObserved':False,'modelOnlyRequest':False}
        captures=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                self.connection.settimeout(2)
                try:
                    size=int(self.headers.get('Content-Length','0'))
                    if not 0<size<=1024*1024:raise ValueError()
                    value=json.loads(self.rfile.read(size))
                    tools=value.get('tools',[])
                    captures.append({'pathMatches':self.path=='/v1/responses',
                        'tools':[{'type':t.get('type'),'name':t.get('name')} for t in tools],
                        'modelMatches':value.get('model')==model,
                        'emptyTools':isinstance(tools,list) and not tools})
                    # Intentionally end the request before any generation. Never
                    # relay to a real provider, log the payload or return tools.
                    self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
                    self.wfile.write(b'{"error":{"message":"Fictional capture complete","type":"invalid_request_error"}}')
                except (ValueError,TypeError,KeyError,OSError):
                    self.close_connection=True
        server=http.server.HTTPServer(('127.0.0.1',0),Handler)
        env.update({'HTTP_PROXY':f'http://127.0.0.1:{server.server_port}',
            'HTTPS_PROXY':f'http://127.0.0.1:{server.server_port}', 'NO_PROXY':'127.0.0.1,localhost'})
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        values={**settings.config(catalog_path),'chatgpt_base_url':f'http://127.0.0.1:{server.server_port}',
            'model_provider':'fixture','model_providers.fixture.name':'Fixture',
            'model_providers.fixture.base_url':f'http://127.0.0.1:{server.server_port}/v1',
            'model_providers.fixture.env_key':'AIBRAIN_KNOWLEDGE_FIXTURE_TOKEN',
            'model_providers.fixture.wire_api':'responses','model_providers.fixture.request_max_retries':0,
            'model_providers.fixture.stream_max_retries':0,'model_providers.fixture.supports_websockets':False}
        command=[str(binary),'exec','--ignore-user-config','--ephemeral','--skip-git-repo-check',
            '--json','--sandbox','read-only','-C',str(work),'-m',model]
        for key,value in values.items():command+=['-c',key+'='+json.dumps(value)]
        command+=['Summarize only this fictional sentence: the fictional office opens on Mondays.']
        if app_server:
            values={k:v for k,v in values.items() if not k.startswith('model_providers.knowledge_codex.')}
            values={k.replace('model_providers.fixture.', 'model_providers.knowledge_codex.'):v for k,v in values.items()}
            values['model_provider']='knowledge_codex'
            command=[str(binary),'app-server','--strict-config']
            for key,value in values.items():command+=['-c',key+'='+json.dumps(value)]
        process=None;timed_out=False
        try:
            process=subprocess.Popen(command,env=env,stdin=subprocess.PIPE if app_server else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
            try:
                if app_server:
                    spec=importlib.util.spec_from_file_location('probe_adapter',Path(__file__).resolve().parents[1]/'infra/hetzner/knowledge-codex-adapter.py')
                    adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
                    # Fictional JWT, only used in this fresh process. Never a real login.
                    import base64
                    payload=base64.urlsafe_b64encode(json.dumps({'exp':4102444800,'email':'fixture@example.invalid'}).encode()).decode().rstrip('=')
                    login={'type':'chatgptAuthTokens','accessToken':'e30.'+payload+'.fictional','chatgptAccountId':'fixture-account'}
                    request={'schemaVersion':1,'stage':'part:fixture','system':'Summarize only the fictional data. Return JSON.',
                        'data':{'unit':'The fictional office opens Mondays.'},'maxOutputBytes':65536}
                    try:adapter.exchange(process,request,login,time.monotonic()+25)
                    except (ValueError,OSError,KeyError):pass  # Capture endpoint intentionally returns 400.
                    if process.poll() is None:os.killpg(process.pid,signal.SIGKILL)
                    stdout,_=process.communicate(timeout=5)
                else:stdout,_=process.communicate(timeout=25)
            except subprocess.TimeoutExpired:
                timed_out=True;os.killpg(process.pid,signal.SIGKILL);stdout,_=process.communicate()
            # Only expose booleans for diagnostic messages. The raw output can
            # include ambient context and must not become the probe's report.
            return {'version':EXPECTED_VERSION,'transport':'app-server' if app_server else 'exec','versionMatches':True,'requestObserved':bool(captures),
                'requests':captures,'modelOnlyRequest':len(captures)==1 and captures[0]['pathMatches'] and captures[0]['emptyTools'] and captures[0]['modelMatches'],
                'timedOut':timed_out,'metadataFallback':b'Model metadata for' in stdout,
                'skillsContextWarning':b'Skill descriptions were shortened' in stdout,
                'providerGenerationPerformed':False,'semanticAcceptance':False}
        finally:
            if process and process.poll() is None:
                os.killpg(process.pid,signal.SIGKILL);process.wait()
            if process:
                if process.stdin:process.stdin.close()
                if process.stdout:process.stdout.close()
            server.shutdown();server.server_close();thread.join(timeout=3)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex-bin',required=True)
    parser.add_argument('--model',default=settings.MODEL)
    parser.add_argument('--app-server',action='store_true',help='Probe the adapter RPC flow instead of exec')
    args=parser.parse_args()
    try:result=probe(args.codex_bin,args.model,args.app_server)
    except (ValueError,OSError,subprocess.SubprocessError):
        result={'probeFailed':True,'modelOnlyRequest':False}
    print(json.dumps(result))
    raise SystemExit(0 if result.get('modelOnlyRequest') and not result.get('metadataFallback') else 2)
