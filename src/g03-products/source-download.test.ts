import {expect,it,vi} from 'vitest';
import {fetchPublicProductionWorkbook} from './source-download';
const id='SYNTHETIC_PUBLIC_SHEET';
const mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const bytes=Buffer.from([0x50,0x4b,0x03,0x04,1]);
it('reads the fixed public Google export with no cookies and a bounded Google-owned redirect',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://doc-00-a0-sheets.googleusercontent.com/export/SYNTHETIC'}})).mockResolvedValueOnce(new Response(bytes,{headers:{'content-type':mime}}));
 const result=await fetchPublicProductionWorkbook(id,fetcher);expect(result.data).toEqual(bytes);
 expect(String(fetcher.mock.calls[0][0])).toBe(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`);
 expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'manual',credentials:'omit'});
});
it('rejects login and foreign/credentialed redirect destinations before requesting them',async()=>{
 for(const location of ['https://accounts.google.com/login','https://attacker.invalid/x','http://docs.google.com/x','https://user:secret@docs.google.com/x']){
  const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location}}));
  await expect(fetchPublicProductionWorkbook(id,fetcher)).rejects.toThrow('G03_SOURCE_REDIRECT_DENIED');expect(fetcher).toHaveBeenCalledTimes(1);
 }
});
it('treats a login HTML response as missing access rather than spreadsheet data',async()=>{
 await expect(fetchPublicProductionWorkbook(id,vi.fn().mockResolvedValue(new Response('<html>Sign in</html>',{headers:{'content-type':'text/html'}})))).rejects.toThrow('G03_SOURCE_CONNECTION_REQUIRED');
});
it('rejects oversized announced and streamed bodies and a non-workbook payload',async()=>{
 await expect(fetchPublicProductionWorkbook(id,vi.fn().mockResolvedValue(new Response('x',{headers:{'content-type':mime,'content-length':String(11*1024*1024)}})))).rejects.toThrow('G03_SOURCE_DOWNLOAD_TOO_LARGE');
 await expect(fetchPublicProductionWorkbook(id,vi.fn().mockResolvedValue(new Response(Buffer.alloc(11*1024*1024),{headers:{'content-type':mime}})))).rejects.toThrow('G03_SOURCE_DOWNLOAD_TOO_LARGE');
 await expect(fetchPublicProductionWorkbook(id,vi.fn().mockResolvedValue(new Response('login',{headers:{'content-type':mime}})))).rejects.toThrow('G03_SOURCE_WORKBOOK_INVALID');
});
