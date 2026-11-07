// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ProductionWorkspace} from '@/g03-products/production-workspace';
import {defaultProductionView} from '@/g03-products/production-columns';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function setup(){
  const state={revision:42,capturedAt:'2026-10-22',sourceVersion:'V7',view:defaultProductionView(),grants:['read','orders','machines'],lookups:{machines:['TORN'],productionStatuses:['EN PRODUCCIÓ']},catalog:[{rowNumber:2,reference:'QA-REF',client:'QA',description:'Prova'}],intake:[{rowNumber:2,reference:'QA-REF',client:'QA',description:'Prova',status:'AFEGIT AL CONTROL'}],orders:[],receipts:[],phases:[],audit:[]};
  const writes:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));state.revision++;}return {ok:true,json:async()=>structuredClone(state)};}));
  return {state,writes};
}
it('shows paused Drive import from server state without pretending a new synchronization happened',async()=>{
 const {state,writes}=setup();Object.assign(state,{sourceImportPaused:true,sourceSync:{checkedAt:'2026-10-20T10:00:00Z',pendingConflicts:[]}});
 render(<ProductionWorkspace/>);
 expect(await screen.findByText('Importació automàtica de Drive pausada · es treballa al full de Producció de G03 AI')).toBeInTheDocument();
 expect(screen.queryByText(/Drive V7 · darrera incorporació/)).not.toBeInTheDocument();
 expect(writes).toEqual([]);expect(state.revision).toBe(42);
});
it('opens Introduir referència above the intake table and visibly confirms refresh',async()=>{
  setup();render(<ProductionWorkspace/>);
  await screen.findByRole('button',{name:'Introducció comandes'});
  fireEvent.click(screen.getByRole('button',{name:'Introducció comandes'}));
  fireEvent.click(screen.getByRole('button',{name:'Introduir referència'}));
  const editor=screen.getByRole('region',{name:'Editor de Producció'});
  expect(within(editor).getByLabelText('Referència')).toHaveFocus();
  expect(editor.compareDocumentPosition(screen.getByRole('columnheader',{name:'Client detectat'}))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Actualitzar'}));
  await waitFor(()=>expect(screen.getAllByRole('status').some(item=>item.textContent?.includes('Dades actualitzades des del servidor'))).toBe(true));
});
it('keeps catalog management independent from existing order cells and uses precise catalog targets',async()=>{
  const {writes}=setup();render(<ProductionWorkspace/>);
  fireEvent.click(await screen.findByRole('button',{name:'Referències'}));
  fireEvent.click(screen.getByRole('button',{name:'Editar referència QA-REF'}));
  const editor=screen.getByRole('region',{name:'Editor de Producció'});
  fireEvent.change(within(editor).getByLabelText('Descripció'),{target:{value:'Actualitzada'}});
  fireEvent.click(within(editor).getByRole('button',{name:'Desar'}));
  await waitFor(()=>expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({action:'catalog.update',revision:42,rowNumber:2,patch:{reference:'QA-REF',client:'QA',description:'Actualitzada'}});
  await waitFor(()=>expect(screen.queryByRole('region',{name:'Editor de Producció'})).toBeNull());
  fireEvent.click(screen.getByRole('button',{name:'Retirar referència QA-REF'}));
  await waitFor(()=>expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({action:'catalog.delete',revision:43,rowNumber:2});
});
it('saves machine and dropdown lists through the durable configuration contract',async()=>{
  const {writes}=setup();render(<ProductionWorkspace/>);
  fireEvent.click(await screen.findByRole('button',{name:'Configuració'}));
  fireEvent.change(screen.getByLabelText('Màquines'),{target:{value:'TORN\nFRESA QA'}});
  fireEvent.click(screen.getByRole('button',{name:'Desar llistes'}));
  await waitFor(()=>expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({action:'configuration.update',revision:42,patch:{machines:['TORN','FRESA QA']}});
});
it('retires and restores a catalog reference through the normal UI with its original audited identity',async()=>{
 const item={rowNumber:9,reference:'QA-RESTORE',client:'QA',description:'Original exacta'};
 const state={revision:50,capturedAt:'2026-10-26',sourceVersion:'V7',view:defaultProductionView(),grants:['read','orders'],lookups:{machines:[],productionStatuses:[]},catalog:[item],orders:[],receipts:[],phases:[],audit:[] as {action:string;target:string;before:unknown;after:unknown}[]};
 const writes:Record<string,unknown>[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method==='POST'){
   const input=JSON.parse(String(init.body));writes.push(input);
   if(input.action==='catalog.delete'){state.catalog=[];state.audit.push({action:'catalog.delete',target:'9',before:structuredClone(item),after:null});}
   if(input.action==='catalog.restore'){state.catalog=[structuredClone(item)];state.audit.push({action:'catalog.restore',target:'9',before:null,after:structuredClone(item)});}
   state.revision++;
  }
  return {ok:true,json:async()=>structuredClone(state)};
 }));
 render(<ProductionWorkspace/>);fireEvent.click(await screen.findByRole('button',{name:'Referències'}));
 fireEvent.click(screen.getByRole('button',{name:'Retirar referència QA-RESTORE'}));
 const retired=await screen.findByRole('region',{name:'Referències retirades'});
 expect(within(retired).getByText('Original exacta')).toBeInTheDocument();
 fireEvent.click(within(retired).getByRole('button',{name:'Restaurar referència QA-RESTORE'}));
 await waitFor(()=>expect(screen.queryByRole('region',{name:'Referències retirades'})).not.toBeInTheDocument());
 expect(writes).toEqual([expect.objectContaining({action:'catalog.delete',revision:50,rowNumber:9}),expect.objectContaining({action:'catalog.restore',revision:51,rowNumber:9})]);
 expect(writes[1]).not.toHaveProperty('patch');
 expect(screen.getByRole('button',{name:'Retirar referència QA-RESTORE'})).toBeInTheDocument();
});
it('shows only current retired entries and never offers restoration to a read-only employee',async()=>{
 const valid={rowNumber:7,reference:'QA-RETIRED',client:null,description:null};
 const state={revision:50,capturedAt:'2026-10-26',sourceVersion:'V7',view:defaultProductionView(),grants:['read'],lookups:{machines:[],productionStatuses:[]},catalog:[{rowNumber:8,reference:'QA-ACTIVE',client:null,description:null}],orders:[],receipts:[],phases:[],audit:[
  {action:'catalog.delete',target:'7',before:valid},
  {action:'catalog.delete',target:'8',before:{...valid,rowNumber:8,reference:'QA-ACTIVE'}},
  {action:'catalog.delete',target:'9',before:{...valid,rowNumber:9,reference:'QA-RESTORED'}},
  {action:'catalog.restore',target:'9',after:{...valid,rowNumber:9,reference:'QA-RESTORED'}},
  {action:'catalog.delete',target:'10',before:{...valid,rowNumber:99,reference:'QA-WRONG-IDENTITY'}},
 ]};
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>structuredClone(state)})));
 render(<ProductionWorkspace/>);fireEvent.click(await screen.findByRole('button',{name:'Referències'}));
 const retired=screen.getByRole('region',{name:'Referències retirades'});
 expect(within(retired).getByText('QA-RETIRED')).toBeInTheDocument();
 expect(within(retired).queryByText('QA-ACTIVE')).not.toBeInTheDocument();
 expect(within(retired).queryByText('QA-RESTORED')).not.toBeInTheDocument();
 expect(within(retired).queryByText('QA-WRONG-IDENTITY')).not.toBeInTheDocument();
 expect(within(retired).queryByRole('button',{name:/Restaurar/})).not.toBeInTheDocument();
});

it('retires a selected phase through the normal UI with no main-order deletion',async()=>{
 const {state,writes}=setup();
 Object.assign(state,{phases:[{rowNumber:9,workOrder:'OF1',phaseNumber:2,machine:'TORN',state:'EN ESPERA',priority:1,observations:'Second phase'}]});
 render(<ProductionWorkspace/>);
 fireEvent.click(await screen.findByRole('button',{name:'Fases OF'}));
 fireEvent.click(screen.getByRole('button',{name:'Retirar fase 2 de l’OF OF1'}));
 await waitFor(()=>expect(writes).toHaveLength(1));
 expect(writes[0]).toMatchObject({action:'phase.delete',revision:42,rowNumber:9});
 expect(writes[0]).not.toHaveProperty('patch');
});
it('does not expose phase retirement for a read-only employee',async()=>{
 const {state,writes}=setup();Object.assign(state,{grants:['read'],phases:[{rowNumber:9,workOrder:'OF1',phaseNumber:2,machine:'TORN',state:'EN ESPERA',priority:1,observations:null}]});
 render(<ProductionWorkspace/>);fireEvent.click(await screen.findByRole('button',{name:'Fases OF'}));
 expect(screen.queryByRole('button',{name:/Retirar fase/})).not.toBeInTheDocument();expect(writes).toEqual([]);
});
