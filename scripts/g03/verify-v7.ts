/** Offline evidence against cached workbook cells. Never writes the source/store. */
import {readFile,writeFile} from 'node:fs/promises';
import {validateDataset} from '../../src/g03-products/contracts';
import {recalculateV7,v7MachineQueue} from '../../src/g03-products/v7-logic';
async function main(){
 const [datasetFile,auditRoot,output]=process.argv.slice(2);if(!datasetFile||!auditRoot||!output)throw Error('dataset audit-directory output required');
 const data=validateDataset(JSON.parse(await readFile(datasetFile,'utf8')));
 const differences:unknown[]=[];let checked=0;
 for(const order of data.orders){const actual=recalculateV7(order);for(const field of order.formulaFields ?? []){checked++;if((actual[field]??'')!==(order[field]??''))differences.push({rowNumber:order.rowNumber,field,expected:order[field],actual:actual[field]});}}
 const helper=JSON.parse(await readFile(`${auditRoot}/sheet-08.json`,'utf8')).cells as {cell:string;value:unknown}[];
 const cell=new Map(helper.map(c=>[c.cell,c.value]));const expected=new Map<string,{priority:number;label:string}[]>();
 for(let row=2;cell.has(`A${row}`);row++){const machine=String(cell.get(`A${row}`));const rows=expected.get(machine)??[];rows.push({priority:Number(cell.get(`B${row}`)),label:String(cell.get(`C${row}`))});expected.set(machine,rows);}
 const queues=data.lookups.machines.map(machine=>{const reference=(expected.get(machine)??[]).sort((a,b)=>a.priority-b.priority);const actual=v7MachineQueue(data,machine);const equal=JSON.stringify(actual.map(r=>r.label))===JSON.stringify(reference.map(r=>r.label));if(!equal)differences.push({machine,reference,actual:actual.map(r=>({priority:r.sortKey,label:r.label}))});return{machine,expected:reference.length,actual:actual.length,equal};});
 const result={sourceHash:data.sourceHash,orders:data.orders.length,formulaChecks:checked,queues,manualOverridesPreserved:data.orders.filter(o=>(o.formulaFields??[]).length<6).map(o=>({row:o.rowNumber,unitsPending:o.unitsPending,materialMissing:o.materialMissing})),differences,fullParity:false,sourceScope:'Provided exported snapshot; this offline check does not poll the owning sheet',unverified:['End-to-end trigger and maintenance button actions','Delivered-history mixed schema','All-sheet editable UI','Excel recalculation of Google-specific formulas']};
 await writeFile(output,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({orders:result.orders,formulaChecks:checked,queues:queues.length,matchingQueues:queues.filter(q=>q.equal).length,differences:differences.length}));if(differences.length)process.exitCode=1;
}void main();
