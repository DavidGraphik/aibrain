import { readProductionDesign,mutateProductionDesign } from './production-design';
import { appPreviewContext } from './app-preview';
import type { ProductContext } from './access';
import { object,text,requireProduct } from './contracts';
import { readApp,mutateApp } from './apps';
import { mutateProduction } from './production';
import { readProductionBridge } from './production-bridge-read';
export async function appBridge(ctx:ProductContext,raw:unknown){
  const body=object(raw),id=text(body.id,36),operation=text(body.operation,40);
  requireProduct(body.sandbox===undefined||typeof body.sandbox==='boolean','Àmbit de prova invàlid.');
  const originalContext=ctx;
  if(body.sandbox===true){await readApp(ctx,id);ctx=await appPreviewContext(ctx,id,body.previewWorkspaceId===undefined?id:text(body.previewWorkspaceId,36));}
  const app=await readApp(ctx,id,true);requireProduct(app.shared,'Programa de Producció no compartit.',403);
  if(operation==='design.read')return readProductionDesign(ctx);
  if(operation==='design.apply'&&body.sandbox===true){const input=object(body.input);if(Array.isArray(input.tabs))for(const tab of input.tabs){const value=object(tab);if(typeof value.appId==='string')await appPreviewContext(originalContext,value.appId,body.previewWorkspaceId===undefined?id:text(body.previewWorkspaceId,36));}}
  if(operation==='design.apply'||operation==='design.restore')return mutateProductionDesign(ctx,{...object(body.input),action:operation==='design.apply'?'apply':'restore'});
  if(operation==='production.read')return readProductionBridge(ctx,body.input??{});
  if(operation==='production.mutate')return mutateProduction(ctx,body.input);
  if(operation==='list')return {rows:app.rows,retiredRows:app.retiredRows??[],revision:app.revision};
  requireProduct(['create','update','delete','restore'].includes(operation),'Operació no permesa.',403);const input=object(body.input);
  await mutateApp(ctx,{...input,id,action:`row.${operation}`,published:true});const saved=await readApp(ctx,id,true);return {rows:saved.rows,retiredRows:saved.retiredRows??[],revision:saved.revision};
}
