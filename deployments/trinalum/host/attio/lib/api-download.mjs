import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import https from 'node:https';
import {createHash} from 'node:crypto';

export const MAX_DOWNLOAD_BYTES=15*1024*1024;
function blocked(message='Attio file download is unavailable',code='ATTIO_DOWNLOAD_UNAVAILABLE'){const error=new Error(message);error.code=code;return error;}

export function isPublicAddress(address) {
  if(isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===192&&b===0&&(c===0||c===2)||a===192&&b===88&&c===99||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
  }
  if(isIP(address)===6){
    // Only global unicast; exclude documentation and transition/tunnel ranges.
    const text=address.toLowerCase();const first=parseInt(text.split(':')[0],16);
    if(first<0x2000||first>=0x3fff||!Number.isFinite(first)||text.startsWith('2002:'))return false;
    const second=parseInt(text.split(':')[1]||'0',16);
    if(first===0x2001&&(second===0||second===2||second===0xdb8||second>=0x10&&second<=0x2f))return false;
    return true;
  }
  return false;
}

export async function validatedDownloadTarget(location,resolveHost=lookup) {
  let url;try{url=new URL(location);}catch{throw blocked('Unsafe provider download destination','ATTIO_DOWNLOAD_DESTINATION_BLOCKED');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443')throw blocked('Unsafe provider download destination','ATTIO_DOWNLOAD_DESTINATION_BLOCKED');
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  if(/(?:^|\.)(?:localhost|local|internal|onion)$/.test(hostname)||hostname.includes('%'))throw blocked('Unsafe provider download destination','ATTIO_DOWNLOAD_DESTINATION_BLOCKED');
  let addresses;
  try{addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await resolveHost(hostname,{all:true,verbatim:true});}catch{throw blocked('Provider file destination could not be resolved');}
  if(!addresses.length||addresses.some(row=>!isPublicAddress(row.address)))throw blocked('Unsafe provider download destination','ATTIO_DOWNLOAD_DESTINATION_BLOCKED');
  return {url,addresses};
}

function nativeDownload({url,addresses,maxBytes}) {
  return new Promise((resolve,reject)=>{
    const request=https.request(url,{method:'GET',agent:false,headers:{Accept:'*/*'},lookup:(_hostname,options,callback)=>{
      // Resolve once, validate every result, then pin all connection candidates.
      const selected=addresses.filter(row=>!options.family||row.family===options.family);
      if(!selected.length){callback(blocked());return;}
      if(options.all)callback(null,selected);else callback(null,selected[0].address,selected[0].family);
    }},response=>{
      if(response.statusCode!==200){response.destroy();reject(blocked('Provider file destination rejected the download','ATTIO_DOWNLOAD_REDIRECT_BLOCKED'));return;}
      const length=Number(response.headers['content-length']);
      if(Number.isFinite(length)&&length>maxBytes){response.destroy();reject(blocked('File exceeds the 15 MB download limit','ATTIO_DOWNLOAD_TOO_LARGE'));return;}
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){response.destroy();reject(blocked('File exceeds the 15 MB download limit','ATTIO_DOWNLOAD_TOO_LARGE'));}else chunks.push(chunk);});
      response.on('end',()=>resolve({bytes:Buffer.concat(chunks),headers:response.headers}));
      response.on('error',()=>reject(blocked()));
      response.on('aborted',()=>reject(blocked()));
    });
    request.setTimeout(30000,()=>request.destroy(blocked('Provider file download timed out','ATTIO_DOWNLOAD_TIMEOUT')));
    request.on('error',error=>reject(error.code?.startsWith('ATTIO_')?error:blocked()));request.end();
  });
}

function header(headers,key){return typeof headers?.get==='function'?headers.get(key):headers?.[key];}
export function binaryFileResult(bytes,headers={},fallback='attio-file.bin') {
  if(bytes.length>MAX_DOWNLOAD_BYTES)throw blocked('File exceeds the 15 MB download limit','ATTIO_DOWNLOAD_TOO_LARGE');
  const disposition=String(header(headers,'content-disposition')??'');
  let filename=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]??disposition.match(/filename="([^"]+)"|filename=([^;]+)/i)?.slice(1).find(Boolean)??fallback;
  try{filename=decodeURIComponent(filename);}catch{}
  filename=filename.replace(/[/\\\x00-\x1f\x7f]/g,'_').trim().slice(0,160)||'attio-file.bin';
  const type=String(header(headers,'content-type')??'application/octet-stream').split(';')[0].trim();
  const mimeType=/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(type)?type:'application/octet-stream';
  return {kind:'file',filename,mimeType,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content_base64:bytes.toString('base64')};
}

// Location comes exclusively from a no-redirect authenticated Attio response.
// Never pass the provider bearer token or return/store the signed location.
export async function downloadProviderFile(location,{resolveHost=lookup,downloadTransport=nativeDownload,fallback}={}) {
  const target=await validatedDownloadTarget(location,resolveHost);
  const response=await downloadTransport({...target,maxBytes:MAX_DOWNLOAD_BYTES});
  return binaryFileResult(response.bytes,response.headers,fallback);
}

export async function directProviderFile(response,fallback) {
  const length=Number(response.headers.get('content-length'));
  if(Number.isFinite(length)&&length>MAX_DOWNLOAD_BYTES)throw blocked('File exceeds the 15 MB download limit','ATTIO_DOWNLOAD_TOO_LARGE');
  const chunks=[];let size=0;
  for await(const chunk of response.body??[]){size+=chunk.length;if(size>MAX_DOWNLOAD_BYTES){await response.body.cancel().catch(()=>{});throw blocked('File exceeds the 15 MB download limit','ATTIO_DOWNLOAD_TOO_LARGE');}chunks.push(Buffer.from(chunk));}
  return binaryFileResult(Buffer.concat(chunks),response.headers,fallback);
}
