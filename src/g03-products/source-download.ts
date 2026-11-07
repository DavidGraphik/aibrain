const MAX_WORKBOOK_BYTES=10*1024*1024;
/** Public-read only. No cookies, OAuth tokens, sharing changes or login scraping. */
export async function fetchPublicProductionWorkbook(fileId:string,fetcher:typeof fetch=fetch){
 if(typeof fileId!=='string'||!/^[A-Za-z0-9_-]{10,150}$/.test(fileId))throw Error('G03_SOURCE_ID_INVALID');
 let url=new URL(`https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx`);
 const signal=AbortSignal.timeout(30000);
 for(let redirects=0;redirects<=4;redirects++){
  if(url.protocol!=='https:'||url.port||url.username||url.password||!(url.hostname==='docs.google.com'||/^doc-[a-z0-9-]+-sheets\.googleusercontent\.com$/.test(url.hostname)))throw Error('G03_SOURCE_REDIRECT_DENIED');
  const response=await fetcher(url,{method:'GET',headers:{Accept:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},redirect:'manual',cache:'no-store',credentials:'omit',signal});
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');await response.body?.cancel();if(!location)throw Error('G03_SOURCE_REDIRECT_INVALID');url=new URL(location,url);continue;
  }
  if(!response.ok)throw Error(response.status===401||response.status===403||response.status===404?'G03_SOURCE_CONNECTION_REQUIRED':'G03_SOURCE_DOWNLOAD_FAILED');
  const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if(type!=='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {await response.body?.cancel();throw Error('G03_SOURCE_CONNECTION_REQUIRED');}
  const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>MAX_WORKBOOK_BYTES)){await response.body?.cancel();throw Error('G03_SOURCE_DOWNLOAD_TOO_LARGE');}
  if(!response.body)throw Error('G03_SOURCE_DOWNLOAD_EMPTY');const chunks:Buffer[]=[];let size=0;const reader=response.body.getReader();
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_WORKBOOK_BYTES)throw Error('G03_SOURCE_DOWNLOAD_TOO_LARGE');chunks.push(Buffer.from(part.value));}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const data=Buffer.concat(chunks);if(data.length<4||data.readUInt32LE(0)!==0x04034b50)throw Error('G03_SOURCE_WORKBOOK_INVALID');
  return{data,capturedAt:new Date().toISOString()};
 }
 throw Error('G03_SOURCE_TOO_MANY_REDIRECTS');
}
