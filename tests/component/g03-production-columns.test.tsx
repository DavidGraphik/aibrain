// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ProductionWorkspace} from '@/g03-products/production-workspace';
import {defaultProductionView} from '@/g03-products/production-columns';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('renders Client, Referència and Descripció as source text while retaining operational editors and new order entry',async()=>{
  const state={revision:42,capturedAt:'2026-10-20',sourceVersion:'V7',view:defaultProductionView(),grants:['read','orders','machines'],lookups:{machines:['M1'],productionStatuses:['NO COMENÇAT']},orders:[{rowNumber:30,workOrder:'OF-1',client:'Client font',reference:'REF1',description:'Peça original',statusComment:'Comentari editable'}],receipts:[],phases:[],audit:[]};
  const fetcher=vi.fn(async()=>({ok:true,json:async()=>state}));vi.stubGlobal('fetch',fetcher);
  render(<ProductionWorkspace/>);
  for(const [label,value] of [['Client','Client font'],['Referència','REF1'],['Descripció','Peça original']]){
    const cell=await screen.findByLabelText(`${label} OF OF-1`);
    expect(cell.tagName).toBe('SPAN');expect(cell).toHaveTextContent(value);expect(cell).toHaveAttribute('title',value);
    expect(screen.queryByRole('textbox',{name:`${label} OF OF-1`})).not.toBeInTheDocument();
    expect(screen.getByRole('main',{name:'Producció'}).style.getPropertyValue('--g03-production-header-font-size')).toBe('12px');
  }
  expect(screen.getByRole('textbox',{name:'Comentari OF OF-1'})).toBeEnabled();
  expect(screen.getByRole('separator',{name:'Amplada Client'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Introduir comanda'}));
  expect(screen.getByRole('textbox',{name:'Client'})).not.toHaveAttribute('readonly');
  expect(screen.getByRole('textbox',{name:'Descripció'})).not.toHaveAttribute('readonly');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps machine/status/material readable, saves keyboard resizing using personal revision and restores server readback',async()=>{
  const view=defaultProductionView();view.revision=7;
  const state={revision:42,capturedAt:'2026-10-20',sourceVersion:'V7',view,grants:['read','orders','machines'],lookups:{machines:['TORN CNC MÀQUINA COMPLETA'],productionStatuses:['PENDENT MATERIAL']},orders:[{rowNumber:30,workOrder:'OF-1',assignedMachine:'TORN CNC MÀQUINA COMPLETA',productionStatus:'PENDENT MATERIAL',materialStatus:'PDT.COMPTAR',statusComment:'Comentari complet'}],receipts:[],phases:[],audit:[]};
  const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST'){const input=JSON.parse(String(init.body));return {ok:true,json:async()=>({revision:8,columnWidths:{...view.columnWidths,...input.columnWidths}})};}
    return {ok:true,json:async()=>state};
  });vi.stubGlobal('fetch',fetcher);
  const first=render(<ProductionWorkspace/>);
  const handle=await screen.findByRole('separator',{name:'Amplada Màquina'});
  expect(handle).toHaveAttribute('aria-valuenow','210');
  expect(screen.getByLabelText('Màquina OF OF-1')).toHaveAttribute('title','TORN CNC MÀQUINA COMPLETA');
  expect(screen.getByLabelText('Estat OF OF-1')).toHaveAttribute('title','PENDENT MATERIAL');
  fireEvent.keyDown(handle,{key:'ArrowRight',shiftKey:true});
  await waitFor(()=>expect(handle).toHaveAttribute('aria-valuenow','260'));
  const input=JSON.parse(String(fetcher.mock.calls.find(([,init])=>init?.method==='POST')?.[1]?.body));
  expect(input).toMatchObject({action:'view.update',revision:7,columnWidths:{assignedMachine:260}});
  expect(input).not.toHaveProperty('patch');
  first.unmount();state.view={revision:8,columnWidths:{...view.columnWidths,assignedMachine:260}};
  render(<ProductionWorkspace/>);
  expect(await screen.findByRole('separator',{name:'Amplada Màquina'})).toHaveAttribute('aria-valuenow','260');
});
it('previews a pointer drag without writing rows, saves once on release and abandons a cancelled drag',async()=>{
  vi.stubGlobal('PointerEvent',MouseEvent);
  const state={revision:20,capturedAt:'2026-10-20',sourceVersion:'V7',view:defaultProductionView(),grants:['read'],lookups:{machines:[],productionStatuses:[]},orders:[],receipts:[],phases:[],audit:[]};
  const writes:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST'){const input=JSON.parse(String(init.body));writes.push(input);return {ok:true,json:async()=>({revision:1,columnWidths:{...state.view.columnWidths,...input.columnWidths}})};}
    return {ok:true,json:async()=>state};
  }));
  render(<ProductionWorkspace/>);
  const handle=await screen.findByRole('separator',{name:'Amplada Màquina'});
  Object.assign(handle,{setPointerCapture:vi.fn(),hasPointerCapture:()=>false});
  fireEvent.pointerDown(handle,{button:0,clientX:100});fireEvent.pointerMove(handle,{clientX:180});
  expect(handle).toHaveAttribute('aria-valuenow','290');expect(writes).toHaveLength(0);
  fireEvent.pointerUp(handle,{clientX:180});
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Amplada desada'));
  expect(writes).toEqual([expect.objectContaining({action:'view.update',revision:0,columnWidths:{assignedMachine:290}})]);
  fireEvent.pointerDown(handle,{button:0,clientX:100});fireEvent.pointerMove(handle,{clientX:900});fireEvent.pointerCancel(handle);
  expect(handle).toHaveAttribute('aria-valuenow','290');expect(writes).toHaveLength(1);
});
it('ignores a delayed pre-save refresh after confirmed widths and newer order data were read back',async()=>{
  const view=defaultProductionView();view.revision=7;
  const state={revision:43,capturedAt:'2026-10-20',sourceVersion:'V7',view,grants:['read','orders'],lookups:{machines:[],productionStatuses:[]},orders:[{rowNumber:30,workOrder:'OF-1',statusComment:'Actualitzat'}],receipts:[],phases:[],audit:[]};
  let resolveOld!: (value:unknown)=>void;
  let reads=0;
  const writes:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST'){
      const input=JSON.parse(String(init.body));writes.push(input);
      return {ok:true,json:async()=>({revision:Number(input.revision)+1,columnWidths:{...view.columnWidths,...input.columnWidths}})};
    }
    reads++;
    if(reads===2)return new Promise(resolve=>{resolveOld=resolve;});
    return {ok:true,json:async()=>state};
  }));
  render(<ProductionWorkspace/>);
  const handle=await screen.findByRole('separator',{name:'Amplada Màquina'});
  fireEvent.click(screen.getByRole('button',{name:'Actualitzar'})); // The pending response has an older snapshot.
  fireEvent.keyDown(handle,{key:'ArrowRight',shiftKey:true});
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Amplada desada'));
  await act(async()=>{resolveOld({ok:true,json:async()=>({...state,revision:42,orders:[{...state.orders[0],statusComment:'Abans'}]})});});
  expect(handle).toHaveAttribute('aria-valuenow','260');
  expect(screen.getByLabelText('Comentari OF OF-1')).toHaveValue('Actualitzat');
  fireEvent.keyDown(handle,{key:'ArrowRight'});
  await waitFor(()=>expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({revision:8,columnWidths:{assignedMachine:270}});
});
it('restores the current server layout and shows the conflict when a resize uses a stale view revision',async()=>{
  const state={revision:42,capturedAt:'2026-10-20',sourceVersion:'V7',view:defaultProductionView(),grants:['read'],lookups:{machines:[],productionStatuses:[]},orders:[],receipts:[],phases:[],audit:[]};
  let reads=0;
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST')return {ok:false,json:async()=>({error:'Actualitza abans de tornar a desar.'})};
    reads++;return {ok:true,json:async()=>reads===1?state:{...state,view:{revision:9,columnWidths:{...state.view.columnWidths,assignedMachine:350}}}};
  }));
  render(<ProductionWorkspace/>);
  const handle=await screen.findByRole('separator',{name:'Amplada Màquina'});
  fireEvent.keyDown(handle,{key:'ArrowRight'});
  expect(await screen.findByRole('alert')).toHaveTextContent('Actualitza abans de tornar a desar.');
  expect(handle).toHaveAttribute('aria-valuenow','350');
});
it('refreshes orders during a pending width save and retains the confirmed view if that in-flight refresh finishes later',async()=>{
  const view=defaultProductionView();view.revision=7;
  const state={revision:42,capturedAt:'2026-10-20',sourceVersion:'V7',view,grants:['read'],lookups:{machines:[],productionStatuses:[]},orders:[{rowNumber:30,workOrder:'OF-1',statusComment:'Abans'}],receipts:[],phases:[],audit:[]};
  let finishSave!:(value:unknown)=>void,finishRead!:(value:unknown)=>void,reads=0;
  const newer={...state,revision:43,orders:[{...state.orders[0],statusComment:'Actualitzat'}]};
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST')return new Promise(resolve=>{finishSave=resolve;});
    reads++;if(reads===3)return new Promise(resolve=>{finishRead=resolve;});
    return {ok:true,json:async()=>reads===1?state:newer};
  }));
  render(<ProductionWorkspace/>);
  const handle=await screen.findByRole('separator',{name:'Amplada Màquina'});
  fireEvent.keyDown(handle,{key:'ArrowRight',shiftKey:true});
  fireEvent.click(screen.getByRole('button',{name:'Actualitzar'}));
  await waitFor(()=>expect(screen.getByLabelText('Comentari OF OF-1')).toHaveValue('Actualitzat'));
  expect(handle).toHaveAttribute('aria-valuenow','260');
  fireEvent.click(screen.getByRole('button',{name:'Actualitzar'}));
  await act(async()=>{finishSave({ok:true,json:async()=>({revision:8,columnWidths:{...view.columnWidths,assignedMachine:260}})});});
  await act(async()=>{finishRead({ok:true,json:async()=>newer});});
  expect(handle).toHaveAttribute('aria-valuenow','260');
  expect(screen.getByLabelText('Comentari OF OF-1')).toHaveValue('Actualitzat');
});
it('offers blank, single and double checks and persists changes without losing existing source values',async()=>{
  const state={revision:42,capturedAt:'2026-10-23',sourceVersion:'V7',view:defaultProductionView(),grants:['read','orders'],lookups:{machines:[],productionStatuses:[]},orders:[{rowNumber:30,workOrder:'OF-1',printStatus:'FET'},{rowNumber:31,workOrder:'OF-2',printStatus:'✓✓'}],receipts:[],phases:[],audit:[]};
  const writes:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST'){
      const input=JSON.parse(String(init.body));writes.push(input);
      const order=state.orders.find(o=>o.rowNumber===input.rowNumber)!;order.printStatus=input.patch.printStatus;
      state.revision++;return {ok:true,json:async()=>({revision:state.revision})};
    }
    return {ok:true,json:async()=>state};
  }));
  const first=render(<ProductionWorkspace/>);
  const selector=await screen.findByRole('combobox',{name:'Impressió OF OF OF-1'});
  expect(selector).toHaveValue('FET');
  expect(Array.from((selector as HTMLSelectElement).options,o=>o.value)).toEqual(['','FET','✓','✓✓']);
  expect(screen.getByRole('combobox',{name:'Impressió OF OF OF-2'})).toHaveValue('✓✓');
  fireEvent.change(selector,{target:{value:'✓'}});
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Canvi desat'));
  expect(writes).toEqual([expect.objectContaining({action:'order.update',revision:42,rowNumber:30,patch:{printStatus:'✓'}})]);
  fireEvent.change(screen.getByRole('combobox',{name:'Impressió OF OF OF-1'}),{target:{value:'✓✓'}});
  await waitFor(()=>expect(writes).toHaveLength(2));
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'Impressió OF OF OF-1'})).toBeEnabled());
  fireEvent.change(screen.getByRole('combobox',{name:'Impressió OF OF OF-1'}),{target:{value:''}});
  await waitFor(()=>expect(writes).toHaveLength(3));expect(writes[2]).toMatchObject({revision:44,patch:{printStatus:null}});
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'Impressió OF OF OF-1'})).toBeEnabled());
  first.unmount();state.grants=['read'];render(<ProductionWorkspace/>);
  expect(await screen.findByRole('combobox',{name:'Impressió OF OF OF-1'})).toHaveValue('');
  expect(screen.getByRole('combobox',{name:'Impressió OF OF OF-1'})).toBeDisabled();
  expect(state.orders[1].printStatus).toBe('✓✓');
});
it('renders the persisted personal Arial 10pt view after reload while keeping all saved widths',async()=>{
 const view={...defaultProductionView(),revision:8,fontFamily:'Arial' as const,fontSizePt:10,columnWidths:{...defaultProductionView().columnWidths,assignedMachine:188}};
 const state={revision:42,capturedAt:'2026-10-26',sourceVersion:'V7',view,grants:['read'],lookups:{machines:[],productionStatuses:[]},orders:[{rowNumber:30,workOrder:'OF-1',reference:'QA'}],receipts:[],phases:[],audit:[]};
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>structuredClone(state)})));
 const first=render(<ProductionWorkspace/>);
 expect(await screen.findByText(/Lletra: Arial 10 pt/)).toBeInTheDocument();
 expect(screen.getByRole('main',{name:'Producció'})).toHaveStyle({fontFamily:'Arial',fontSize:'10pt'});
 expect(screen.getByRole('main',{name:'Producció'}).style.getPropertyValue('--g03-production-header-font-size')).toBe('10pt');
 expect(screen.getByRole('separator',{name:'Amplada Màquina'})).toHaveAttribute('aria-valuenow','188');
 first.unmount();render(<ProductionWorkspace/>);
 expect(await screen.findByText(/Lletra: Arial 10 pt/)).toBeInTheDocument();
 expect(screen.getByRole('main',{name:'Producció'})).toHaveStyle({fontFamily:'Arial',fontSize:'10pt'});
 expect(screen.getByRole('main',{name:'Producció'}).style.getPropertyValue('--g03-production-header-font-size')).toBe('10pt');
});
