export const PRODUCTION_TABS = ['Introducció comandes','Producció','Càrrega maquinària','Fases OF','Referències','Entregats','Tasques','Recepcions','Historial','Fulls originals','Configuració','Importació'] as const;
export type ProductionTab = { key:string; label:string; builtin?:string; appId?:string; hidden?:boolean };
export type ProductionRule = {id:string;when?:unknown;set:Record<string,unknown>};
export type ProductionDesign = { revision:number; versions:{version:number;at:string;actor:string;instruction:string;tabs:ProductionTab[];rules?:ProductionRule[]}[]; audit:{at:string;actor:string;action:string;version:number;reason:string}[] };
export const defaultProductionTabs=():ProductionTab[]=>PRODUCTION_TABS.map((label,index)=>({key:`builtin-${index}`,label,builtin:label}));
