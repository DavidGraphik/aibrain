// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ProductionWorkspace} from '@/g03-products/production-workspace';
import {defaultProductionView} from '@/g03-products/production-columns';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function setup(){
 const state={revision:3,capturedAt:'2026-11-02',sourceVersion:'V7',view:defaultProductionView(),grants:['read'],lookups:{machines:[],productionStatuses:[]},configuration:{},orders:[{rowNumber:8,workOrder:'377/30',client:'GSTMP',materialStatus:'PENDENT',materialReference:'Original material'}],receipts:[],phases:[],audit:[],deliveredHistory:[{rowNumber:1,workOrder:'149/10',client:'HRMS',reference:'MT11000GG-DBG-01',description:'CÀRTER EIX',salesOrder:'3077000012',units:104,deliveryDate:'2024-03-05'},{rowNumber:2,workOrder:'602/5',client:'OTHER',reference:'SECOND',description:'Suport',salesOrder:'987',units:21,deliveryDate:'2025-02-03'}]};
 const fetcher=vi.fn(async()=>({ok:true,json:async()=>structuredClone(state)}));vi.stubGlobal('fetch',fetcher);return {state,fetcher};
}
it('keeps summary in the source banner and row/filter selection never opens the unused material panel',async()=>{
 const {state,fetcher}=setup();render(<ProductionWorkspace/>);
 const cell=await screen.findByLabelText('Client OF 377/30');
 const summary=screen.getByLabelText('Resum de producció');
 expect(summary.parentElement?.textContent).toContain('revisió 3');
 expect(within(summary).getByText('Ordres obertes')).toBeInTheDocument();
 fireEvent.click(cell);fireEvent.change(screen.getByLabelText('Buscar OF'),{target:{value:'GST'}});
 expect(cell.closest('tr')).toHaveAttribute('data-selected','true');
 expect(screen.queryByText(/Material i traçabilitat/)).not.toBeInTheDocument();
 expect(screen.queryByLabelText('Referència de material')).not.toBeInTheDocument();
 expect(state.orders[0].materialReference).toBe('Original material');expect(fetcher).toHaveBeenCalledTimes(1);
});
it('searches all delivered history fields, ignores case/accents, clears and preserves source rows',async()=>{
 const {state,fetcher}=setup();render(<ProductionWorkspace/>);fireEvent.click(await screen.findByRole('button',{name:'Entregats'}));
 const search=screen.getByRole('searchbox',{name:'Buscar entregats'});
 for(const query of ['149/10','hrms','mt11000gg','carter','3077000012','104','2024-03-05']){
  fireEvent.change(search,{target:{value:query}});
  expect(screen.getByText('149/10')).toBeInTheDocument();expect(screen.queryByText('602/5')).not.toBeInTheDocument();
 }
 fireEvent.change(search,{target:{value:'nothing matches'}});expect(screen.getByText('No hi ha entregues que coincideixin amb la cerca.')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Netejar cerca'}));expect(search).toHaveValue('');expect(screen.getByText('602/5')).toBeInTheDocument();expect(state.deliveredHistory).toHaveLength(2);expect(fetcher).toHaveBeenCalledTimes(1);
});

it('counts only non-completed order rows in the same unfiltered dashboard KPI',async()=>{
 const {state}=setup();
 state.orders.push(Object.assign({rowNumber:9,workOrder:'QA-2',client:'X',materialStatus:'PENDENT',materialReference:'M'}, {productionStatus:' ENTREGAT '}));
 state.orders.push(Object.assign({rowNumber:10,workOrder:'QA-3',client:'Y',materialStatus:'PENDENT',materialReference:'M'}, {productionStatus:'LLEST PER SERVIR'}));
 state.orders.push(Object.assign({rowNumber:11,workOrder:'QA-4',client:'Z',materialStatus:'PENDENT',materialReference:'M'}, {productionStatus:''}));
 render(<ProductionWorkspace/>);await screen.findByLabelText('Client OF 377/30');
 const summary=screen.getByLabelText('Resum de producció');
 expect(within(summary).getByText('Ordres obertes').parentElement).toHaveTextContent('Ordres obertes 2');
 fireEvent.change(screen.getByLabelText('Buscar OF'),{target:{value:'QA-2'}});
 expect(within(summary).getByText('Ordres obertes').parentElement).toHaveTextContent('Ordres obertes 2');
});

it('updates the overdue KPI at Madrid midnight without waiting for a data refresh',async()=>{
 vi.useFakeTimers();
 try {
  vi.setSystemTime(new Date('2026-11-04T22:59:59.000Z'));
  const {state,fetcher}=setup();
  Object.assign(state.orders[0],{productionStatus:'NO COMENÇAT',deliveryDate:'2026-11-04'});
  state.orders.push(Object.assign({rowNumber:9,workOrder:'QA-2',client:'X',materialStatus:'PENDENT',materialReference:'M'}, {productionStatus:'LLEST PER SERVIR',deliveryDate:'2026-11-01'}));
  await act(async()=>{render(<ProductionWorkspace/>);});
  const summary=screen.getByLabelText('Resum de producció');
  expect(within(summary).getByText('Entrega vençuda').parentElement).toHaveTextContent('Entrega vençuda 0');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(within(summary).getByText('Entrega vençuda').parentElement).toHaveTextContent('Entrega vençuda 1');
  expect(fetcher).toHaveBeenCalledTimes(1);
 } finally {vi.useRealTimers();}
});
