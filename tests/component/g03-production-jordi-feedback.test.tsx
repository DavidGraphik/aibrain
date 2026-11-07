// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ProductionWorkspace} from '@/g03-products/production-workspace';
import {defaultProductionView} from '@/g03-products/production-columns';
import type {Order} from '@/g03-products/contracts';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function setup(){
  const state={revision:42,capturedAt:'2026-10-26',sourceVersion:'V7',view:defaultProductionView(),grants:['read','orders','machines'],lookups:{machines:['TORN'],productionStatuses:['NO COMENÇAT','EN PRODUCCIÓ','PDT. ENCAIXAR']},orders:[
    {rowNumber:30,workOrder:'559/5',deliveryDate:'2026-10-25',assignedMachine:'TORN',productionStatus:'NO COMENÇAT'},
    {rowNumber:31,workOrder:'181/5',deliveryDate:'2026-10-26'},
    {rowNumber:32,workOrder:'2/5',deliveryDate:'2026-11-02'},
    {rowNumber:33,workOrder:'181/5',deliveryDate:'2026-11-03'},
    {rowNumber:34,workOrder:null,deliveryDate:null}
  ] as Order[],receipts:[],phases:[{rowNumber:2,workOrder:'181/5',phaseNumber:1,machine:'TORN',state:'EN ESPERA',priority:10}],audit:[]};
  const writes:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST'){
      const input=JSON.parse(String(init.body));writes.push(input);
      Object.assign(state.orders.find(o=>o.rowNumber===input.rowNumber)??{},input.patch);state.revision++;
    }
    return {ok:true,json:async()=>structuredClone(state)};
  }));
  render(<ProductionWorkspace/>);return {state,writes};
}

it('filters delivery dates inclusively, excludes undated rows, combines existing filters and clears without writing',async()=>{
  const {writes}=setup();await screen.findByLabelText('Filtrar entrega des de');
  fireEvent.change(screen.getByLabelText('Filtrar entrega des de'),{target:{value:'2026-10-26'}});
  fireEvent.change(screen.getByLabelText('Filtrar entrega fins a'),{target:{value:'2026-11-02'}});
  expect(screen.queryByLabelText('OF OF 559/5')).not.toBeInTheDocument();
  expect(screen.getByLabelText('OF OF 181/5')).toHaveValue('181/5');
  expect(screen.getByLabelText('OF OF 2/5')).toHaveValue('2/5');
  expect(screen.queryByLabelText('OF OF null')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Buscar OF'),{target:{value:'2/5'}});
  expect(screen.queryByLabelText('OF OF 181/5')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Buscar OF'),{target:{value:''}});
  fireEvent.click(screen.getByRole('button',{name:'Netejar filtre d’entrega'}));
  expect(screen.getByLabelText('OF OF 559/5')).toBeInTheDocument();
  expect(screen.getByLabelText('OF OF null')).toBeInTheDocument();expect(writes).toEqual([]);
});

it('keeps every status option readable on a black selected cell and permits clearing a machine explicitly',async()=>{
  const {writes}=setup();const status=await screen.findByRole('combobox',{name:'Estat OF 559/5'});
  expect(status.closest('td')).toHaveStyle({backgroundColor:'#000000',color:'#FFFFFF'});
  for(const option of within(status).getAllByRole('option'))expect(option).toHaveStyle({backgroundColor:'#FFFFFF',color:'#18232D'});
  const machine=screen.getByRole('combobox',{name:'Màquina OF 559/5'});
  expect(within(machine).getByRole('option',{name:'Sense màquina'})).toHaveValue('');
  fireEvent.change(machine,{target:{value:''}});
  await waitFor(()=>expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({action:'order.update',rowNumber:30,patch:{assignedMachine:null}});
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'Màquina OF 559/5'})).toHaveValue(''));
});

it('uses ordered distinct OF choices for both new and existing phases and labels phase load by OF',async()=>{
  setup();fireEvent.click(await screen.findByRole('button',{name:'Fases OF'}));
  const existing=screen.getByRole('combobox',{name:'OF fase 2'});
  expect(Array.from((existing as HTMLSelectElement).options,o=>o.value)).toEqual(['','2/5','181/5','559/5']);
  fireEvent.click(screen.getByRole('button',{name:'Nova fase'}));
  const editor=screen.getByRole('region',{name:'Editor de Producció'});
  expect(Array.from((within(editor).getByLabelText('OF') as HTMLSelectElement).options,o=>o.value)).toEqual(['2/5','181/5','559/5']);
  fireEvent.click(screen.getByRole('button',{name:'Càrrega maquinària'}));
  const machine=screen.getByRole('heading',{name:/TORN\s*2 treballs/}).closest('article')!;
  expect(within(machine).getByText('OF181/5',{selector:'strong'})).toBeInTheDocument();
  expect(within(machine).queryByText('FASE 181/5',{selector:'strong'})).not.toBeInTheDocument();
});
