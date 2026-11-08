import { object,requireProduct,text,orderTexts,orderDates,orderNumbers,type Order } from './contracts';
import type { ProductionRule } from './production-design-contract';
const operations=new Set(['+','-','*','/','min','max','round','concat','==','!=','>','>=','<','<=','and','or','not','if','coalesce']);
const fields=new Set<string>([...orderTexts,...orderDates,...orderNumbers].filter(k=>!['unitsAtG03','materialMissing','unitsReceivedTotal'].includes(k)));
/** Small bounded expression language; no eval, imports, prototype access or I/O. */
function check(value:unknown,depth=0,budget={nodes:0}):void{
  requireProduct(depth<=12&&++budget.nodes<=500,'Expressió massa complexa.');
  if(value===null||['string','number','boolean'].includes(typeof value)){requireProduct(typeof value!=='number'||Number.isFinite(value),'Nombre invàlid.');requireProduct(typeof value!=='string'||value.length<=2000,'Text massa llarg.');return;}
  const expr=object(value);
  if(Object.hasOwn(expr,'field')){requireProduct(Object.keys(expr).length===1&&typeof expr.field==='string'&&/^(before|next|patch)\.[a-zA-Z][a-zA-Z0-9]*$/.test(expr.field),'Camp d’expressió invàlid.');return;}
  requireProduct(Object.keys(expr).every(k=>['op','args'].includes(k))&&typeof expr.op==='string'&&operations.has(expr.op)&&Array.isArray(expr.args)&&expr.args.length<=20,'Operador invàlid.');
  for(const child of expr.args)check(child,depth+1,budget);
}
export function validateProductionRules(raw:unknown):ProductionRule[]{
  requireProduct(Array.isArray(raw)&&raw.length<=30,'Regles invàlides.');
  const rules=raw.map(value=>{const r=object(value);requireProduct(Object.keys(r).every(k=>['id','when','set'].includes(k)),'Camp de regla desconegut.');const id=text(r.id,80),set=object(r.set);requireProduct(Object.keys(set).length>0&&Object.keys(set).length<=20&&Object.keys(set).every(k=>fields.has(k)),'Camp de regla no editable.');if(r.when!==undefined)check(r.when);for(const expression of Object.values(set))check(expression);return {id,...r.when!==undefined?{when:r.when}:{},set};});
  requireProduct(new Set(rules.map(r=>r.id)).size===rules.length,'Regles duplicades.');return rules;
}
function evaluate(value:unknown,scope:Record<string,unknown>):unknown{
  if(value===null||typeof value!=='object')return value;
  const expr=value as {field?:string;op?:string;args?:unknown[]};
  if(expr.field){const [root,key]=expr.field.split('.');const source=scope[root];return source&&typeof source==='object'&&Object.hasOwn(source,key)?(source as Record<string,unknown>)[key]:null;}
  const children=expr.args??[];
  if(expr.op==='if')return evaluate(children[evaluate(children[0],scope)?1:2]??null,scope);
  if(expr.op==='coalesce'){for(const child of children){const v=evaluate(child,scope);if(v!==null&&v!==undefined)return v;}return null;}
  const args=children.map(v=>evaluate(v,scope));
  if(expr.op==='concat')return args.map(v=>String(v??'')).join('').slice(0,2000);
  if(expr.op==='and')return args.every(Boolean);if(expr.op==='or')return args.some(Boolean);if(expr.op==='not')return !args[0];
  if(expr.op==='==')return args[0]===args[1];if(expr.op==='!=')return args[0]!==args[1];
  if(['>','>=','<','<='].includes(expr.op??'')){requireProduct(typeof args[0]==='number'&&typeof args[1]==='number','Comparació numèrica invàlida.');return expr.op==='>'?args[0]>args[1]:expr.op==='>='?args[0]>=args[1]:expr.op==='<'?args[0]<args[1]:args[0]<=args[1];}
  requireProduct(args.length>0&&args.every(v=>typeof v==='number'&&Number.isFinite(v)),'Càlcul numèric invàlid.');const n=args as number[];
  const result=expr.op==='+'?n.reduce((a,b)=>a+b,0):expr.op==='-'?n.slice(1).reduce((a,b)=>a-b,n[0]):expr.op==='*'?n.reduce((a,b)=>a*b,1):expr.op==='/'?n.slice(1).reduce((a,b)=>a/b,n[0]):expr.op==='min'?Math.min(...n):expr.op==='max'?Math.max(...n):Math.round(n[0]);
  requireProduct(Number.isFinite(result),'Resultat de càlcul invàlid.');return result;
}
export function applyProductionRules(rules:ProductionRule[],before:Partial<Order>,patch:Record<string,unknown>){
  const next={...before,...patch},result={...patch},applied:string[]=[];
  for(const rule of rules){const scope={before,next,patch};if(rule.when!==undefined&&!evaluate(rule.when,scope))continue;const updates=Object.fromEntries(Object.entries(rule.set).map(([key,value])=>[key,evaluate(value,scope)]));Object.assign(next,updates);Object.assign(result,updates);applied.push(rule.id);}
  return {patch:result,applied};
}
