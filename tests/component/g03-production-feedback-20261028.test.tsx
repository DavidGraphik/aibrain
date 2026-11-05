// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ProductionWorkspace} from '@/g03-products/production-workspace';
import {ProductionTableViewport} from '@/g03-products/production-table-viewport';
import {defaultProductionView} from '@/g03-products/production-columns';
import type {ProductionState} from '@/g03-products/contracts';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function setup(grants=['read','machines','orders']){
 const state={revision:3,capturedAt:'2026-10-28',sourceVersion:'V7',view:defaultProductionView(),grants,lookups:{machines:[],productionStatuses:[]},configuration:{},orders:[{rowNumber:8,workOrder:'QA',materialStatus:'PENDENT'}],receipts:[],phases:[],audit:[],tasks:[{rowNumber:2,owner:'QA',description:'Original',done:false}]} as unknown as ProductionState&{grants:string[];view:ReturnType<typeof defaultProductionView>};
 const writes:Record<string,unknown>[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
  if(init?.method==='POST'){
   const input=JSON.parse(String(init.body));writes.push(input);
   if(input.action==='configuration.update')state.configuration={...state.configuration,...input.patch};
   if(input.action==='task.create')state.tasks!.push({rowNumber:3,...input.patch});
   if(input.action==='task.update')Object.assign(state.tasks!.find(t=>t.rowNumber===input.rowNumber)!,input.patch);
   if(input.action==='task.delete'){const task=state.tasks!.find(t=>t.rowNumber===input.rowNumber)!;state.audit.push({action:'task.delete',target:String(task.rowNumber),before:task} as ProductionState['audit'][number]);state.tasks=state.tasks!.filter(t=>t!==task);}
   if(input.action==='task.restore'){const task=state.audit.at(-1)!.before as NonNullable<ProductionState['tasks']>[number];state.tasks!.push(task);state.audit.push({action:'task.restore',target:String(task.rowNumber)} as ProductionState['audit'][number]);}
   state.revision++;
  }
  return {ok:true,json:async()=>structuredClone(state)};
 }));
 return {state,writes};
}
it('saves a material color from the configuration UI using the actual canonical cell value and shows readback',async()=>{
 const {writes}=setup();render(<ProductionWorkspace/>);fireEvent.click(await screen.findByRole('button',{name:'Configuració'}));
 fireEvent.change(screen.getByLabelText('Columna'),{target:{value:'materialStatus'}});
 fireEvent.change(screen.getByLabelText('Valor de la cel·la'),{target:{value:' pendent '}});
 fireEvent.change(screen.getByLabelText('Color',{exact:true}),{target:{value:'#ff0000'}});
 fireEvent.click(screen.getByRole('button',{name:'Desar color'}));
 await waitFor(()=>expect(writes).toHaveLength(1));
 expect(writes[0]).toMatchObject({action:'configuration.update',revision:3,patch:{cellColors:{materialStatus:{PENDENT:'#ff0000'}}}});
 expect(await screen.findByText(/Color desat: #ff0000/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Producció'}));
 expect(screen.getByRole('combobox',{name:'Material OF QA'}).closest('td')).toHaveStyle({backgroundColor:'#ff0000'});
});
it('creates, edits, retires and restores tasks through the UI without replacing the original',async()=>{
 const {state,writes}=setup();render(<ProductionWorkspace/>);fireEvent.click(await screen.findByRole('button',{name:'Tasques'}));
 fireEvent.click(screen.getByRole('button',{name:'Nova tasca'}));
 let editor=screen.getByRole('region',{name:'Editor de tasca'});
 fireEvent.change(within(editor).getByLabelText('Responsable'),{target:{value:'QA2'}});fireEvent.change(within(editor).getByLabelText('Tasca'),{target:{value:'Nova'}});fireEvent.click(within(editor).getByRole('button',{name:'Desar tasca'}));
 await screen.findByText('Nova');expect(state.tasks![0]).toEqual({rowNumber:2,owner:'QA',description:'Original',done:false});
 fireEvent.click(screen.getByRole('button',{name:'Editar tasca 3'}));editor=screen.getByRole('region',{name:'Editor de tasca'});
 fireEvent.change(within(editor).getByLabelText('Tasca'),{target:{value:'Editada'}});fireEvent.click(within(editor).getByRole('button',{name:'Desar tasca'}));
 await screen.findByText('Editada');fireEvent.click(screen.getByRole('button',{name:'Retirar tasca 3'}));
 fireEvent.click(await screen.findByRole('button',{name:'Restaurar tasca 3'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Restaurar tasca 3'})).not.toBeInTheDocument());
 expect(writes.map(w=>w.action)).toEqual(['task.create','task.update','task.delete','task.restore']);
 expect(state.tasks![0].description).toBe('Original');expect(state.tasks![1].description).toBe('Editada');
});
it('keeps task controls inaccessible to a read-only user',async()=>{
 const {writes}=setup(['read']);render(<ProductionWorkspace/>);fireEvent.click(await screen.findByRole('button',{name:'Tasques'}));
 expect(screen.queryByRole('button',{name:'Nova tasca'})).toBeNull();expect(screen.queryByRole('button',{name:'Retirar tasca 2'})).toBeNull();expect(screen.getByRole('checkbox')).toBeDisabled();expect(writes).toHaveLength(0);
});
it('keeps the horizontal slider synchronized with sheet scroll and observes geometry changes',()=>{
 let measure:()=>void=()=>{};vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){measure=callback;}observe(){}disconnect(){}});
 render(<ProductionTableViewport label="Prova"><table><tbody><tr><td>Ample</td></tr></tbody></table></ProductionTableViewport>);
 const region=screen.getByRole('region',{name:'Prova'});
 Object.defineProperties(region,{scrollWidth:{configurable:true,value:1200},clientWidth:{configurable:true,value:400}});
 fireEvent(window,new Event('resize'));const slider=screen.getByRole('slider',{name:'Desplaçament horitzontal: Prova'});
 expect(slider).toHaveAttribute('max','800');fireEvent.change(slider,{target:{value:'300'}});expect(region.scrollLeft).toBe(300);
 region.scrollLeft=450;fireEvent.scroll(region);expect(slider).toHaveValue('450');
 measure();
});

it('saves the DOM color even when a native picker updates it without a React change event',async()=>{
 const {writes}=setup();render(<ProductionWorkspace/>);fireEvent.click(await screen.findByRole('button',{name:'Configuració'}));
 fireEvent.change(screen.getByLabelText('Columna'),{target:{value:'materialStatus'}});
 fireEvent.change(screen.getByLabelText('Valor de la cel·la'),{target:{value:' pendent '}});
 const picker=screen.getByLabelText('Color',{exact:true}) as HTMLInputElement;
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(picker,'#ff0000');
 expect(picker.value).toBe('#ff0000');
 fireEvent.submit(picker.closest('form')!);
 await waitFor(()=>expect(writes).toHaveLength(1));
 expect(writes[0]).toMatchObject({action:'configuration.update',patch:{cellColors:{materialStatus:{PENDENT:'#ff0000'}}}});
 expect(await screen.findByText(/Color desat: #ff0000/)).toBeInTheDocument();
 expect(picker).toHaveValue('#ff0000');
 fireEvent.click(screen.getByRole('button',{name:'Producció'}));
 expect(screen.getByRole('combobox',{name:'Material OF QA'}).closest('td')).toHaveStyle({backgroundColor:'#ff0000'});
});
