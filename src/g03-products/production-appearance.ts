import type { CSSProperties } from 'react';
import type { Order } from './contracts';

export const defaultDeliveryColors = {overdue:'#FF0000',week:'#FFFF00',currentMonth:'#FCE5CD',futureMonth:'#D9EAD3'};
export const defaultProductionStatusColors: Record<string,string> = {'NO COMENÇAT':'#000000','EXTERN':'#D9D2E9','EN PRODUCCIÓ':'#FFFF00'};
type AppearanceConfiguration = {cellColors?:Record<string,Record<string,string>>;deliveryColors?:Partial<typeof defaultDeliveryColors>};
export function deliveryPeriod(value:string,today:string):keyof typeof defaultDeliveryColors {
  if(value<today)return 'overdue';
  const days=(Date.parse(`${value}T12:00:00Z`)-Date.parse(`${today}T12:00:00Z`))/86400000;
  if(days<=7)return 'week';
  return value.slice(0,7)===today.slice(0,7)?'currentMonth':'futureMonth';
}
export function productionCellAppearance(order:Order,key:keyof Order,today:string,configuration?:AppearanceConfiguration):CSSProperties|undefined {
  const value=String(order[key]??'');
  const overrides=configuration?.cellColors?.[key];
  let backgroundColor=overrides?.[value];
  // Older configuration forms accepted stray spaces/case in dropdown values.
  // An exact saved setting always wins; only unambiguous legacy colors fall back.
  if(!backgroundColor&&overrides&&['materialStatus','productionStatus','assignedMachine'].includes(key)){
    const normalized=value.trim().toLocaleLowerCase('ca');
    const matches=[...new Set(Object.entries(overrides).filter(([stored])=>stored.trim().toLocaleLowerCase('ca')===normalized).map(([,color])=>color))];
    if(matches.length===1)backgroundColor=matches[0];
  }
  if(!backgroundColor&&key==='productionStatus'&&Object.hasOwn(defaultProductionStatusColors,value))backgroundColor=defaultProductionStatusColors[value];
  if(!backgroundColor&&key==='deliveryDate'&&value)backgroundColor={...defaultDeliveryColors,...configuration?.deliveryColors}[deliveryPeriod(value,today)];
  // Material has the three requested horizons; delivery retains its month band.
  if(!backgroundColor&&key==='materialEta'&&value){const period=deliveryPeriod(value,today);backgroundColor={...defaultDeliveryColors,...configuration?.deliveryColors}[period==='currentMonth'?'futureMonth':period];}
  if(!backgroundColor)return undefined;
  const channels=[1,3,5].map(offset=>parseInt(backgroundColor.slice(offset,offset+2),16));
  const light=channels[0]*.299+channels[1]*.587+channels[2]*.114>150;
  return {backgroundColor,color:light?'#18232D':'#FFFFFF'};
}
