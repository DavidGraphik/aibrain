// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '../render-spanish';
import { afterEach, expect, it, vi } from 'vitest';
import { ServerFilePreview } from '@/components/server-file-preview';
import { ServerPicker } from '@/components/server-picker';
const file={path:'server-g03/M/G03/test.txt',name:'test.txt',kind:'file' as const,size:20,modifiedAt:null};
const value=(extra={})=>({available:true,path:file.path,content:'<script>window.evil=1</script>',sha256:'a'.repeat(64),nextPath:null,truncated:false,...extra});
const response=(data:unknown)=>({ok:true,json:async()=>data});
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
it('file click opens a read-only preview while checkbox selection remains separate',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response({available:true,sourceChecked:true,results:[file],checkedAt:new Date().toISOString()})).mockResolvedValueOnce(response(value()));
 vi.stubGlobal('fetch',fetcher);const select=vi.fn();
 render(<ServerPicker projectId="project" selected={[]} onSelect={select} onClose={vi.fn()}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Ver test.txt'}));
 await screen.findByText('<script>window.evil=1</script>');
 expect(document.querySelector('pre script')).toBeNull();
 expect(screen.getByRole('button',{name:'Adjuntar referencias'}).hasAttribute('disabled')).toBe(true);
 expect(fetcher.mock.calls[1][0]).toContain('/api/server-files/preview?');
 fireEvent.click(screen.getByRole('button',{name:'Volver a la carpeta'}));
 fireEvent.click(await screen.findByLabelText('Adjuntar test.txt'));
 fireEvent.click(screen.getByRole('button',{name:'Adjuntar referencias'}));
 expect(select).toHaveBeenCalledWith([file]);
});
it('does not mix pages from changed source versions and retry restarts at part one',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(value({nextPath:file.path+'?part=2',truncated:true})))
 .mockResolvedValueOnce(response(value({path:file.path+'?part=2',content:'changed source',sha256:'b'.repeat(64)})))
 .mockResolvedValueOnce(response(value({content:'fresh part one',sha256:'b'.repeat(64)})));
 vi.stubGlobal('fetch',fetcher);
 render(<ServerFilePreview projectId="project" file={file} onBack={vi.fn()}/>);
 await screen.findByText('<script>window.evil=1</script>');
 fireEvent.click(screen.getByRole('button',{name:'Siguiente parte'}));
 await screen.findByRole('alert');expect(screen.queryByText('changed source')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Reintentar'}));await screen.findByText('fresh part one');
 expect(fetcher.mock.calls[2][0]).not.toContain('part%3D2');
});
it('reports failed reads and aborts pending requests on close without retaining old content',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response({available:false}));vi.stubGlobal('fetch',fetcher);
 const view=render(<ServerFilePreview projectId="project" file={file} onBack={vi.fn()}/>);
 await screen.findByRole('alert');view.unmount();
 expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
it('renders validated spreadsheet cells and sheet selection',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(value({preview:{schemaVersion:1,kind:'spreadsheet',truncated:false,sheets:[{name:'Registre',hidden:false,cells:[{address:'A1',value:'Codi'},{address:'A2',value:'EQ-7'}]}]}}))));
 render(<ServerFilePreview projectId="project" file={{...file,name:'test.xlsx'}} onBack={vi.fn()}/>);
 await screen.findByRole('combobox',{name:'Hoja del libro'});await waitFor(()=>expect(screen.getByText('EQ-7')).toBeTruthy());
});
