// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { appHtml, departmentApps, type Column } from '../../scripts/g03/department-apps';
afterEach(()=>{document.body.innerHTML='';vi.restoreAllMocks();});
async function mount(index:number,values:Record<string,unknown>,extra:Column[]=[]){
 const app={...departmentApps[index],columns:[...departmentApps[index].columns,...extra]};const html=appHtml(app);
 const script=html.match(/<script>([\s\S]*)<\/script>/)![1];document.body.innerHTML=html.replace(/<script>[\s\S]*<\/script>/,'');
 const data=vi.fn(async(action:string)=>action==='list'?{revision:3,rows:[{id:'row',revision:1,values}]}:{});
 const fakeWindow={aibrain:{data}};vi.spyOn(HTMLElement.prototype,'scrollIntoView' in HTMLElement.prototype?'scrollIntoView':'focus').mockImplementation(()=>{});
 if(!HTMLElement.prototype.scrollIntoView)HTMLElement.prototype.scrollIntoView=()=>{};
 new Function('window','document',script)(fakeWindow,document);
 await waitFor(()=>expect(document.querySelectorAll('#rows tr')).toHaveLength(1));return data;
}
it('preserves unknown closure and hidden provenance when editing another field',async()=>{
 const data=await mount(1,{code:'260001',kind:'Interna',description:'Peça',closed:null,source_key:'original:2'},[{name:'source_key',label:'source',type:'text',hidden:true}]);
 expect(document.querySelector('#rows')!.textContent).toContain('—');expect(document.querySelector('[name=source_key]')).toBeNull();expect(document.querySelector('#reset')).toBeNull();
 (document.querySelector('#rows button') as HTMLButtonElement).click();
 expect((document.querySelector('[name=closed]') as HTMLSelectElement).value).toBe('');
 (document.querySelector('#form') as HTMLFormElement).dispatchEvent(new Event('submit',{cancelable:true}));
 await waitFor(()=>expect(data).toHaveBeenCalledWith('update',expect.objectContaining({values:expect.objectContaining({closed:null,source_key:'original:2'})})));
 await waitFor(()=>expect(document.querySelector('#status')!.textContent).toBe('Registre desat i verificat al servidor.'));
 (document.querySelector('#new-row') as HTMLButtonElement).click();expect(document.querySelector('#status')!.textContent).toBe('Registre nou');
});
it('uses stored original PVP without treating it as cost or applying a markup',async()=>{
 await mount(3,{quantity:2,pvp:1105.25,setup:999,unit_cost:999,markup:99},[{name:'pvp',label:'PVP',type:'number'}]);
 expect(document.querySelector('#rows')!.textContent).toContain('2.210,50');expect(document.querySelector('#rows')!.textContent).toContain('1.105,25');
});
it('does not display an invented zero quote when costs and original PVP are missing',async()=>{
 await mount(3,{quantity:2,setup:null,unit_cost:null,markup:null});
 const cells=document.querySelectorAll('#rows td');expect(cells[cells.length-3].textContent).toBe('—');expect(cells[cells.length-2].textContent).toBe('—');
});

it('calculates and applies a lot explicitly while preserving source provenance on save',async()=>{
 const data=await mount(3,{quote:'Q1',client:'Prova',reference:'Ref',quantity:100,pvp:9,source_key:'original:2',source_data:JSON.stringify({AM:'100',Y:'0.5',Z:'6'})},[{name:'pvp',label:'PVP',type:'number'},{name:'calculation_inputs',label:'model',type:'text',hidden:true}]);
 (document.querySelector('#rows button') as HTMLButtonElement).click();
 expect((document.querySelector('[data-calc=cv_setup]') as HTMLInputElement).value).toBe('0.5');
 (document.querySelector('#calculator-run') as HTMLButtonElement).click();
 expect((document.querySelector('[name=pvp]') as HTMLInputElement).value).toBe('9');
 (document.querySelector('#calculator-apply') as HTMLButtonElement).click();
 expect((document.querySelector('[name=pvp]') as HTMLInputElement).value).toBe('7.35');
 (document.querySelector('#form') as HTMLFormElement).dispatchEvent(new Event('submit',{cancelable:true}));
 await waitFor(()=>expect(data).toHaveBeenCalledWith('update',expect.objectContaining({values:expect.objectContaining({pvp:7.35,source_key:'original:2',calculation_inputs:expect.any(String)})})));
});

it('saves and restores alternative lots in one quotation without creating separate records',async()=>{
 const data=await mount(3,{quote:'Q1',client:'Prova',reference:'Ref',quantity:100,pvp:9,source_key:'original:2',calculation_inputs:JSON.stringify({quantity:100,_lots:[100,500,1000]})},[{name:'pvp',label:'PVP',type:'number'},{name:'calculation_inputs',label:'model',type:'text',hidden:true}]);
 (document.querySelector('#rows button') as HTMLButtonElement).click();
 expect((document.querySelector('#calculator-lots') as HTMLInputElement).value).toBe('500, 1000');
 (document.querySelector('#calculator-run') as HTMLButtonElement).click();
 (document.querySelector('#calculator-apply') as HTMLButtonElement).click();
 (document.querySelector('#form') as HTMLFormElement).dispatchEvent(new Event('submit',{cancelable:true}));
 await waitFor(()=>expect(data).toHaveBeenCalledWith('update',expect.objectContaining({values:expect.objectContaining({calculation_inputs:expect.stringContaining('"_lots":[100,500,1000]')})})));
 expect(data.mock.calls.filter(([action])=>action==='create')).toHaveLength(0);
});
