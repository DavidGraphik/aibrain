// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { ProductionWorkspace } from '@/g03-products/production-workspace';
import { ProductionAppSurface } from '@/g03-products/production-app-surface';
import { defaultProductionTabs } from '@/g03-products/production-design-contract';
import { defaultProductionView } from '@/g03-products/production-columns';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const id='11111111-1111-4111-8111-111111111111';
it('mounts a functional custom tab, replaces an existing view and reloads a changed program version',async()=>{
 const state={revision:1,capturedAt:'2026-10-27',sourceVersion:'V7',view:defaultProductionView(),grants:['read','orders','machines'],lookups:{machines:[],productionStatuses:[]},orders:[],phases:[],receipts:[],audit:[],design:{tabs:[...defaultProductionTabs().map(t=>t.builtin==='Producció'?{...t,label:'Producció amb calculador',appId:id}:t),{key:'new',label:'Projectes nous',appId:id}],programVersions:{[id]:1}}};
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>structuredClone(state)})));
 render(<ProductionWorkspace/>);expect(await screen.findByTitle('Producció amb calculador')).toHaveAttribute('src',expect.stringContaining('published=1'));
 expect(screen.queryByRole('table')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Projectes nous'}));expect(screen.getByTitle('Projectes nous')).toBeInTheDocument();
 const oldFrame=screen.getByTitle('Projectes nous');state.design.programVersions[id]=2;
 fireEvent.click(screen.getByRole('button',{name:'Actualitzar'}));await waitFor(()=>expect(screen.getByTitle('Projectes nous')).not.toBe(oldFrame));
 fireEvent.click(screen.getByRole('button',{name:'Fases OF'}));expect(screen.getByRole('table')).toBeInTheDocument();
});
it('binds the program bridge to its iframe/channel/app and keeps preview requests isolated',async()=>{
 const request=vi.fn(async(_url:unknown,_init?:RequestInit)=>({ok:true,json:async()=>({revision:7,rows:[{id:'row',values:{result:24}}]})}));vi.stubGlobal('fetch',request);
 render(<ProductionAppSurface id={id} title="Calculador" preview/>);const iframe=screen.getByTitle('Calculador')as HTMLIFrameElement;
 const channel=new URL(iframe.src).searchParams.get('channel');
 const message={type:'aibrain-app-data',channel,requestId:'1',operation:'production.mutate',input:{action:'order.create',revision:1,reason:'Preview',patch:{workOrder:'QA'}}};
 fireEvent(window,new MessageEvent('message',{source:window,data:message}));expect(request).not.toHaveBeenCalled();
 fireEvent(window,new MessageEvent('message',{source:iframe.contentWindow,data:{...message,channel:'foreign'}}));expect(request).not.toHaveBeenCalled();
 const response=vi.spyOn(iframe.contentWindow!,'postMessage');
 fireEvent(window,new MessageEvent('message',{source:iframe.contentWindow,data:{...message,id:'OTHER',sandbox:false}}));
 await waitFor(()=>expect(request).toHaveBeenCalledTimes(1));
 expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({id,sandbox:true,operation:'production.mutate',input:message.input});
 await waitFor(()=>expect(response).toHaveBeenCalledWith(expect.objectContaining({type:'aibrain-app-result',requestId:'1',channel,result:{revision:7,rows:[{id:'row',values:{result:24}}]}}),'*'));
});
