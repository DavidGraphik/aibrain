import { grant, type ProductContext } from './access';
import { object,requireProduct,text,number } from './contracts';
import { readApp } from './apps';
import { PRODUCTION_TABS,defaultProductionTabs,type ProductionTab,type ProductionDesign } from './production-design-contract';
import { validateProductionRules } from './production-rules';
const initial=():ProductionDesign=>({revision:0,versions:[],audit:[]});
export async function readProductionDesign(ctx:ProductContext){
  grant(ctx,'read');const value=await ctx.store.read<ProductionDesign>('production-design')??initial();
  const current=value.versions.at(-1),tabs=current?.tabs??defaultProductionTabs();
  const programs=await Promise.all([...new Set(tabs.flatMap(t=>t.appId?[t.appId]:[]))].map(async id=>{try{return [id,(await readApp(ctx,id,true)).version.version]as const;}catch{return [id,null]as const;}}));
  return {revision:value.revision,programVersions:Object.fromEntries(programs),version:current?.version??0,tabs,rules:current?.rules??[],canEdit:ctx.appDesigner===true&&ctx.grants.includes('apps'),...ctx.appDesigner?{versions:value.versions,audit:value.audit}:{}};
}
export async function mutateProductionDesign(ctx:ProductContext,raw:unknown){
  requireProduct(ctx.appDesigner===true,'No tens permís per modificar el disseny de Producció.',403);grant(ctx,'apps');grant(ctx,'read');
  const input=object(raw),action=text(input.action,30),revision=number(input.revision),instruction=text(input.instruction,2000);requireProduct(Number.isSafeInteger(revision),'Revisió invàlida.');
  requireProduct(['apply','restore'].includes(action),'Acció de disseny desconeguda.');
  const current=await ctx.store.read<ProductionDesign>('production-design')??initial();
  const chosen=action==='restore'?current.versions.find(v=>v.version===input.version):undefined;
  requireProduct(action!=='restore'||chosen,'Versió de disseny desconeguda.',404);
  const rules=validateProductionRules(chosen?.rules??input.rules??current.versions.at(-1)?.rules??[]);
  const rawTabs=chosen?.tabs??input.tabs;requireProduct(Array.isArray(rawTabs)&&rawTabs.length>0&&rawTabs.length<=50,'Pestanyes invàlides.');
  const tabs:ProductionTab[]=rawTabs.map(value=>{
    const tab=object(value),key=text(tab.key,80),label=text(tab.label,120);requireProduct(/^[a-zA-Z0-9_-]+$/.test(key),'Clau de pestanya invàlida.');
    requireProduct(Object.keys(tab).every(k=>['key','label','builtin','appId','hidden'].includes(k)),'Camp de disseny desconegut.');
    requireProduct(tab.builtin===undefined||PRODUCTION_TABS.includes(tab.builtin as never),'Vista original desconeguda.');
    requireProduct(tab.appId===undefined||typeof tab.appId==='string'&&/^[a-f0-9-]{36}$/.test(tab.appId),'Aplicació invàlida.');
    requireProduct(tab.builtin!==undefined||tab.appId!==undefined,'Indica la vista o el programa.');requireProduct(tab.hidden===undefined||typeof tab.hidden==='boolean','Visibilitat invàlida.');
    return {key,label,...tab.builtin!==undefined?{builtin:tab.builtin as string}:{},...tab.appId!==undefined?{appId:tab.appId as string}:{},...tab.hidden!==undefined?{hidden:tab.hidden as boolean}:{}};
  });
  requireProduct(new Set(tabs.map(t=>t.key)).size===tabs.length&&tabs.some(t=>!t.hidden),'Cal una pestanya visible i claus úniques.');
  // Binding a program is an actual publication read, never a guessed URL.
  for(const tab of tabs)if(tab.appId){const app=await readApp(ctx,tab.appId,true);requireProduct(app.shared,'Les pestanyes de Producció necessiten una aplicació compartida.');}
  return ctx.store.mutate<ProductionDesign,unknown>('production-design',initial,state=>{
    requireProduct(state.versions.length<500,'Límit de versions de disseny assolit.',409);const version=state.versions.length+1,at=new Date().toISOString();
    state.versions.push({version,at,actor:ctx.actor,instruction,tabs,rules});state.audit.push({at,actor:ctx.actor,action,version,reason:instruction});
    return {revision:state.revision+1,version,tabs,rules,url:'/g03/production'};
  },revision);
}
