import { number, object, requireProduct, text, type ProductionState, type ProductionTask } from './contracts';

function taskPatch(raw: unknown): Partial<Omit<ProductionTask, 'rowNumber'>> {
  const patch=object(raw), result:Partial<Omit<ProductionTask,'rowNumber'>>={};
  requireProduct(Object.keys(patch).length>0 && Object.keys(patch).every(key=>['owner','description','done'].includes(key)), 'Canvi de tasca invàlid.');
  if(Object.hasOwn(patch,'owner'))result.owner=text(patch.owner,500,true);
  if(Object.hasOwn(patch,'description'))result.description=text(patch.description,4000);
  if(Object.hasOwn(patch,'done')){requireProduct(typeof patch.done==='boolean','Estat invàlid.');result.done=patch.done;}
  return result;
}
const identity=(task:Pick<ProductionTask,'owner'|'description'>)=>JSON.stringify([task.owner.trim().toLocaleLowerCase('ca'),task.description.trim().toLocaleLowerCase('ca')]);
function uniqueTask(tasks:ProductionTask[], candidate:ProductionTask) {
  requireProduct(!tasks.some(task=>task.rowNumber!==candidate.rowNumber && identity(task)===identity(candidate)), 'Ja existeix una tasca amb aquest responsable i descripció. No s’ha duplicat.',409);
}

/** The caller holds the production lock, checks the actor grant and exact revision. */
export function changeProductionTask(state:ProductionState, action:string, input:Record<string,unknown>) {
  const tasks=state.tasks??=[];
  if(action==='task.create') {
    const patch=taskPatch(input.patch);
    requireProduct(typeof patch.owner==='string' && typeof patch.description==='string','Indica responsable i descripció.');
    const last=state.audit.reduce((max,entry)=>{const row=Number(entry.target);return entry.action.startsWith('task.')&&Number.isSafeInteger(row)?Math.max(max,row):max;},tasks.reduce((max,task)=>Math.max(max,task.rowNumber),0));
    requireProduct(Number.isSafeInteger(last+1),'Identificador de tasca exhaurit.',409);
    const task:ProductionTask={rowNumber:last+1,owner:patch.owner,description:patch.description,done:patch.done??false};
    uniqueTask(tasks,task);tasks.push(task);return {before:null,after:task,result:task,target:String(task.rowNumber)};
  }
  const rowNumber=number(input.rowNumber,1);requireProduct(Number.isSafeInteger(rowNumber),'Fila de tasca invàlida.');
  const index=tasks.findIndex(task=>task.rowNumber===rowNumber);
  if(action==='task.restore') {
    const last=[...state.audit].reverse().find(entry=>entry.action.startsWith('task.')&&entry.target===String(rowNumber));
    requireProduct(last?.action==='task.delete' && last.before,'Tasca retirada no trobada.',404);
    requireProduct(index===-1,'La tasca ja existeix. No s’ha sobreescrit.',409);
    const saved=object(last.before);requireProduct(saved.rowNumber===rowNumber,'Històric de tasca invàlid.',409);
    const patch=taskPatch({owner:saved.owner,description:saved.description,done:saved.done});
    const task={rowNumber,...patch} as ProductionTask;
    uniqueTask(tasks,task);tasks.push(task);tasks.sort((a,b)=>a.rowNumber-b.rowNumber);
    return {before:null,after:task,result:task,target:String(rowNumber)};
  }
  requireProduct(index!==-1,'Tasca no trobada.',404);
  const before={...tasks[index]};
  if(action==='task.delete') {
    tasks.splice(index,1);return {before,after:null,result:{rowNumber,deleted:true,recoverable:true},target:String(rowNumber)};
  }
  requireProduct(action==='task.update','Acció de tasca desconeguda.');
  // Keep the deployed checkbox contract, while richer clients use a bounded patch.
  requireProduct(!(Object.hasOwn(input,'patch')&&Object.hasOwn(input,'done')),'Indica patch o done, no tots dos.');
  const patch=taskPatch(Object.hasOwn(input,'patch')?input.patch:{done:input.done});
  const task={...before,...patch};if(identity(task)!==identity(before))uniqueTask(tasks,task);tasks[index]=task;
  return {before,after:task,result:task,target:String(rowNumber)};
}
