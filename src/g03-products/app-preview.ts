import path from 'node:path';
import type { ProductContext } from './access';
import { ProductStore } from './persistence';
import { ProductError,requireProduct,type MiniApp,type ProductionState } from './contracts';
/** A persistent synthetic workspace, never a copy or mutation of the working sheet. */
export async function appPreviewContext(ctx:ProductContext,id:string,workspaceId=id){
  requireProduct(ctx.appDesigner===true,'No tens permís de disseny.',403);
  const source=await ctx.store.read<MiniApp>(`app-${id}`);requireProduct(source&&(source.owner===ctx.actor||source.productionManaged),'Programa no disponible.',403);
  requireProduct(/^[a-f0-9-]{36}$/.test(workspaceId),'Espai de prova invàlid.');
  const store=new ProductStore(path.join(ctx.store.root,'previews',ctx.actor,workspaceId),ctx.installationId);
  const prior=await store.read<MiniApp>(`app-${id}`),latest=source.versions.at(-1)!;
  if(!prior||prior.publishedVersion!==latest.version){
    await store.mutate<MiniApp,void>(`app-${id}`,()=>({...structuredClone(source),owner:ctx.actor,revision:0,rows:[],deletedRows:[],audit:[]}),app=>{
      app.versions=structuredClone(source.versions);app.publishedVersion=latest.version;app.shared=true;
    },prior?.revision??0).catch(async(error:unknown)=>{if(!(error instanceof ProductError)||error.status!==409||(await store.read<MiniApp>(`app-${id}`))?.publishedVersion!==latest.version)throw error;});
  }
  if(!await store.read('production'))await store.mutate<ProductionState,void>('production',()=>({revision:0,capturedAt:new Date().toISOString(),sourceVersion:'Prova aïllada',lookups:{machines:['MÀQUINA DE PROVA'],productionStatuses:['NO COMENÇAT','EN PRODUCCIÓ','ENTREGAT']},orders:[],phases:[],receipts:[],sageKeys:[],audit:[]}),()=>{},0).catch(async(error:unknown)=>{if(!(error instanceof ProductError)||error.status!==409||!await store.read('production'))throw error;});
  return {...ctx,store,syntheticPreview:true as const};
}
