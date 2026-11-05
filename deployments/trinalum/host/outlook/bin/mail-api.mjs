#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {outlookConfig} from '../lib/config.mjs';
import {OutlookStore} from '../lib/store.mjs';
import {ImapSmtpClient} from '../lib/imap-smtp-client.mjs';
import {MailApi} from '../lib/mail-api.mjs';
import {createHash} from 'node:crypto';

// A private host wrapper supplies provider environment and binds mailbox/actor.
// The model never receives credentials or chooses an approving identity.
const command=process.argv[2],args={};let store;
try{
 for(let index=3;index<process.argv.length;index+=2){const name=process.argv[index],value=process.argv[index+1];if(!name.startsWith('--')||!value||value.startsWith('--')||args[name.slice(2)]!=null)throw Error('Expected unique --name value arguments');args[name.slice(2)]=value;}
 for(const name of Object.keys(args))if(!['mailbox','actor','action-id','input','json','confirmed-hash','search-context'].includes(name))throw Error(`Unsupported argument: ${name}`);
 if(args['search-context']&&(command!=='read'||args['search-context'].length>50000))throw Error('Search context is only allowed for bounded reads');
 const config=outlookConfig();if(config.provider!=='imap_smtp')throw Error('This mail API requires the connected IMAP/SMTP provider');
 store=new OutlookStore(join(config.dataDirectory,'outlook.sqlite'));const api=new MailApi({config,store,client:new ImapSmtpClient(config,store)});
 const mailbox=String(args.mailbox??'').toLowerCase(),actor=args.actor;let result;
 if(command==='read'||command==='prepare'){if(Boolean(args.input)===Boolean(args.json))throw Error('Exactly one --input FILE or --json JSON is required');if(args.json&&command!=='read')throw Error('--json is only allowed for bounded reads');const bytes=args.json?Buffer.from(args.json):await readFile(args.input);if(bytes.length>(args.json?128*1024:45*1024*1024))throw Error('Mail input exceeds transfer limit');const input=JSON.parse(bytes);result=command==='read'?await api.read(mailbox,input,{searchContext:args['search-context']?JSON.parse(args['search-context']):null}):await api.prepare(mailbox,actor,args['action-id'],input);}
 else if(command==='show')result=await api.show(mailbox,actor,args['action-id']);
 else if(command==='execute')result=await api.execute(mailbox,actor,args['action-id'],args['confirmed-hash']);
 else throw Error('Usage: mail-api.mjs read|prepare|show|execute --mailbox ADDRESS [--actor OWNER --action-id ID] [--input FILE|--json JSON] [--confirmed-hash HASH]');
 if(command==='prepare'){
  const {value}=await api.prepared(mailbox,actor,args['action-id']);
  const raw=value.frozen.archiveBase64??value.frozen.rawBase64;
  if(raw){const bytes=Buffer.from(raw,'base64');result.original={kind:'file',filename:`correo-${args['action-id'].slice(-12)}.eml`,mimeType:'message/rfc822',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content_base64:raw};}
 }
 console.log(JSON.stringify(result));
}catch(error){console.error(JSON.stringify({status:'error',code:error.code??'MAIL_API_ERROR',message:error.publicMessage??error.message}));process.exitCode=1;}finally{store?.close();}
