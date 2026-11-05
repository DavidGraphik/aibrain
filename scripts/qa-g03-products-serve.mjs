/** Synthetic local QA only. Never provisions a customer or starts a real model. */
import {readFile,access,symlink} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve(process.argv[2]??'/tmp/g03-products-local-qa');
if(!root.startsWith('/tmp/')&&!root.startsWith('/private/tmp/'))throw Error('QA root must be temporary');
const config=JSON.parse(await readFile(path.join(root,'installation.json'),'utf8'));
if(config.installationId!=='g03-qa'||config.publicUrl!=='http://localhost:3199')throw Error('Synthetic local configuration required');
const standalone=path.resolve('.next/standalone');
for(const [target,source]of [[path.join(standalone,'public'),path.resolve('public')],[path.join(standalone,'.next/static'),path.resolve('.next/static')]]){
 try{await access(target);}catch(error){if(error.code!=='ENOENT')throw error;await symlink(source,target,'dir');}
}
const child=spawn(process.execPath,[path.join(standalone,'server.js')],{stdio:'inherit',env:{...process.env,AIBRAIN_INSTALLATION_CONFIG:path.join(root,'installation.json'),AIBRAIN_G03_PRODUCT_POLICY:path.join(root,'policy.json'),AIBRAIN_AUTH_MODE:'supabase',AIBRAIN_SESSION_SECRET:(await readFile(path.join(root,'session-secret'),'utf8')).trim(),CHAT_RUNTIME:'codex',CODEX_BIN:'/usr/bin/false',PORT:'3199',HOSTNAME:'127.0.0.1'}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{process.exitCode=code??1;});
