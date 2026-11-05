import {registrationCoverage,registrationPageFromCli} from './registration-coverage.mjs';
import {createAudioTranscriber,authorizeAudio} from './audio-transcription.mjs';
import {summaryOptions} from './order-summary.mjs';
import {orderLookupOptions} from './order-lookup.mjs';
import {salesCustomersOptions} from './sales-customers.mjs';
import {sibemaProposalReference,resolveSibemaProposal} from './sibema-proposal-reference.mjs';
import {qaOrderScope,assertQaOrderIdentity} from './qa-order-scope.mjs';
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, lstat, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const execute = promisify(execFile);
const mailboxByOwner = Object.freeze({trini:'manager@example.invalid',miguel:'sales@example.invalid',nerea:'administration@example.invalid'});
const allowedKeys = {mail_search:['query','limit','freshness','attachmentMime'],mail_read:['messageId'],mail_api:['input'],attio_api:['command','query','method','path','request'],sibema_api:['command','method','path','query','body','references'],attio_search:['query','limit'],attio_notes:['recordId','object'],attio_deals:[],attio_tasks:[],attio_members:[],sibema_read:['path'],sibema_accounting_summary:['from','to']};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!v.includes('\0');
const writeTypes={attio_action:new Set(['api_request','create_person','create_company','create_note','create_task','update_task','delete_task','create_deal','update_deal','update_company','update_person']),sibema_action:new Set(['api_request','create_customer','append_customer_note','create_customer_tariff','update_customer_tariff','delete_customer_tariff','delete_offer','create_offer','update_offer','attach_offer_pdf','attach_order_pdf','remove_order_pdf','convert_offer_to_order','update_order_status','record_order_delivery','update_order','create_purchase_invoice','update_purchase_invoice_status','validate_accounting_entries','import_accounting_entries']),mail_draft:new Set(['create_draft']),mail_action:new Set(['send_mail','reply','reply_all','forward','send_draft','create_draft','update_draft','remove_attachment','copy_message','archive_message','subscribe_folder','unsubscribe_folder','update_message','move_message','delete_message','permanent_delete_message','add_attachment','create_folder','update_folder','delete_folder'])};
const names={trini:'Trini',miguel:'Miguel',nerea:'Nerea',tristan:'Tristan',david:'David'};
export function actionFor(binding,operation,input,actionId){
  if(binding.installationId!=='trinalum-production'||binding.status!=='active'||!uuid.test(binding.userId)||!binding.operations?.includes(operation)||!names[binding.owner])throw Error('ACCESS_DENIED');
  if(!writeTypes[operation]||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='request,type'||!writeTypes[operation].has(input.type)||!input.request||typeof input.request!=='object'||Array.isArray(input.request)||!/^web-[a-f0-9]{64}$/.test(actionId))throw Error('INVALID_ARGUMENTS');
  if(operation==='sibema_action'&&input.type==='convert_offer_to_order'&&input.request.body?.contractor_id!==1)throw Error('INVALID_ARGUMENTS');
  if(binding.owner==='david'&&operation==='sibema_action'&&!['create_customer','create_offer','update_offer','attach_offer_pdf'].includes(input.type)&&!qaOrderScope(binding,input))throw Error('ACCESS_DENIED');
  if(binding.owner==='tristan'&&operation==='sibema_action'&&!['validate_accounting_entries','import_accounting_entries'].includes(input.type)&&!(input.type==='api_request'&&input.request.method==='POST'&&/^\/accounting\//.test(input.request.path??'')))throw Error('ACCESS_DENIED');
  const action={id:actionId,type:input.type,requestedBy:names[binding.owner],request:input.request};
  if(operation==='mail_draft'||operation==='mail_action'){if(!mailboxByOwner[binding.owner])throw Error('ACCESS_DENIED');action.mailbox=mailboxByOwner[binding.owner];}
  return action;
}

export function commandFor(binding, operation, input, mailSearchContext) {
  if (!(mailboxByOwner[binding.owner] || binding.owner==='tristan'||binding.owner==='david') || !uuid.test(binding.userId) || binding.installationId!=='trinalum-production' || binding.status!=='active' || !binding.operations?.includes(operation)) throw Error('ACCESS_DENIED');
  if (!Object.hasOwn(allowedKeys,operation) || !input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!allowedKeys[operation].includes(k))) throw Error('INVALID_ARGUMENTS');
  const mailbox=mailboxByOwner[binding.owner];
  let searchContextArgs=[];
  if(mailSearchContext!==undefined){
    if(!(operation==='mail_search'||operation==='mail_api'&&input.input?.operation==='search')||!mailSearchContext||typeof mailSearchContext!=='object'||Array.isArray(mailSearchContext)||Object.keys(mailSearchContext).sort().join(',')!=='humanMessage,sourceMessageId'||!text(mailSearchContext.humanMessage,8000)||!text(mailSearchContext.sourceMessageId,160)||!/^[A-Za-z0-9_-]+$/.test(mailSearchContext.sourceMessageId))throw Error('INVALID_ARGUMENTS');
    searchContextArgs=['--search-context',JSON.stringify(mailSearchContext)];
  }
  if(operation==='mail_api'){
    if(!mailbox||!input.input||typeof input.input!=='object'||Array.isArray(input.input)||Buffer.byteLength(JSON.stringify(input.input))>128*1024)throw Error('INVALID_ARGUMENTS');
    if(Object.hasOwn(input.input,'mailSearchContext')||Object.hasOwn(input.input,'searchContext'))throw Error('INVALID_ARGUMENTS');
    return ['/opt/trinalum/bin/trinalum-mail-api',['read','--mailbox',mailbox,'--json',JSON.stringify(input.input),...searchContextArgs]];
  }
  if(operation==='attio_api'){
    if(input.command==='discover'){
      if(input.request!==undefined)throw Error('INVALID_ARGUMENTS');
      const args=['api-discover'];for(const key of ['query','method','path'])if(input[key]!==undefined){if(!text(input[key],500))throw Error('INVALID_ARGUMENTS');args.push('--'+key,input[key]);}
      return ['/opt/trinalum/bin/trinalum-attio-cli',args];
    }
    if(input.command!=='read'||!input.request||typeof input.request!=='object'||Array.isArray(input.request)||Object.keys(input).sort().join(',')!=='command,request'||Buffer.byteLength(JSON.stringify(input.request))>128*1024)throw Error('INVALID_ARGUMENTS');
    return ['/opt/trinalum/bin/trinalum-attio-cli',['api-read','--request',JSON.stringify(input.request)]];
  }
  if(operation==='sibema_api'){
    if(!['discover','schema','read','catalog'].includes(input.command)||Buffer.byteLength(JSON.stringify(input))>128*1024)throw Error('INVALID_ARGUMENTS');
    if(binding.owner==='tristan'&&input.command==='catalog')throw Error('ACCESS_DENIED');
    if(binding.owner==='tristan'&&input.command==='read'&&!/^\/accounting\//.test(input.path??''))throw Error('ACCESS_DENIED');
    const {command,...request}=input;
    const deletionPreview=command==='read'&&/^\/customers\/[1-9]\d*\/(?:tariffs|offers)\/[1-9]\d*\/deletion-preview$/.test(request.path??'');
    return ['/opt/trinalum/bin/trinalum-sibema-api',[command,'--json',JSON.stringify(request),...(deletionPreview?['--actor',names[binding.owner]]:[])]];
  }
  if(operation==='mail_search'||operation==='attio_search') {
    if(operation==='mail_search'&&!mailbox)throw Error('ACCESS_DENIED');
    if(!text(input.query,500)||!(input.limit===undefined||Number.isInteger(input.limit)&&input.limit>=1&&input.limit<=20))throw Error('INVALID_ARGUMENTS');
    if(operation==='mail_search'&&(input.freshness!==undefined&&input.freshness!=='live_received_first'||input.attachmentMime!==undefined&&(!text(input.attachmentMime,128)||/[\r\n]/.test(input.attachmentMime)||! /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(input.attachmentMime))))throw Error('INVALID_ARGUMENTS');
    return operation==='mail_search'
      ? ['/opt/trinalum/bin/trinalum-mail-api',['read','--mailbox',mailbox,'--json',JSON.stringify({operation:'search',query:input.query,limit:input.limit??10,...(input.freshness?{freshness:input.freshness}:{}),...(input.attachmentMime?{attachmentMime:input.attachmentMime}:{})}),...searchContextArgs]]
      : ['/opt/trinalum/bin/trinalum-attio-cli',['client-brief','--query',input.query,'--limit',String(input.limit??10)]];
  }
  if(operation==='mail_read') {
    if(!mailbox)throw Error('ACCESS_DENIED');
    if(!text(input.messageId,512))throw Error('INVALID_ARGUMENTS');
    if(input.messageId.startsWith('imap:'))return ['/opt/trinalum/bin/trinalum-mail-api',['read','--mailbox',mailbox,'--json',JSON.stringify({operation:'read',messageId:input.messageId})]];
    return ['/opt/trinalum/bin/trinalum-mail-read',['--mailbox',mailbox,'--message-id',input.messageId]];
  }
  if(operation==='attio_notes') {
    if(!uuid.test(input.recordId??''))throw Error('INVALID_ARGUMENTS');
    const object=input.object??'companies';if(!['companies','people','deals'].includes(object))throw Error('INVALID_ARGUMENTS');
    return ['/opt/trinalum/bin/trinalum-attio-cli',['notes','--record-id',input.recordId,'--object',object]];
  }
  if(operation==='attio_deals'||operation==='attio_tasks'||operation==='attio_members') {
    return ['/opt/trinalum/bin/trinalum-attio-cli',[operation==='attio_deals'?'deals':operation==='attio_tasks'?'tasks':'members']];
  }
  if(operation==='sibema_read') {
    // Documented read pagination and identity search, with no arbitrary route,
    // contractor override, external host, duplicate query keys or traversal.
    if(!text(input.path,150)||/[#\\]/.test(input.path))throw Error('INVALID_ARGUMENTS');
    if(input.path.startsWith('/order-summary?')){summaryOptions(input.path);return ['/opt/trinalum/bin/trinalum-sibema-order-summary',[input.path]];}
    if(input.path.startsWith('/order-lookup?')){orderLookupOptions(input.path);return ['/opt/trinalum/bin/trinalum-sibema-order-lookup',[input.path]];}
    if(input.path.startsWith('/sales-customers?')){salesCustomersOptions(input.path);return ['/opt/trinalum/bin/trinalum-sibema-sales-customers',[input.path]];}
    const [pathname,query='']=input.path.split('?');
    const customerOrders=/^\/customers\/[1-9]\d*\/orders$/.test(pathname);
    if(input.path.split('?').length>2||(!customerOrders&&!/^\/(?:customers|providers|offers|orders|order-statuses)(?:\/\d+)?$|^\/offers\/\d+\/files$/.test(pathname)))throw Error('INVALID_ARGUMENTS');
    const params=new URLSearchParams(query),seen=new Set();
    for(const [key,value] of params){
      if(seen.has(key))throw Error('INVALID_ARGUMENTS');seen.add(key);
      if(key==='search'&&['/customers','/providers'].includes(pathname)&&text(value,100))continue;
      if(key==='page'&&/^\d{1,5}$/.test(value))continue;
      if(key==='size'&&/^\d{1,3}$/.test(value)&&Number(value)>=1&&Number(value)<=200)continue;
      throw Error('INVALID_ARGUMENTS');
    }
    // The documented scoped order list is also available to the legacy reader.
    // Reuse the schema-backed API adapter with numeric pagination, not guessed
    // /orders IDs or a new provider query. The original sibema_read grant remains
    // mandatory and unknown/duplicate/foreign-scope parameters fail above.
    if(customerOrders)return ['/opt/trinalum/bin/trinalum-sibema-api',['read','--json',JSON.stringify({method:'GET',path:pathname,query:Object.fromEntries([...params].map(([key,value])=>[key,Number(value)]))})]];
    return ['/opt/trinalum/bin/trinalum-sibema-read',['get','--path',input.path]];
  }
  if(operation==='sibema_accounting_summary') {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.from??'')||!/^\d{4}-\d{2}-\d{2}$/.test(input.to??'')||input.from>input.to)throw Error('INVALID_ARGUMENTS');
    return ['/opt/trinalum/bin/trinalum-sibema-read',['accounting-summary','--contractor-id','1','--from',input.from,'--to',input.to]];
  }
  throw Error('UNSUPPORTED_OPERATION');
}

export function authenticate(config, authorization) {
  if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))throw Error('ACCESS_DENIED');
  const token=authorization.slice(7);
  if(token.length<32||token.length>256)throw Error('ACCESS_DENIED');
  const digest=createHash('sha256').update(token).digest();
  const matches=config.bindings.filter(b=>typeof b.tokenSha256==='string'&&/^[a-f0-9]{64}$/.test(b.tokenSha256)&&timingSafeEqual(digest,Buffer.from(b.tokenSha256,'hex')));
  if(matches.length!==1)throw Error('ACCESS_DENIED');
  return matches[0];
}

function sanitize(value) {
  if(Array.isArray(value))return value.map(sanitize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key,v])=>!(key==='path'&&typeof v==='string'&&/^\/(?:opt|var|etc|run|home|srv|Users|private|tmp|root)\//.test(v))).map(([key,v])=>[key,sanitize(v)]));
  return value;
}

export function connectorFailure(error){
  if(['ACCESS_DENIED','INVALID_ARGUMENTS','UNSUPPORTED_OPERATION','SIBEMA_REFERENCE_UNAVAILABLE'].includes(error.message))return {error:error.message};
  const allowed=new Set(['SIBEMA_TARIFF_INVALID_ARGUMENTS','SIBEMA_TARIFF_REMARKS_TOO_LONG','MESSAGE_NOT_FOUND','MESSAGE_REFERENCE_EXPIRED','MESSAGE_RECOVERY_UNAVAILABLE','MESSAGE_RECOVERY_LIMIT','MAIL_AUTHENTICATION_FAILED','MAILBOX_NOT_CONNECTED','MAIL_SEARCH_QUERY_INVALID','MAIL_API_INVALID','ATTIO_API_INVALID_ARGUMENTS','ATTACHMENT_NOT_FOUND','INVALID_MESSAGE_REFERENCE','MAIL_NOT_DRAFT','MAIL_ACTION_ALREADY_DISPATCHED','MAIL_APPROVAL_MISMATCH']);
  if(typeof error.stderr==='string'&&Buffer.byteLength(error.stderr)<=8192){
    for(const line of error.stderr.split('\n').reverse()){
      try{const data=JSON.parse(line);if(data.status==='error'){
        if(allowed.has(data.code))return {error:data.code};
        if(data.code==='SIBEMA_DELETE_INVALID')return {error:'SIBEMA_API_INVALID_ARGUMENTS'};
        if([401,403].includes(data.httpStatus))return {error:'PROVIDER_ACCESS_DENIED',providerStatus:data.httpStatus};
        if(data.httpStatus===429)return {error:'PROVIDER_RATE_LIMITED',providerStatus:data.httpStatus};
        if([400,404,409,422].includes(data.httpStatus))return {error:'PROVIDER_REQUEST_REJECTED',providerStatus:data.httpStatus};
        if(typeof data.message==='string'&&/^(SIBEMA_LINE_REFERENCES:|SIBEMA_HEADER:)/.test(data.message))return {error:'SIBEMA_API_INVALID_ARGUMENTS'};
        if(typeof data.message==='string'&&data.message.startsWith('Offer remarks must be at most 255'))return {error:'SIBEMA_API_INVALID_ARGUMENTS'};
        if(typeof data.message==='string'&&data.message.startsWith('SIBEMA_API_CONTRACT:'))return {error:'SIBEMA_API_INVALID_ARGUMENTS'};
      }}catch{}
    }
  }
  return {error:'CONNECTOR_UNAVAILABLE'};
}

// The native read contract exposes numeric unit_price and quantity unit, but
// does not establish their currency or price denomination. Preserve those raw
// values and make that evidence boundary visible beside every Sibema read.
const priceInterpretation=Object.freeze({
  currency_established_by_read_contract:false,
  price_unit_basis_established_by_read_contract:false,
  quantity_unit_establishes_price_denominator:false,
  raw_unit_price_values_preserved:true,
  additional_evidence_required:'An original business document or explicit provider contract must establish currency and price denomination before labeling a raw price as EUR/kg, EUR/t or another monetary unit.',
});

export function brokerServer(configFile, runner=execute, actionRoot='/opt/trinalum/data/aibrain-actions', proposalRoot='/opt/trinalum/data/notifications/sibema-proposals', audioOptions={}, statusProofRunner=holdNativeStatusProof) {
  let active=0;
  const audioTranscribe=createAudioTranscriber(audioOptions);
  return createServer(async(req,res)=>{
    const requestStarted=Date.now();
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    const reply=(status,value)=>{res.writeHead(status);res.end(JSON.stringify(value));};
    if(req.method!=='POST'||!['/read','/write','/capabilities','/audio-transcribe','/action-status'].includes(req.url)){reply(404,{error:'NOT_FOUND'});return;}
    if(active>=4){reply(429,{error:'BUSY'});return;}
    active++;
    const audioRequest=req.url==='/audio-transcribe';
    if(audioRequest)res.shouldKeepAlive=false;
    const cancellation=new AbortController();
    const cancel=()=>{if(!res.writableEnded)cancellation.abort();};
    if(audioRequest){req.on('aborted',cancel);res.on('close',cancel);}
    try {
      // Reload on every request, so revocation takes effect without a restart.
      const config=JSON.parse(await readFile(configFile,'utf8'));
      const binding=authenticate(config,req.headers.authorization);
      if(audioRequest&&(process.env.TRINALUM_BROKER_AUDIO_ENABLED!=='1'||req.socket.remoteAddress!==undefined))throw Error('AUDIO_UNAVAILABLE');
      if(req.url==='/capabilities'){
        if(binding.installationId!=='trinalum-production'||binding.status!=='active'||!uuid.test(binding.userId))throw Error('ACCESS_DENIED');
        reply(200,{installationId:binding.installationId,userId:binding.userId,operations:binding.operations??[],mailbox:mailboxByOwner[binding.owner]??null});return;
      }
      if(audioRequest){
        const header=req.headers['x-aibrain-audio-identity'];
        if(req.headers['content-type']!=='application/octet-stream'||typeof header!=='string'||header.length>2048||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(header))throw Error('INVALID_ARGUMENTS');
        const metadata=Buffer.from(header,'base64');
        if(metadata.toString('base64')!==header)throw Error('INVALID_ARGUMENTS');
        let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(metadata));}catch{throw Error('INVALID_ARGUMENTS');}
        authorizeAudio(binding,parsed);
        if(req.headers['content-length']!==String(parsed.size)||req.headers['transfer-encoding']!==undefined)throw Error('INVALID_ARGUMENTS');
        const authorize=async()=>{
          const current=authenticate(JSON.parse(await readFile(configFile,'utf8')),req.headers.authorization);
          authorizeAudio(current,parsed);
          if(current.userId!==binding.userId||current.owner!==binding.owner)throw Error('ACCESS_DENIED');
        };
        const result=await audioTranscribe(binding,parsed,req,{signal:cancellation.signal,authorize});
        if(!cancellation.signal.aborted&&!res.destroyed)reply(200,result);
        return;
      }
      let body='';
      for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>(req.url==='/read'?256*1024:48*1024*1024))throw Error('INVALID_ARGUMENTS');}
      const parsed=JSON.parse(body);
      if(req.url==='/action-status'){
        if(Object.keys(parsed).sort().join(',')!=='actionId,input,operation,phase'||!['status','rejection-status'].includes(parsed.phase)||parsed.operation!=='attio_action')throw Error('INVALID_ARGUMENTS');
        const action=actionFor(binding,parsed.operation,parsed.input,parsed.actionId);
        const requestHash=hashNativeAction(action);
        const category=parsed.phase==='status'?'no-dispatch':'definitive-rejection';
        let lease;
        const close=()=>lease?.close();res.once('close',close);
        try{
          lease=await statusProofRunner('/opt/trinalum/bin/trinalum-attio-action',['status-proof','--action-id',action.id,'--actor',action.requestedBy,'--request-hash',requestHash,'--proof-category',category,'--hold']);
          if(res.destroyed){lease.close();return;}
          // Recheck grants after acquiring both native locks, before publishing.
          const fresh=authenticate(JSON.parse(await readFile(configFile,'utf8')),req.headers.authorization);
          if(hashNativeAction(actionFor(fresh,parsed.operation,parsed.input,parsed.actionId))!==requestHash||fresh.userId!==binding.userId)throw Error('ACCESS_DENIED');
          const proof=checkedNativeStatusProof(lease.proof,action,requestHash,category);
          res.writeHead(200,{'Content-Type':'application/x-ndjson'});
          res.write(JSON.stringify({...proof,installationId:binding.installationId,userId:binding.userId,operation:'attio_action'})+'\n');
          await lease.closed;
          if(!res.destroyed)res.end();
        }finally{close();res.removeListener('close',close);}
        return;
      }
      if(req.url==='/write'){
        if(Object.keys(parsed).sort().join(',')!=='actionId,input,operation,phase'||!['prepare','execute'].includes(parsed.phase))throw Error('INVALID_ARGUMENTS');
        const action=actionFor(binding,parsed.operation,parsed.input,parsed.actionId);
        const qaScope=parsed.operation==='sibema_action'?qaOrderScope(binding,parsed.input):null;
        if(qaScope){
          const [command,args]=commandFor(binding,'sibema_read',{path:`/orders/${qaScope.orderId}`});
          const proof=await runner(command,args,{timeout:15000,maxBuffer:2*1024*1024,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}});
          assertQaOrderIdentity(qaScope,JSON.parse(proof.stdout));
        }
        await mkdir(actionRoot,{recursive:true,mode:0o700});
        const file=join(actionRoot,`${parsed.actionId}.json`),serialized=JSON.stringify(parsed.operation==='mail_action'?parsed.input:action);
        try{await writeFile(file,serialized,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await readFile(file,'utf8')!==serialized)throw Error('INVALID_ARGUMENTS');}
        const options={timeout:45000,maxBuffer:48*1024*1024,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}};
        const cli=parsed.operation==='attio_action'?'/opt/trinalum/bin/trinalum-attio-action':parsed.operation==='sibema_action'?'/opt/trinalum/bin/trinalum-sibema-action':parsed.operation==='mail_action'?'/opt/trinalum/bin/trinalum-mail-api':'/opt/trinalum/bin/trinalum-mail-compose';
        let args;
        if(parsed.operation==='mail_action'){
          const base=['--mailbox',action.mailbox,'--actor',action.requestedBy,'--action-id',parsed.actionId];
          if(parsed.phase==='prepare')args=['prepare',...base,'--input',file];
          else{
            const frozen=JSON.parse((await runner(cli,['show',...base],options)).stdout);
            if(!/^[a-f0-9]{64}$/.test(frozen.hash??''))throw Error('INVALID_ARGUMENTS');
            args=['execute',...base,'--confirmed-hash',frozen.hash];
          }
        }
        else if(parsed.operation==='mail_draft')args=['--input',file,'--output',join(actionRoot,`${parsed.actionId}-signed.json`),...(parsed.phase==='execute'?['--save']:[])];
        else args=parsed.phase==='prepare'?['prepare','--input',file]:['execute','--action-id',parsed.actionId,'--approved-by',names[binding.owner],'--confirmed-exact-action'];
        let stdout;
        try{({stdout}=await runner(cli,args,options));}
        catch(error){
          // A durable exact rejection is a different outcome from uncertainty.
          // No provider/customer error text or payload is returned as proof.
          if(parsed.operation==='attio_action'&&parsed.phase==='execute'&&typeof error.stderr==='string'&&Buffer.byteLength(error.stderr)<=8192){
            try{
              const failure=JSON.parse(error.stderr.trim());
              const proof=checkedNativeStatusProof(failure.nativeDisposition,action,hashNativeAction(action),'definitive-rejection');
              reply(502,{...connectorFailure(error),nativeDisposition:{...proof,installationId:binding.installationId,userId:binding.userId,operation:'attio_action'}});return;
            }catch{/* Missing or untrusted disposition retains uncertain handling. */}
          }
          throw error;
        }
        // mail-compose emits one complete JSON object per prepare/execute step.
        const output=parsed.operation==='mail_draft'&&parsed.phase==='execute'?parseLastJson(stdout):JSON.parse(stdout);
        reply(200,{source:'Trinalum connector broker',phase:parsed.phase,actionId:parsed.actionId,data:sanitize(output),untrustedSourceContent:true});return;
      }
      if(!['input,operation','input,mailSearchContext,operation'].includes(Object.keys(parsed).sort().join(',')))throw Error('INVALID_ARGUMENTS');
      if(parsed.mailSearchContext!==undefined&&!(parsed.operation==='mail_search'||parsed.operation==='mail_api'&&parsed.input?.input?.operation==='search'))throw Error('INVALID_ARGUMENTS');
      let notificationReference=null;
      const reference=parsed.operation==='sibema_read'?sibemaProposalReference(parsed.input?.path):null;
      if(reference){
        // Authenticate the existing read scope and all argument keys before
        // touching an owner-private notification. Never trust a supplied owner.
        commandFor(binding,parsed.operation,{...parsed.input,path:'/orders/1'});
        notificationReference=await resolveSibemaProposal(proposalRoot,binding.owner,reference);
        parsed.input={path:notificationReference.lookup_path};
      }
      const [file,args]=commandFor(binding,parsed.operation,parsed.input,parsed.mailSearchContext);
      const {stdout}=await runner(file,args,{timeout:45000,maxBuffer:48*1024*1024,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}});
      const resultData=JSON.parse(stdout);
      if(parsed.operation==='mail_search'&&Array.isArray(resultData.messages)){
        resultData.count=resultData.messages.length;
        resultData.messages=resultData.messages.map(m=>({...m,message_id:m.id,occurred_at:m.date}));
      }
      let coverage=null;
      if(parsed.operation==='attio_search'){
        if(!binding.operations?.includes('sibema_read'))coverage={query:parsed.input.query,checked_at:new Date().toISOString(),complete:false,reason:'ERP_SCOPE_NOT_AUTHORIZED'};
        else{
          const deadline=Math.min(Date.now()+15000,requestStarted+45000);
          coverage=await registrationCoverage(parsed.input.query,async path=>{
            const remaining=deadline-Date.now();if(remaining<=0)throw Error('SOURCE_UNAVAILABLE');
            const [command,arguments_]=commandFor(binding,'sibema_read',{path});
            const output=await runner(command,arguments_,{timeout:Math.min(5000,remaining),maxBuffer:2*1024*1024,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}});
            return registrationPageFromCli(JSON.parse(output.stdout),path);
          });
        }
      }
      reply(200,{source:'Trinalum connector broker',data:sanitize(resultData),...(coverage?{registrationCoverage:sanitize(coverage)}:{}),...(['sibema_read','sibema_api'].includes(parsed.operation)?{priceInterpretation}:{}),...(notificationReference?{notificationReference}:{}),untrustedSourceContent:true});
    }catch(error){
      if(audioRequest){
        const allowed=new Set(['ACCESS_DENIED','INVALID_ARGUMENTS','AUDIO_UNAVAILABLE','AUDIO_SOURCE_UNSAFE','AUDIO_SIZE_INVALID','AUDIO_SOURCE_CHANGED','AUDIO_INVALID','AUDIO_OUTPUT_INVALID','AUDIO_TIMEOUT','AUDIO_CANCELLED','AUDIO_BUSY','AUDIO_BUDGET_UNVERIFIED']);
        const code=allowed.has(error.message)?error.message:'AUDIO_UNAVAILABLE';
        if(!res.destroyed)reply(code==='ACCESS_DENIED'?403:code==='AUDIO_BUSY'?429:['INVALID_ARGUMENTS','AUDIO_SOURCE_UNSAFE','AUDIO_SIZE_INVALID','AUDIO_SOURCE_CHANGED','AUDIO_INVALID','AUDIO_OUTPUT_INVALID'].includes(code)?400:503,{error:code});
        return;
      }
      if(res.headersSent){res.destroy();return;}
      const failure=connectorFailure(error),code=failure.error;
      reply(code==='ACCESS_DENIED'?403:code.startsWith('SIBEMA_TARIFF_')?422:code==='INVALID_ARGUMENTS'||code.startsWith('MESSAGE_')?400:502,failure);
    }finally{active--;if(audioRequest){req.removeListener('aborted',cancel);res.removeListener('close',cancel);}}
  });
}

// Must match native hashAction. Broker actor names are canonical titles and
// its accepted types never use the legacy commercial-values normalization.
export function hashNativeAction(action){
  return createHash('sha256').update(stableNativeJson({id:action.id,type:action.type,requestedBy:action.requestedBy,request:action.request})).digest('hex');
}
function stableNativeJson(v){return Array.isArray(v)?'['+v.map(stableNativeJson).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stableNativeJson(v[k])).join(',')+'}':JSON.stringify(v);}
export function hashNativeEffect(action){
  let request=action.request;
  if(action.type==='api_request'){
    const {readback:_readback,...operation}=request;
    const url=new URL(operation.path,'https://api.attio.com');url.searchParams.sort();
    request={...operation,path:url.pathname+url.search};
  }
  return createHash('sha256').update(stableNativeJson({type:action.type,request})).digest('hex');
}
export function checkedNativeStatusProof(p,action,requestHash,category='no-dispatch'){
  const nulls=['approvedAt','approvedBy','dispatchedAt','executedAt','error'];
  if(!p||p.proofVersion!==1||p.proofCategory!==category||p.actionId!==action.id||p.requestedBy!==action.requestedBy||p.requestHash!==requestHash||p.executedAt!==null||['providerResultPresent','resultPresent','readbackPresent','otherClaimHeld','legacyHistoryCertified'].some(k=>p[k]!==false)||p.dispatchGuarantee!=='attio-durable-before-mutation-v1'||![p.effectHash,p.nativeRecordSha256].every(h=>/^[a-f0-9]{64}$/.test(h??'')))throw Error('CONNECTOR_UNAVAILABLE');
  if(p.effectHash!==hashNativeEffect(action))throw Error('CONNECTOR_UNAVAILABLE');
  if(category==='no-dispatch'){
    if(p.nativeStatus!=='prepared'||nulls.some(k=>p[k]!==null)||p.preparedProvenance!=='strict-unapproved-prepared')throw Error('CONNECTOR_UNAVAILABLE');
  }else if(category!=='definitive-rejection'||p.nativeStatus!=='rejected'||p.definitiveRejection!==true||p.providerStatus!==400||p.providerCode!=='validation_type'||p.error?.status!==400||p.error?.code!=='validation_type'||p.approvedBy!==action.requestedBy||![p.approvedAt,p.dispatchedAt].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))))throw Error('CONNECTOR_UNAVAILABLE');
  const checked=Date.parse(p.checkedAt),expires=Date.parse(p.expiresAt),now=Date.now();
  if(!Number.isFinite(checked)||!Number.isFinite(expires)||checked>now+1000||now-checked>30000||expires<=now||expires-checked!==30000)throw Error('CONNECTOR_UNAVAILABLE');
  const keys=['proofVersion','proofCategory','actionId','requestedBy','requestHash','effectHash','nativeRecordSha256','nativeStatus',...nulls,'providerResultPresent','resultPresent','readbackPresent','otherClaimHeld','legacyHistoryCertified','dispatchGuarantee','checkedAt','expiresAt',...(category==='no-dispatch'?['preparedProvenance']:['definitiveRejection','providerStatus','providerCode'])];
  const result=Object.fromEntries(keys.map(k=>[k,p[k]]));
  if(category==='definitive-rejection')result.error={status:400,code:'validation_type'};
  return result;
}
export function holdNativeStatusProof(cli,args){
  return new Promise((resolve,reject)=>{
    const child=spawn(cli,args,{env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
    let buffer='',ready=false;
    const close=()=>{child.stdin.end();};
    const timer=setTimeout(()=>{close();child.kill('SIGTERM');},35000);
    const closed=new Promise(done=>child.once('close',()=>{clearTimeout(timer);if(!ready)reject(Error('CONNECTOR_UNAVAILABLE'));done();}));
    child.once('error',()=>{clearTimeout(timer);reject(Error('CONNECTOR_UNAVAILABLE'));});
    child.stdin.on('error',()=>{});child.stderr.resume();
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      if(ready)return;buffer+=chunk;
      if(buffer.length>16384){close();reject(Error('CONNECTOR_UNAVAILABLE'));return;}
      const end=buffer.indexOf('\n');if(end<0)return;
      try{const proof=JSON.parse(buffer.slice(0,end));ready=true;resolve({proof,closed,close});}catch{close();reject(Error('CONNECTOR_UNAVAILABLE'));}
    });
  });
}
function parseLastJson(stdout){
  let depth=0,start=-1,last=null,inString=false,escape=false;
  for(let i=0;i<stdout.length;i++){const c=stdout[i];if(inString){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;continue;}if(c==='"'){inString=true;continue;}if(c==='{'){if(depth++===0)start=i;}if(c==='}'&&--depth===0&&start>=0)last=JSON.parse(stdout.slice(start,i+1));}
  if(!last)throw Error('CONNECTOR_UNAVAILABLE');return last;
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  const configFile=process.env.TRINALUM_BROKER_CONFIG;
  if(!configFile?.startsWith('/'))throw Error('TRINALUM_BROKER_CONFIG required');
  const server=brokerServer(configFile);
  server.requestTimeout=50000;server.headersTimeout=10000;
  const socket=process.env.TRINALUM_BROKER_SOCKET;
  if(socket){
    if(socket!=='/run/trinalum-broker/broker.sock')throw Error('Invalid broker socket');
    const existing=await lstat(socket).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
    if(existing&&!existing.isSocket())throw Error('Unexpected broker socket file');
    if(existing)await unlink(socket);
    server.listen(socket,async()=>{await chmod(socket,0o660);});
  }else server.listen(18931,'127.0.0.1');
}
